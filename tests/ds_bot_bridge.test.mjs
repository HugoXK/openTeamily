import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  createBridge, createBridgeServer, forwardModel, handleMcp, mcpTool, skillCapabilityName, MODEL_ID, TOOLS_CAPABILITY,
  userModelOverride, MODEL_OVERRIDE,
} from '../runtime/flybot-image/ds-bot-bridge.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))

function skill(id, content = 'Answer politely.') {
  return { id, name: 'Polite ' + id, version: '1.0.0', content, digest: createHash('sha256').update(content).digest('hex'),
    permissions: ['model_context'], format: 'openteamily.prompt-skill.v1', source: 'bundled-original' }
}

test('skill capability names satisfy DS-Bot capability naming', () => {
  for (const id of ['a', 'writing-helper', 'x'.repeat(64), 'a--b-']) {
    const name = skillCapabilityName(id)
    assert.match(name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    assert.ok(name.length <= 32)
  }
  assert.notEqual(skillCapabilityName('a'), skillCapabilityName('b'))
})

test('MCP bridge lists connected tools and only calls them during a task', async () => {
  const tool = { type: 'function', function: { name: 'GMAIL_FETCH', description: 'Fetch', parameters: { type: 'object', properties: {} } } }
  const state = { tools: [tool], active: null }
  const init = await handleMcp(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(await handleMcp(state, { jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const listed = await handleMcp(state, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(listed.result.tools, [mcpTool(tool)])
  const idle = await handleMcp(state, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'GMAIL_FETCH', arguments: {} } })
  assert.equal(idle.result.isError, true)
  const calls = []
  state.active = { tools: [tool], toolCalls: 0, bridge: { execute: async (id, name, args) => { calls.push([name, args]); return { ok: 1 } } } }
  const unknown = await handleMcp(state, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'OTHER', arguments: {} } })
  assert.equal(unknown.result.isError, true)
  const done = await handleMcp(state, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'GMAIL_FETCH', arguments: { q: 1 } } })
  assert.equal(done.result.isError, false)
  assert.deepEqual(JSON.parse(done.result.content[0].text), { ok: 1 })
  assert.deepEqual(calls, [['GMAIL_FETCH', { q: 1 }]])
  assert.equal((await handleMcp(state, { jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601)
})

test('loopback proxy swaps in the task model and key; DS-Bot only holds the placeholder', async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  const upstreamPort = await listen(upstream)
  const modelApi = { base_url: `http://127.0.0.1:${upstreamPort}/v1`, model: 'real-model', api_key: 'synthetic-task-key' }
  const state = { token: 'placeholder-token', active: { modelApi, modelCalls: 0 }, modelCalls: 0, tools: [], startupModel: () => null }
  const proxy = createBridgeServer(state)
  const port = await listen(proxy)
  const url = `http://127.0.0.1:${port}`
  try {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401)
    const models = await (await fetch(url + '/v1/models', { headers: { authorization: 'Bearer placeholder-token' } })).json()
    assert.equal(models.data[0].id, MODEL_ID)
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer placeholder-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'x' }] }) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /\[DONE\]/)
    assert.equal(seen[0].path, '/v1/chat/completions')
    assert.equal(seen[0].auth, 'Bearer synthetic-task-key')
    assert.equal(seen[0].body.model, 'real-model')
    assert.equal(state.active.modelCalls, 1)
    state.active = null
    const idle = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer placeholder-token' }, body: '{}' })
    assert.equal(idle.status, 503)
  } finally { await close(proxy); await close(upstream) }
})

test('exact-HTTP grant: redirects are rejected and only the granted path is used', async () => {
  const base = 'http://8.8.8.8:8080/v1'
  const modelApi = { base_url: base, model: 'm', api_key: 'k', http_endpoint_grant: { base_url: base, format: 'openteamily.exact-http-task.v1' } }
  const requests = []
  const fake = status => (options, onResponse) => {
    requests.push(options)
    const req = new EventEmitter()
    req.end = () => {
      const response = new PassThrough()
      response.statusCode = status
      response.headers = { 'content-type': 'application/json' }
      onResponse(response)
      response.end('{"ok":true}')
    }
    req.destroy = () => {}
    return req
  }
  const res = { headersSent: false, writeHead() { this.headersSent = true }, destroy() {}, chunks: [] }
  await assert.rejects(forwardModel(modelApi, Buffer.from('{}'), res, { httpRequester: fake(302) }), /redirect/)
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].agent, false)
  assert.equal(requests[0].family, 4)
  const wrong = { ...modelApi, http_endpoint_grant: { base_url: 'http://8.8.4.4:8080/v1', format: 'openteamily.exact-http-task.v1' } }
  await assert.rejects(forwardModel(wrong, Buffer.from('{}'), res, { httpRequester: fake(200) }), /grant/)
})

