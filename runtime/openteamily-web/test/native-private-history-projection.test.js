import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {DatabaseSync} from 'node:sqlite'
import test from 'node:test'
import {createAgents} from '../features/agents/index.js'

const workspace = 'a'.repeat(32), foreignWorkspace = 'b'.repeat(32)
const agentId = '1'.repeat(32), foreignAgent = '2'.repeat(32)
const conversationId = '3'.repeat(32), foreignConversation = '4'.repeat(32)
const args = {workspace_id:workspace,id:agentId,conversation_id:conversationId}
const tick = () => new Promise(resolve => setImmediate(resolve))

const input = (text, source = {kind:'user',rpcId:'native-request'}) => ({type:'user/message',surfaceOp:'append',data:{source,
  content:typeof text === 'string' ? [{type:'text',text}] : text}})
const output = text => ({type:'assistant/message',surfaceOp:'append',data:{message:{source:{kind:'model'},content:
  typeof text === 'string' ? [{type:'text',text}] : text}}})

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const bus = new EventEmitter()
  const bots = {local:{id:'local',sessionId:'part-1',openteamily:{agent_id:agentId,workspace_id:workspace}},
    other:{id:'other',sessionId:'outside',openteamily:{agent_id:foreignAgent,workspace_id:foreignWorkspace}},
    nativeOnly:{id:'nativeOnly',sessionId:'unmapped'}}
  const rt = {chatOwners:new Map([['part-1','local'],['outside','other'],['unmapped','nativeOnly']]), pastOwners:new Map(),botOf:id=>bots[id]}
  let flushes = 0, blocked = null
  const ctx = {on:bus.on.bind(bus),sessions:{async flush() {flushes++; if (blocked) await blocked}}}
  const service = {rt,ctx,nativeTurn:() => assert.fail('committed native events must never rerun a model')}
  const host = {currentRuntime:() => service,runtime:async () => service,call:async () => null}
  const {endpoints,attachHistory} = createAgents({db,host})
  async function seed() {
    await endpoints.import({agents:[{id:agentId,workspace_id:workspace,name:'Linked Bot'},
      {id:foreignAgent,workspace_id:foreignWorkspace,name:'Other linked Bot'}]})
    const mapObject = db.prepare('INSERT INTO native_agent_objects VALUES(?,?,?)')
    const mapSession = db.prepare('INSERT INTO native_agent_sessions VALUES(?,?,?)')
    const put = db.prepare('INSERT INTO agent_conversations(id,agent_id,title,created,updated) VALUES(?,?,?,?,?)')
    for (const [cid,agent,bot,sid] of [[conversationId,agentId,'local','part-1'],[foreignConversation,foreignAgent,'other','outside']]) {
      put.run(cid,agent,'Saved conversation',1,1)
      mapObject.run(agent,bot,bots[bot].openteamily.agent_id === agentId ? 'Linked Bot' : 'Other linked Bot')
      mapSession.run(`agent:${agent}:${cid}`,agent,sid)
    }
    attachHistory(service)
  }
  function session(id) {
    const events = []
    const native = {id,eventAt:seq=>events[seq]}
    return {turn(content, {end = {},time = 1_800_000_000_000} = {}) {
      const turn = events.length + 1
      const frames = [{type:'turn/start',data:{}},...content,{type:'turn/end',data:{reason:{kind:'completed'},...end}}]
      let last
      for (const frame of frames) {
        last = {...frame,data:{turn,...frame.data},seq:events.length,time:time+events.length}
        events.push(last)
        bus.emit('session/event',native,last)
      }
      return () => bus.emit('session/event',native,last)
    }}
  }
  return {db,rt,bots,endpoints,seed,session,flushes:() => flushes,block:promise=>{blocked=promise}}
}

