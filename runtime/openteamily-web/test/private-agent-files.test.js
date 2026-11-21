import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createAgents } from '../features/agents/index.js'
import { createLegacyDispatch } from '../src/dispatch.js'

const workspace = 'a'.repeat(32)
const root = `/v1/workspaces/${workspace}/agents`
function legacyRequest(e) {
  const dispatch = createLegacyDispatch({endpoints:{'agents/v1':e.v1}})
  return (path, options, query = '') => {
    const url = new URL('http://dsbot/api/openteamily/legacy')
    url.searchParams.set('feature','agents')
    url.searchParams.set('path',path)
    if (query) url.searchParams.set('query',query)
    return dispatch(new Request(url,options))
  }
}

const createRuntime = () => {
  const bots = {main:{id:'main',name:'Main',capabilities:[]}}
  const events = new Map()
  const stored = new Map()
  let count = 0
  let sessions = 0
  const rt = {
    state:{bots}, botOf:id => bots[id], chatOwners:new Map(), save:async () => {},
    createBot:async ({name,instructions}) => (bots.agent = {id:'agent',name,instructions,capabilities:[]}),
    createSession:async () => ++sessions === 1 ? 'native-session' : 'native-session-' + sessions,
    workDirOf:() => '/fixture',
    resolveAgent:async sid => ({session:{id:sid}}),
    async* eventsBackwards(sid) { yield* events.get(sid) || [] },
  }
  return {
    rt, ctx:{sessions:{flush:async () => {}}},
    mainBot:async () => 'main',
    chatTurn:async () => {},
    readNativeAttachment:async ({ref}) => stored.get(ref.id),
    async nativeTurn(bot,sid,prompt,key,{files,onStaged}) {
      const file = files[0]
      assert.equal(bot,'agent')
      assert.equal(sid,'native-session')
      assert.match(prompt,/only from the file/)
      assert.equal(file.data.toString(),'only from the file')
      count++
      stored.set('file',file.data)
      onStaged([{title:file.title,mime:file.mime,bytes:file.data.length,ref:{id:'file'}}])
      events.set(sid,[
        {type:'user/message',seq:1,time:1000,data:{content:[{type:'text',text:prompt},{type:'file'}],source:{rpcId:key}}},
        {type:'assistant/message',seq:2,time:1001,data:{message:{content:[{type:'text',text:'Read attached file'}]}}},
      ])
      return {text:'Read attached file',sessionId:sid,turnId:1}
    },
    get count() { return count },
  }
}

