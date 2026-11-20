// Adopt native Main-Bot agent threads, then import missing legacy messages as
// actual Session events. No model call, no replay or outgoing message.
import { currentSession, threadOfPart, startOpenPart } from '../../../ds-bot-upstream/ds-bot/src/host/threads.js'

export async function adoptThread({ rt, source, target, sessionId }) {
  if (!sessionId || source.id === target.id) return sessionId
  const existing = threadOfPart(target, sessionId)
  if (existing) return existing.thread === 'current' ? currentSession(target) : target.openParts[existing.index].sessionId
  const thread = threadOfPart(source, sessionId)
  if (!thread) throw Object.assign(new Error('Legacy agent Session has no native owner thread'), { code: 'agents/legacy-session-unowned', status: 409 })
  const part = thread.thread === 'current' ? { sessionId: currentSession(source), segments: source.segments || [] } : source.openParts[thread.index]
  const ids = [part.sessionId, ...(part.segments || []).map(s => s.sessionId)]
  if (ids.some(id => rt.live.get(id)?.turn !== undefined)) throw Object.assign(new Error('Agent history is busy; retry migration'), { code:'agents/history-busy', status:409 })
  if (thread.thread === 'current') {
    const replacement = await rt.createSession(source.name, { dir: rt.workDirOf({ botId: source.id }) })
    source.sessionId = replacement; source.segments = []; rt.chatOwners.set(replacement, source.id)
  } else source.openParts.splice(thread.index, 1)
  target.openParts ??= []
  target.openParts.push(part)
  for (const id of ids) rt.chatOwners.set(id, target.id)
  return part.sessionId
}

export async function importHistory({ db, rt, ctx, bot, conversationId, sessionId, secondarySessionId }) {
  db.exec('CREATE TABLE IF NOT EXISTS native_agent_events(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,event_seq INTEGER,source TEXT NOT NULL)')
  const rows = db.prepare('SELECT * FROM agent_messages WHERE conversation_id=? ORDER BY created,id').all(conversationId)
  if (!rows.length) return { imported:0, matched:0 }
  const scan = new Set()
  for (const sid of [sessionId, secondarySessionId].filter(Boolean)) {
    const thread = threadOfPart(bot, sid)
    for (const part of thread?.segments || []) scan.add(part.sessionId)
    scan.add(sid)
  }
  const events = []
  for (const id of scan) {
    const agent = await rt.resolveAgent(id); await ctx.sessions.flush(agent.session)
    for await (const event of rt.eventsBackwards(id, AbortSignal.timeout(15000), Infinity)) {
      if (!['user/message','assistant/message','openteamily/message-status'].includes(event.type)) continue
      const role = event.type === 'openteamily/message-status' ? event.data.role : event.type === 'user/message' ? 'user' : 'assistant'
      const content = role === 'user' ? event.data.content : event.data.message?.content
      let text = (Array.isArray(content) ? content : []).filter(c=>c.type==='text').map(c=>c.text).join('\n')
      // Former persona-based Main Bot agent turns wrapped the user's text.
      if (role === 'user' && text.includes('\n\nUser: ')) text = text.slice(text.lastIndexOf('\n\nUser: ')+8)
      events.push({ role,text,id,seq:event.seq,time:event.time,tag:event.data.source?.openteamilyMessageId,rpc:event.data.source?.rpcId })
    }
  }
  events.sort((a,b)=>a.time-b.time || a.seq-b.seq)
  const used = new Set(events.flatMap((e,i)=>db.prepare('SELECT 1 FROM native_agent_events WHERE session_id=? AND event_seq=?').get(e.id,e.seq) ? [i] : [])), put = db.prepare('INSERT OR IGNORE INTO native_agent_events VALUES(?,?,?,?)')
  const agent = await rt.resolveAgent(sessionId)
  let imported=0,matched=0
  for(const row of rows){
    if(db.prepare('SELECT 1 FROM native_agent_events WHERE message_id=?').get(row.id)) continue
    if(JSON.parse(row.meta || '{}').nativePending) continue
    const known=events.find((e,i)=>!used.has(i) && (e.tag===row.id || e.rpc==='ot-agent:'+row.id || (e.role===row.role && e.text===row.text && row.text)))
    if(known){ used.add(events.indexOf(known));put.run(row.id,known.id,known.seq,'adopted');matched++;continue }
    // Failed/empty messages remain visible diagnostic events, not fabricated replies.
    const source={kind:'user',openteamilyMessageId:row.id,originalTime:row.created*1000,imported:true,status:row.status}
    let event
    if(!row.text || row.status==='failed') event=agent.session.append('openteamily/message-status',{source,role:row.role,text:row.text,status:row.status})
    else if(row.role==='user') event=agent.session.append('user/message',{source,content:[{type:'text',text:row.text}]},{surfaceOp:'append'})
    else event=agent.session.append('assistant/message',{source,stream:[],message:{role:'assistant',content:[{type:'text',text:row.text}]}},{surfaceOp:'append'})
    // Flush BEFORE mapping: a crash between these is recovered by event source id.
    await ctx.sessions.flush(agent.session)
    put.run(row.id,sessionId,event.seq,'imported'); imported++
  }
  return { imported,matched }
}

// Compatibility for the first history-import release: those append-only events
// predate the native required stream field. Normalize ONLY our marked imports
// for native projection reads; preserve the durable log and source mapping.
// Empty stream means no recorded transport/usage, never invented token usage.
export function normalizeImportedSession(session) {
  const prototype = Object.getPrototypeOf(session)
  const mark = Symbol.for('openteamily.imported-event-normalizer')
  if (!prototype || prototype[mark]) return
  const read = prototype.eventAt
  prototype.eventAt = function (seq) {
    const e = read.call(this, seq)
    return e?.type === 'assistant/message' && e.data?.source?.imported === true && /^[0-9a-f]{32}$/.test(e.data.source.openteamilyMessageId || '') && !Array.isArray(e.data.stream)
      ? { ...e, data: { ...e.data, stream: [] } } : e
  }
  prototype[mark] = true
}