function fakeRuntime({ useModel = true } = {}) {
  const ctx = new EventEmitter()
  const on = ctx.on.bind(ctx)
  ctx.on = (name, fn) => { on(name, fn); return () => ctx.off(name, fn) }
  const log = []
  let bridgeState
  const bot = { id: 'bot1', model: undefined }
  const rt = {
    state: { mainBotIds: ['bot1'] },
    botOf: id => (id === 'bot1' ? bot : undefined),
    chatOf: () => 'chat1',
    addProvider: async body => { log.push(['addProvider', body.provider, body.baseURL, body.key === bridgeState.token]) },
    setProviderKey: async () => {},
    bootstrap: async () => { log.push(['bootstrap']) },
    updateBot: async (id, patch) => { log.push(['updateBot', patch.model]); bot.model = 'openteamily/' + patch.model },
    capabilitySave: async (item, opts) => { log.push(['save', item.kind, item.name, opts.ui]) },
    changeCapabilityAttachment: async (action, item, caller) => { log.push([action, item.name, caller]) },
    displayItems: (_sid, [event]) => (event.type === 'assistant/message' ? [{ kind: 'bot', text: event.data.text }] : []),
    sendUser: async ({ sessionId, content, requestId }) => {
      log.push(['sendUser', sessionId, content[0].text, requestId])
      if (useModel) bridgeState.active.modelCalls += 1
      setImmediate(() => {
        const session = { id: sessionId }
        ctx.emit('session/event', session, { type: 'turn/start' })
        ctx.emit('session/event', session, { type: 'user/message', data: { source: { rpcId: requestId } } })
        ctx.emit('session/event', session, { type: 'assistant/message', data: { text: 'reply from DS-Bot' } })
        ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 't1' } })
      })
    },
  }
  return { rt, ctx, log, bind: state => { bridgeState = state } }
}

test('the DeepSeek Flash vision model updates a retained provider and follows account changes', async () => {
  const fake = fakeRuntime()
  const bridge = createBridge(fake.rt, fake.ctx, { port: 1 })
  fake.bind(bridge.state)
  let model = 'DeepSeek-V4.1-Flash-1017'
  bridge.state.startupModel = () => ({model})
  fake.rt.addProvider = async () => { throw new Error('openteamily is already set up') }
  const updates = []
  fake.rt.saveProviderModels = async ({provider,models}) => updates.push([provider,models[0].input])
  await bridge.prepareModel()
  await bridge.prepareModel()
  assert.deepEqual(updates,[['openteamily',['text','image']]])
  model = 'another-text-only-model'
  await bridge.prepareModel()
  model = 'deepseek-flash'
  await bridge.prepareModel()
  assert.deepEqual(updates,[
    ['openteamily',['text','image']], ['openteamily',['text']], ['openteamily',['text','image']],
  ])
})

function fakeManagement(task, access) {
  const calls = []
  const requester = async (origin, token, method, path, body) => {
    calls.push([method, path, body])
    if (path === '/v1/agent/tasks' && method === 'GET') return { items: [task] }
    if (path.endsWith('/claim')) return { task }
    if (path.endsWith('/model-access')) return access
    if (path.endsWith('/skills/ack')) return { acknowledged: true }
    if (path.endsWith('/tools')) return { tools: [{ type: 'function', function: { name: 'GITHUB_LIST', parameters: { type: 'object' } } }] }
    return {}
  }
  return { calls, requester }
}

test('infer task runs as a DS-Bot turn with native skills and the tools MCP attached', async () => {
  const task = { id: 'task1', kind: 'infer', prompt: 'hello', deadline: Date.now() / 1000 + 60 }
  const access = { model_api: { base_url: 'https://api.example.test/v1', model: 'real-model', api_key: 'synthetic', source: 'user' },
    skills: [skill('writing-helper')], connected_tools: true }
  const fake = fakeRuntime()
  const mgmt = fakeManagement(task, access)
  const bridge = createBridge(fake.rt, fake.ctx, { requester: mgmt.requester, log: () => {}, port: 1 })
  fake.bind(bridge.state)
  assert.deepEqual(await bridge.cycle({ origin: 'http://127.0.0.1:9', token: 't', hostname: 'h' }), ['task1'])
  const posted = mgmt.calls.find(c => c[1] === '/v1/agent/tasks/task1/result')[2]
  assert.equal(posted.status, 'succeeded')
  assert.equal(posted.result.text, 'reply from DS-Bot')
  assert.equal(posted.result.engine, 'ds-bot')
  assert.equal(posted.result.ds_bot.session_id, 'chat1')
  assert.equal(posted.result.ds_bot.request_id, 'ot:task1')
  assert.equal(posted.result.ds_bot.model_calls, 1)
  assert.deepEqual(posted.result.ds_bot.skills, [skillCapabilityName('writing-helper')])
  assert.equal(posted.result.ds_bot.tools, 1)
  assert.ok(mgmt.calls.some(c => c[1] === '/v1/agent/tasks/task1/skills/ack'))
  assert.deepEqual(fake.log.find(e => e[0] === 'addProvider'), ['addProvider', 'openteamily', 'http://127.0.0.1:1/v1', true])
  assert.deepEqual(fake.log.find(e => e[0] === 'updateBot'), ['updateBot', MODEL_ID])
  assert.ok(fake.log.some(e => e[0] === 'save' && e[1] === 'skill' && e[3] === true))
  assert.ok(fake.log.some(e => e[0] === 'attach' && e[1] === TOOLS_CAPABILITY && e[2] === 'bot1'))
  assert.deepEqual(fake.log.find(e => e[0] === 'sendUser'), ['sendUser', 'chat1', 'hello', 'ot:task1'])
  assert.equal(bridge.state.active, null)
  assert.equal(access.model_api.api_key, undefined, 'task key is dropped after the turn')
  assert.ok(!JSON.stringify(fake.log).includes('synthetic'), 'real key never reaches DS-Bot')
})

