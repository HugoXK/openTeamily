import { createHash } from 'node:crypto'
import { currentSession, threadOf, threadOfPart } from '../../../ds-bot-upstream/ds-bot/src/host/threads.js'
import { NATIVE_EVENT_LEDGER } from './history.js'

const MAX_TURN_EVENTS = 2048
const MAX_TEXT = 20_000
const ID = /^[0-9a-f]{32}$/

function textOf(content, allowReasoning = false) {
  if (!Array.isArray(content) || !content.length || content.some(block =>
      !(block?.type === 'text' && typeof block.text === 'string') && !(allowReasoning && block?.type === 'reasoning'))) return null
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  return text.trim() && text.length <= MAX_TEXT && !text.includes('\0') && text.isWellFormed() ? text : null
}

function nativeInput(event) {
  const source = event.data?.source
  if (event.surfaceOp !== 'append' || source?.kind !== 'user' || source.imported || source.openteamilyMessageId ||
      source.handoff || source.resume || source.imOrigin ||
      (typeof source.rpcId === 'string' && /^(?:ot-|otp:|ots:|im:)/.test(source.rpcId))) return null
  const text = textOf(event.data?.content)
  return text ? {text,request:typeof source.rpcId === 'string' && source.rpcId.length <= 128 ? source.rpcId : undefined} : null
}

function turnRows(session, end) {
  const turn = end.data?.turn
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(end.seq)) return []
  const users = []
  let answer, seenAnswer = false, otherInput = false
  const rowOf = (event, role, text) => ({event_seq:event.seq,role,text,created:Math.floor(event.time / 1000)})
  const canAnswer = end.data?.reason?.kind === 'completed'
  for (let seq = end.seq - 1; seq >= Math.max(session.firstLiveSeq ?? 0,end.seq - MAX_TURN_EVENTS); seq--) {
    const event = session.eventAt(seq)
    if (!event) return []
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (event.type !== 'turn/start' || event.data?.turn !== turn || !users.length) return []
      const rows = users.reverse()
      if (!otherInput && answer && answer.event_seq > rows.at(-1).event_seq) {
        const request = rows.length === 1 ? rows[0].request : undefined
        rows.push({...answer,request})
      }
      return rows
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== seq || !Number.isFinite(event.time) || event.time <= 0) continue
    if (event.type === 'user/message') {
      const input = nativeInput(event)
      if (input) users.push({...rowOf(event,'user',input.text),request:input.request})
      else {
        const source = event.data?.source
        if (source?.kind === 'user' || !['instructions','catalog','snapshot','recall'].includes(source?.form)) otherInput = true
      }
    } else if (canAnswer && !seenAnswer && event.type === 'assistant/message' && event.data?.turn === turn) {
      seenAnswer = true
      const message = event.data?.message
      if (event.surfaceOp !== 'append' || event.data?.interrupted || event.data?.source?.imported || message?.source?.kind !== 'model') continue
      const text = textOf(message.content,true)
      if (text) answer = rowOf(event,'assistant',text)
    }
  }
  return []
}

export function nativeHistoryProjection({host,db}) {
  db.exec(NATIVE_EVENT_LEDGER)
  const jobs = new Map()
  const mapping = db.prepare(`SELECT c.id,c.agent_id,a.workspace_id FROM native_agent_sessions s
    JOIN native_agent_objects o ON o.agent_id=s.agent_id JOIN agents a ON a.id=s.agent_id
    JOIN agent_conversations c ON c.agent_id=s.agent_id AND s.conversation_key='agent:'||c.agent_id||':'||c.id
    WHERE s.session_id=? AND o.bot_id=? AND a.archived=0 AND c.archived_at IS NULL`)
  const existing = db.prepare('SELECT 1 FROM native_agent_events WHERE session_id=? AND event_seq=?')
  const insert = db.prepare('INSERT OR IGNORE INTO agent_messages(id,conversation_id,role,text,status,created,meta) VALUES(?,?,?,?,?,?,?)')
  const record = db.prepare('INSERT INTO native_agent_events(message_id,session_id,event_seq,source) VALUES(?,?,?,?)')
  const touch = db.prepare('UPDATE agent_conversations SET updated=MAX(updated,?) WHERE id=?')

  function ownedConversation(rt, sessionId, allowPast = false) {
    const old = rt.pastOwners?.get(sessionId)
    if (old && (!allowPast || old.roomId !== undefined)) return null
    const botId = old?.botId ?? rt.chatOwners?.get(sessionId)
    if (typeof botId !== 'string') return null
    const bot = rt.botOf(botId)
    const identity = bot?.openteamily
    if (bot?.hidden || !ID.test(identity?.agent_id || '') || !ID.test(identity?.workspace_id || '')) return null
    const thread = old ? threadOfPart(bot,sessionId) : threadOf(bot,sessionId)
    if (!thread) return null
    const liveId = thread.thread === 'current' ? currentSession(bot) : bot.openParts[thread.index].sessionId
    let found
    for (const id of [liveId,...thread.segments.map(part => part.sessionId)]) {
      const row = mapping.get(id,botId)
      if (!row) continue
      if (row.agent_id !== identity.agent_id || row.workspace_id !== identity.workspace_id || (found && row.id !== found.id)) return null
      found = row
    }
    return found
  }

  function save(rt, sessionId, conversationId, rows) {
    if (ownedConversation(rt,sessionId,true)?.id !== conversationId) return
    db.exec('BEGIN IMMEDIATE')
    try {
      let updated = 0
      for (const {event_seq,role,text,created,request} of rows) {
        if (existing.get(sessionId,event_seq)) continue
        const receipt = request ? ['request',request] : ['event',sessionId,event_seq]
        const id = createHash('sha256').update(JSON.stringify([conversationId,role,receipt])).digest('hex').slice(0,32)
        const meta = JSON.stringify({engine:'ds-bot',session_id:sessionId})
        if (!insert.run(id,conversationId,role,text,role === 'user' ? 'sent' : 'succeeded',created,meta).changes) continue
        record.run(id,sessionId,event_seq,'native')
        updated = Math.max(updated,created)
      }
      if (updated) touch.run(updated,conversationId)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  function attach({rt,ctx} = {}) {
    if (typeof ctx?.on !== 'function' || typeof ctx.sessions?.flush !== 'function' || typeof rt?.botOf !== 'function') return
    ctx.on('session/event',(session,event) => {
      if (event?.type !== 'turn/end' || typeof session?.eventAt !== 'function') return
      try {
        const conversation = ownedConversation(rt,session.id)
        if (!conversation) return
        const rows = turnRows(session,event)
        if (!rows.length) return
        const previous = jobs.get(conversation.id)
        const job = Promise.resolve(previous).then(async () => {
          await ctx.sessions.flush(session)
          save(rt,session.id,conversation.id,rows)
        }).catch(() => host.log?.('Native private chat history projection could not be saved.'))
        jobs.set(conversation.id,job)
        void job.then(() => { if (jobs.get(conversation.id) === job) jobs.delete(conversation.id) })
      } catch { host.log?.('Native private chat history could not be projected.') }
    })
  }

  return {attach,pending: id => jobs.get(id)}
}