test('private agent files survive reconnect, with one native turn and workspace-scoped downloads', async () => {
  const db = new DatabaseSync(':memory:')
  const runtime = createRuntime()
  const host = {runtime:async () => runtime, call:async (name) => assert.equal(name,'skills/materialForScope')}
  const {endpoints:e} = createAgents({db,host})
  const {agent} = await e.create({workspace_id:workspace,name:'Reader',idempotency_key:'a'.repeat(20)})
  const {conversation} = await e['conversation-create']({workspace_id:workspace,id:agent.id})
  const convo = `${root}/${agent.id}/conversations/${conversation.id}`
  const request = legacyRequest(e)
  const send = (body = 'Read the attached file') => {
    const form = new FormData()
    form.set('body',body)
    form.append('file',new Blob(['only from the file'],{type:'text/plain'}),'笔记.txt')
    return request(convo+'/messages',{method:'POST',headers:{'Idempotency-Key':'file-send-key-12345'},body:form})
  }
  const [first,retry] = await Promise.all([send(),send()])
  assert.equal(first.status,201)
  assert.equal(retry.status,201)
  const data = await first.json()
  assert.equal(data.reply.body,'Read attached file')
  assert.equal((await retry.json()).message.id,data.message.id)
  assert.equal((await send('Edited after uploading')).status,409)
  assert.equal(runtime.count,1)
  const reopened = await (await request(convo)).json()
  assert.equal(reopened.items.length,2)
  const [attachment] = reopened.items[0].attachments
  assert.equal(attachment.title,'笔记.txt')
  assert.equal(attachment.bytes,18)
  assert.equal(attachment.ref,undefined)
  const file = await request(attachment.path)
  assert.equal(file.status,200)
  assert.match(file.headers.get('content-disposition'),/^attachment;/)
  assert.equal(await file.text(),'only from the file')
  assert.equal((await request(attachment.path.replace(workspace,'b'.repeat(32)))).status,404)

  const {conversation:other} = await e['conversation-create']({workspace_id:workspace,id:agent.id,title:'Other'})
  const insert = db.prepare('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)')
  const earlier = 'e'.repeat(32)
  const later = '1'.repeat(32)
  const draft = {title:'Ältere Maße.txt',mime:'text/plain',bytes:12,ref:{id:'private-ref'}}
  insert.run(earlier,conversation.id,'user','', 'sent',1,JSON.stringify({files:[
    draft,{...draft,title:'Ältere Maße.csv',mime:'text/csv'}, {...draft,title:'Ältere Maße.png',mime:'image/png'},
  ]}))
  insert.run(later,conversation.id,'user','', 'sent',1,JSON.stringify({files:[
    {...draft,title:'Ältere Maße.json',mime:'application/json'},
  ]}))
  const foreign = '2'.repeat(32)
  insert.run(foreign,other.id,'user','', 'sent',2,JSON.stringify({files:[draft]}))
  const path = convo+'/attachments'
  const list = async query => {
    const response = await request(path,{},query)
    assert.equal(response.status,200)
    return response.json()
  }
  const sent = await list('kind=file&q='+encodeURIComponent('笔记'))
  assert.deepEqual(sent.items[0].attachment,{id:data.message.id+':0',...attachment})
  const q = new URLSearchParams({kind:'file',q:'äLTERE',limit:'1'})
  const page = await list(q.toString())
  assert.equal(page.items[0].attachment.title,'Ältere Maße.json')
  assert.equal(page.items[0].message_id,later)
  assert.equal(page.items[0].created_at,1)
  assert.equal(page.items[0].attachment.ref,undefined)
  q.set('cursor',page.next_cursor)
  const next = await list(q.toString())
  assert.equal(next.items[0].attachment.title,'Ältere Maße.txt')
  assert.equal(next.items[0].message_id,earlier)
  q.set('cursor',next.next_cursor)
  const last = await list(q.toString())
  assert.equal(last.items[0].attachment.title,'Ältere Maße.csv')
  assert.equal(last.next_cursor,null)
  assert.equal((await list('kind=photo')).items[0].attachment.title,'Ältere Maße.png')
  assert.equal((await request(path,{},'kind=file&cursor='+foreign+'.0')).status,400)
  assert.equal((await request(path,{},'kind=file&kind=photo')).status,400)
  assert.equal((await request(path,{},'kind=other')).status,400)
  assert.equal((await request(path.replace(workspace,'b'.repeat(32)),{},'kind=file')).status,404)
  db.close()
})