test('a turn that never used the OpenTeamily model is reported as failed', async () => {
  const task = { id: 'task2', kind: 'infer', prompt: 'hi', deadline: Date.now() / 1000 + 60 }
  const fake = fakeRuntime({ useModel: false })
  const mgmt = fakeManagement(task, { model_api: { base_url: 'https://api.example.test/v1', model: 'm', api_key: 'k' }, skills: [] })
  const bridge = createBridge(fake.rt, fake.ctx, { requester: mgmt.requester, log: () => {}, port: 1 })
  fake.bind(bridge.state)
  await bridge.cycle({ origin: 'http://127.0.0.1:9', token: 't', hostname: 'h' })
  const posted = mgmt.calls.find(c => c[1] === '/v1/agent/tasks/task2/result')[2]
  assert.equal(posted.status, 'failed')
  assert.match(posted.result.error, /DS-Bot turn failed/)
})

test('tampered skill material is rejected before DS-Bot sees it', async () => {
  const task = { id: 'task3', kind: 'infer', prompt: 'hi' }
  const bad = { ...skill('x'), digest: '0'.repeat(64) }
  const fake = fakeRuntime()
  const mgmt = fakeManagement(task, { model_api: { base_url: 'https://api.example.test/v1', model: 'm', api_key: 'k' }, skills: [bad] })
  const bridge = createBridge(fake.rt, fake.ctx, { requester: mgmt.requester, log: () => {}, port: 1 })
  fake.bind(bridge.state)
  await bridge.cycle({ origin: 'http://127.0.0.1:9', token: 't', hostname: 'h' })
  const posted = mgmt.calls.find(c => c[1] === '/v1/agent/tasks/task3/result')[2]
  assert.equal(posted.status, 'failed')
  assert.match(posted.result.error, /skill/)
  assert.ok(!fake.log.some(e => e[0] === 'sendUser'))
})


test('separate conversations use separate native DS-Bot threads and reuse persisted mapping', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ot-chats-'))
  const fake = fakeRuntime()
  const bot = fake.rt.botOf('bot1')
  let created = 0
  fake.rt.chatOf = () => bot.sessionId || bot.id
  fake.rt.createSession = async () => 'session-' + (++created)
  fake.rt.workDirOf = () => '/data/workspace'
  fake.rt.chatOwners = new Map()
  fake.rt.save = async () => {}
  fake.rt.applyModel = async () => {}
  fake.rt.applyPermission = async () => {}
  fake.rt.switchPart = async (_id, sid) => { bot.sessionId = sid }
  const bridge = createBridge(fake.rt, fake.ctx, { env: { DSH_HOME: home }, port: 1 })
  fake.bind(bridge.state)
  try {
    await bridge.setup()
    await bridge.selectConversation('conv-a')
    const a = fake.rt.chatOf('bot1')
    await bridge.selectConversation('conv-b')
    assert.notEqual(fake.rt.chatOf('bot1'), a)
    await bridge.selectConversation('conv-a')
    assert.equal(fake.rt.chatOf('bot1'), a)
    const restarted = createBridge(fake.rt, fake.ctx, { env: { DSH_HOME: home }, port: 1 })
    fake.bind(restarted.state)
    await restarted.setup()
    await restarted.selectConversation('conv-a')
    assert.equal(fake.rt.chatOf('bot1'), a)
    assert.equal(created, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('B4: the account model override from @openteamily/web wins, failures fall back to none', () => {
  const scope = {}
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => ({ provider: 'openai', base_url: 'https://models.example/v1', model: 'm', api_key: 'k'.repeat(12), source: 'user' })
  assert.equal(userModelOverride(scope).source, 'user')
  scope[MODEL_OVERRIDE] = () => { throw new Error('sealed value is corrupt') }
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => null
  assert.equal(userModelOverride(scope), null)
})