test('a committed native conversation appears in the exact existing Web history and deduplicates a replay', async t => {
  const f = fixture(t)
  await f.seed()
  const flush = Promise.withResolvers()
  f.block(flush.promise)
  const replay = f.session('part-1').turn([input('Plain native browser user text'),output('Intermediate assistant text'),
    {type:'tool/result',data:{result:'not written to the transcript'}},
    input('Private injected workspace instructions',{kind:'agent-instructions',form:'instructions'}),
    output([{type:'reasoning',text:'private reasoning'},{type:'text',text:'Native final text'}])])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,0)
  const loaded = f.endpoints.openConversation(args)
  flush.resolve()
  const opened = await loaded
  assert.deepEqual(opened.items.map(({role,text,status})=>[role,text,status]),[
    ['user','Plain native browser user text','sent'],['assistant','Native final text','succeeded'],
  ])
  assert.equal(opened.conversation.native_session_id,'part-1')
  assert.equal(opened.conversation.updated,1_800_000_000)
  const ids = opened.items.map(item=>item.id)
  const api = await f.endpoints.v1({method:'GET',path:`/v1/workspaces/${workspace}/agents/${agentId}/conversations/${conversationId}`})
  assert.deepEqual(api.body.items.map(({id,body})=>[id,body]),[[ids[0],'Plain native browser user text'],[ids[1],'Native final text']])
  assert.equal((await f.endpoints.v1({method:'GET',path:`/v1/workspaces/${foreignWorkspace}/agents/${agentId}/conversations/${conversationId}`})).status,404)
  assert.deepEqual(f.db.prepare('SELECT session_id,event_seq,source FROM native_agent_events ORDER BY event_seq').all()
    .map(row=>[row.session_id,row.event_seq,row.source]),[['part-1',1,'native'],['part-1',5,'native']])
  replay()
  assert.deepEqual((await f.endpoints.openConversation(args)).items.map(item=>item.id),ids)
  assert.equal(f.flushes(),2)
})

test('the native projection excludes Web sends, history import, tools, unrelated Sessions and retired access', async t => {
  const f = fixture(t)
  await f.seed()
  const session = f.session('part-1')
  session.turn([input('Wrapped Web input',{kind:'user',rpcId:'ot-agent:existing-web'}),output('Already displayed by Web')])
  session.turn([input('Imported old message',{kind:'user',imported:true}),output('Already stored history')])
  session.turn([input('Internal release automation',{kind:'schedule'}),output('From an automation')])
  session.turn([input('Internal handoff text',{kind:'user',handoff:true}),output('Handoff thought')])
  session.turn([input([{type:'text',text:'Native image caption'},{type:'file'}]),output('Attachment result')])
  f.session('unmapped').turn([input('Unrelated native-only prompt'),output('Unrelated response')])
  f.bots.other.openteamily.workspace_id = workspace
  f.session('outside').turn([input('Stale wrong workspace'),output('Foreign response')])
  f.bots.other.openteamily.workspace_id = foreignWorkspace
  await tick()
  assert.equal(f.flushes(),0)

  session.turn([input('Tool request without completed answer',{kind:'user',rpcId:'native-tool-only'}),
    output([{type:'text',text:'A narrated tool step'},{type:'tool-call',name:'internal'}])])
  session.turn([input('Interrupted native input',{kind:'user',rpcId:'native-aborted'}),output('Aborted reply')],{end:{reason:{kind:'aborted'}}})
  session.turn([input('Native user alongside Web prompt',{kind:'user',rpcId:'native-mixed'}),
    input('Existing Web prompt',{kind:'user',rpcId:'ot-agent:already-known'}),output('Shared mixed answer')])
  const history = await f.endpoints.openConversation(args)
  assert.deepEqual(history.items.map(({role,text})=>[role,text]),[
    ['user','Tool request without completed answer'],['user','Interrupted native input'],['user','Native user alongside Web prompt'],
  ])
  const locked = Promise.withResolvers()
  f.block(locked.promise)
  session.turn([input('Queued before archive',{kind:'user',rpcId:'native-before-archive'}),output('Archive race result')])
  await f.endpoints.organizeConversation({...args,action:'archive'})
  locked.resolve()
  assert.equal((await f.endpoints.openConversation(args)).items.length,3)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id=?').get(foreignConversation).n,0)
})

test('an owned moved part continues the same Web conversation and replays the exact request only once', async t => {
  const f = fixture(t)
  await f.seed()
  const first = f.session('part-1')
  const flushed = Promise.withResolvers()
  f.block(flushed.promise)
  first.turn([input('Before native part rollover'),output('Final before rollover')])
  f.bots.local.segments = [{sessionId:'part-1'}]
  f.bots.local.sessionId = 'part-2'
  f.rt.chatOwners.delete('part-1')
  f.rt.pastOwners.set('part-1',{botId:'local'})
  f.rt.chatOwners.set('part-2','local')
  flushed.resolve()
  const second = f.session('part-2')
  second.turn([input('Before native part rollover'),output('Duplicate rerun must not create history')])
  second.turn([input('Native continuation',{kind:'user',rpcId:'next-native-request'}),output('New continuation answer')])
  const {items,conversation} = await f.endpoints.openConversation(args)
  assert.equal(conversation.id,conversationId)
  assert.deepEqual(items.map(item=>item.text),['Before native part rollover','Final before rollover','Native continuation','New continuation answer'])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_conversations WHERE agent_id=?').get(agentId).n,1)
})