test('live replies reveal only the current native snapshot and keep the final response authoritative', {timeout:3000}, async () => {
  const db = new DatabaseSync(':memory:')
  const runtime = createRuntime()
  let started = Promise.withResolvers()
  let completion = Promise.withResolvers()
  let turns = 0
  let lock = Promise.resolve()
  let enqueued
  runtime.exclusive = work => {
    enqueued?.resolve()
    const current = lock.then(work)
    lock = current.catch(() => {})
    return current
  }
  runtime.nativeTurn = (bot, sessionId, _prompt, _requestId, {onProgress, files, onStaged}) => runtime.exclusive(async () => {
    turns += 1
    assert.equal(bot,'agent')
    if (files) onStaged(files.map(file => ({title:file.title,mime:file.mime,bytes:file.data.length,ref:{id:'fixture'}})))
    started.resolve(onProgress)
    const text = await completion.promise
    return {text,sessionId,turnId:1}
  })
  const host = {runtime:async () => runtime, currentRuntime:() => runtime, call:async () => null}
  const {endpoints:e} = createAgents({db,host})
  const {agent} = await e.create({workspace_id:workspace,name:'Reader',idempotency_key:'a'.repeat(20)})
  const {conversation} = await e['conversation-create']({workspace_id:workspace,id:agent.id})
  const {conversation:other} = await e['conversation-create']({workspace_id:workspace,id:agent.id,title:'Other'})
  const convo = `${root}/${agent.id}/conversations/${conversation.id}`
  const request = legacyRequest(e)
  const key = 'live-reply-key-1234'
  const progress = (scope = convo, value = `key=${key}`) => request(scope+'/reply-progress',{},value)
  assert.equal((await progress()).status,404)
  const send = () => request(convo+'/messages',{method:'POST',
    headers:{'Content-Type':'application/json','Idempotency-Key':key}, body:JSON.stringify({body:'Take your time'})})
  const pending = send()
  const update = await started.promise
  assert.deepEqual(await (await progress()).json(),{state:'running',text:''})
  update('实际输出')
  const first = await progress()
  assert.equal(first.headers.get('cache-control'),'no-store')
  assert.deepEqual(await first.json(),{state:'running',text:'实际输出'})
  enqueued = Promise.withResolvers()
  const queuedCreate = e['conversation-create']({workspace_id:workspace,id:agent.id,title:'While generating'})
  await enqueued.promise
  enqueued = null
  assert.equal((await request(root)).status,200)
  const reopened = await (await request(convo)).json()
  assert.equal(reopened.items[1].client_key,key)
  assert.equal(reopened.items[1].body,'')
  const neighbor = await request(convo.replace(conversation.id,other.id))
  assert.equal(neighbor.status,200)
  assert.deepEqual((await neighbor.json()).items,[])
  assert.equal((await progress(convo.replace(workspace,'b'.repeat(32)))).status,404)
  assert.equal((await progress(convo.replace(conversation.id,other.id))).status,404)
  assert.equal((await progress(convo,`key=${key}&key=${key}`)).status,400)
  const retry = send()
  update('')
  assert.deepEqual(await (await progress()).json(),{state:'running',text:''})
  update('重新输出')
  assert.deepEqual(await (await progress()).json(),{state:'running',text:'重新输出'})
  completion.resolve('完整回复')
  const [firstSend,retrySend] = await Promise.all([pending,retry])
  const result = await firstSend.json()
  assert.deepEqual(await retrySend.json(),result)
  assert.equal(result.reply.body,'完整回复')
  assert.equal(turns,1)
  assert.equal((await queuedCreate).status,201)
  update('late partial')
  assert.deepEqual(await (await progress()).json(),{state:'succeeded'})

  started = Promise.withResolvers()
  completion = Promise.withResolvers()
  const fileKey = 'live-file-key-1234'
  const fileConvo = convo.replace(conversation.id,other.id)
  const form = new FormData()
  form.set('body','Review this attachment')
  form.append('file',new Blob(['data'],{type:'text/plain'}),'example.txt')
  const attachmentSend = request(fileConvo+'/messages',{method:'POST',
    headers:{'Idempotency-Key':fileKey},body:form})
  const updateAttachment = await Promise.race([started.promise,attachmentSend.then(response => {
    assert.fail(`Native turn did not start (HTTP ${response.status})`)
  })])
  updateAttachment('正在读附件')
  assert.deepEqual(await (await progress(fileConvo,`key=${fileKey}`)).json(),{state:'running',text:'正在读附件'})
  completion.reject(new Error('Fixture provider failed'))
  const failed = await (await attachmentSend).json()
  assert.equal(failed.reply.status,'failed')
  assert.equal(failed.reply.body,'')
  assert.deepEqual(await (await progress(fileConvo,`key=${fileKey}`)).json(),{state:'failed'})
  db.close()
})
