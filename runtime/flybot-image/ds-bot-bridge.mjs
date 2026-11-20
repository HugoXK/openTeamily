// OpenTeamily → DS-Bot bridge. Loaded inside the DSH plugin process, so every
// management chat task runs as a real DS-Bot turn on this user's own runtime:
//
//   management /v1/agent task ──claim──▶ bridge ──rt.sendUser──▶ DS-Bot Bot turn
//        ▲                                   │                        │
//        └──────── result (DS-Bot reply) ◀───┘   model + tools ◀──────┘
//                                     loopback proxy (127.0.0.1 only)
//
// - Model access: DS-Bot's provider "openteamily" points at a loopback
//   OpenAI-compatible proxy and holds only a per-boot placeholder token. The
//   proxy swaps in the task-scoped model_api (or the operator secret file when
//   idle), enforcing the exact-HTTP grant (no redirects, IPv4, bounded) or HTTPS.
//   The real key never enters DS-Bot settings, env, logs or UI.
// - Skills: digest-verified skill material becomes native DS-Bot skill
//   capabilities attached to the Bot, then management gets the skills ack.
// - Connected tools (Composio): a loopback MCP server ("ot-tools") proxies the
//   task's /v1/agent/tasks/{id}/tools discover/calls endpoints. Credentials stay
//   on the server; every call still needs the owner's one-shot approval there.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { startOpenPart } from '../ds-bot-upstream/ds-bot/src/host/threads.js'
import { request as httpsRequest } from 'node:https'
import { call, loadSkillMaterial, main as agentMain, toolBridge } from './agent-loop.mjs'
import { STREAM_LIMIT, streamHttpTask, validateModelEndpoint } from './model-http-policy.mjs'
import { loadModelApi, redact } from './model-api.js'

export const MODEL_OVERRIDE = Symbol.for('openteamily.model-api.override')
export function userModelOverride(scope = globalThis) {
  const resolve = scope[MODEL_OVERRIDE]
  if (typeof resolve !== 'function') return null
  try { return resolve() || null } catch { return null }
}
export const PROVIDER = 'openteamily'
export const MODEL_ID = 'openteamily-model'
export const TOOLS_CAPABILITY = 'ot-tools'
export const DEFAULT_PORT = 18731
const BODY_LIMIT = 4 * 1024 * 1024
const RESULT_TEXT_LIMIT = 12000
const SKILL_FORMATS = ['openteamily.prompt-skill.v1', 'openteamily.prompt-skill.v2']

export function skillCapabilityName(id) {
  return 'ot-skill-' + createHash('sha256').update(String(id)).digest('hex').slice(0, 12)
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

// Forward one OpenAI chat-completions request to the configured upstream. The
// model name and credential always come from modelApi, never from DS-Bot.
export async function forwardModel(modelApi, raw, res, { httpRequester = httpRequest, httpsRequester = httpsRequest } = {}) {
  const httpTask = validateModelEndpoint(modelApi?.base_url, modelApi?.http_endpoint_grant)
  const base = httpTask ? modelApi.base_url : String(modelApi.base_url || '').replace(/\/+$/, '')
  let parsed
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: { message: 'invalid body' } })
  parsed.model = modelApi.model
  const body = Buffer.from(JSON.stringify(parsed))
  const headers = {
    'Authorization': 'Bearer ' + modelApi.api_key,
    'Content-Type': 'application/json',
    'Accept': parsed.stream ? 'text/event-stream' : 'application/json',
    'Content-Length': body.length,
  }
  const relay = (status, upstreamHeaders, stream) => new Promise(resolve => {
    res.writeHead(status, { 'Content-Type': upstreamHeaders['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
    let bytes = 0
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > STREAM_LIMIT) stream.destroy(new Error('model response too large')) })
    res.on('close', () => { if (!res.writableFinished) stream.destroy() })
    stream.pipe(res)
    stream.on('end', resolve)
    stream.on('error', () => { res.destroy(); resolve() })
    stream.on('close', resolve)
  })
  const signal = AbortSignal.timeout(180000)
  if (httpTask) {
    return streamHttpTask(base, modelApi.http_endpoint_grant, { method: 'POST', redirect: 'error', headers, body, signal }, relay, httpRequester)
  }
  const url = new URL(base + '/chat/completions')
  const requester = url.protocol === 'https:' ? httpsRequester : httpRequester
  return new Promise((resolve, reject) => {
    const req = requester(url, { method: 'POST', headers, agent: false, signal }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); reject(new Error('Model redirect rejected')); return }
      resolve(relay(response.statusCode, response.headers, response))
    })
    req.on('error', () => reject(new Error('model request failed')))
    req.end(body)
  })
}

export function mcpTool(tool) {
  const fn = tool?.function || {}
  return { name: fn.name, description: String(fn.description || '').slice(0, 1024), inputSchema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object' } }
}

// Loopback server: /v1/models + /v1/chat/completions for DS-Bot's provider and
// /mcp (streamable HTTP, JSON responses) for connected tools.
export function createBridgeServer(state, { log = () => {}, forward = forwardModel } = {}) {
  return createServer(async (req, res) => {
    try {
      // Browsers attach Origin; nothing legitimate here does (DNS-rebinding guard).
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: { message: 'forbidden' } })
      const path = (req.url || '').split('?')[0]
      if (path === '/v1/models' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'openteamily' }] })
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        const raw = await readBody(req)
        const modelApi = state.active?.modelApi || state.startupModel()
        if (!modelApi) return sendJson(res, 503, { error: { message: 'No model is configured for this OpenTeamily runtime yet.' } })
        if (state.active) state.active.modelCalls += 1
        state.modelCalls += 1
        try { await forward(modelApi, raw, res) } catch (error) {
          log('ds-bot-bridge: model upstream failed: ' + redact(error?.message || 'error'))
          if (!res.headersSent) sendJson(res, 502, { error: { message: 'upstream model request failed' } })
          else res.destroy()
        }
        return
      }
      if (path === '/mcp') {
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end() }
        const message = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'))
        const batch = Array.isArray(message)
        const replies = []
        for (const item of batch ? message : [message]) {
          const reply = await handleMcp(state, item)
          if (reply) replies.push(reply)
        }
        if (!replies.length) { res.writeHead(202); return res.end() }
        return sendJson(res, 200, batch ? replies : replies[0])
      }
      sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      if (!res.headersSent) sendJson(res, error?.status || 400, { error: { message: 'bad request' } })
    }
  })
}

export async function handleMcp(state, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }
  }
  if (message.id === undefined) return null // notification
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result })
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
  switch (message.method) {
    case 'initialize':
      return ok({ protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-03-26',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'openteamily-connected-tools', version: '1.0.0' },
        instructions: 'OpenTeamily connected app tools. Every call waits for the account owner to approve it in OpenTeamily Settings > App connectors.' })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: state.tools.map(mcpTool) })
    case 'tools/call': {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      const active = state.active
      if (!active?.bridge) return ok({ isError: true, content: [{ type: 'text', text: 'Connected tools are only available while answering an OpenTeamily message.' }] })
      if (!active.tools.some(tool => tool.function?.name === name)) return ok({ isError: true, content: [{ type: 'text', text: 'Tool is not connected for this account.' }] })
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'arguments must be an object')
      try {
        const callId = 'dsbot_' + randomBytes(9).toString('hex')
        const result = await active.bridge.execute(callId, name, args)
        active.toolCalls += 1
        return ok({ isError: !!result?.error, content: [{ type: 'text', text: JSON.stringify(result).slice(0, 60000) }] })
      } catch {
        return ok({ isError: true, content: [{ type: 'text', text: 'Connected tool request failed; no automatic retry.' }] })
      }
    }
    default:
      return fail(-32601, 'Method not found')
  }
}

// Wait for the DS-Bot turn that our requestId started; collect the Bot's text.
export function runTurn(rt, ctx, botId, text, requestId, timeoutMs = 170000) {
  return new Promise((resolve, reject) => {
    let sessionId
    let settled = false
    const parts = []
    let off = () => {}
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { off() } catch {}
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('DS-Bot turn timed out')), timeoutMs)
    const disposer = ctx.on('session/event', (session, event) => {
      if (settled) return
      if (event?.type === 'user/message' && event.data?.source?.rpcId === requestId) { sessionId = session.id; return }
      if (!sessionId || session?.id !== sessionId) return
      for (const item of rt.displayItems(session.id, [event]) ?? []) {
        if (item?.kind === 'bot' && typeof item.text === 'string' && item.text.trim()) parts.push(item.text)
      }
      if (event.type === 'turn/end') {
        const reply = parts.join('\n\n').trim()
        if (reply) finish(null, { text: reply, sessionId, turnId: event.data?.turnId ?? event.turnId ?? null })
        else finish(new Error(event.data?.error ? 'DS-Bot turn failed' : 'DS-Bot turn ended without a reply'))
      }
    })
    off = typeof disposer === 'function' ? disposer : () => disposer?.dispose?.()
    Promise.resolve(rt.sendUser({ sessionId: rt.chatOf(botId), content: [{ type: 'text', text }], requestId }))
      .catch(error => finish(error instanceof Error ? error : new Error('DS-Bot rejected the message')))
  })
}

export function createBridge(rt, ctx, { env = process.env, log = console.error, port, requester = call } = {}) {
  const state = {
    token: randomBytes(24).toString('hex'),
    active: null,
    tools: [],
    modelCalls: 0,
    // The account's own model settings (B4 @openteamily/web model-api feature,
    // in-process, sealed at rest) win over the manager-mounted startup file.
    startupModel: () => { try { return userModelOverride() || loadModelApi(env) || null } catch { return null } },
  }
  const listenPort = port ?? (Number(env.OPENTEAMILY_BRIDGE_PORT) || DEFAULT_PORT)
  const baseURL = `http://127.0.0.1:${listenPort}/v1`
  let ready = null
  let botId = null
  let skillNames = new Set()
  let toolsAttached = false
  const chatsPath = join(env.DSH_HOME || '/data', 'openteamily-chats.json')
  let chats
  const loadChats = () => {
    if (chats) return chats
    try { chats = JSON.parse(readFileSync(chatsPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; chats = {} }
    return chats
  }
  async function selectConversation(id) {
    if (!id) return
    const map = loadChats()
    if (map[id]) { await rt.switchPart(botId, map[id]); return }
    // Each OpenTeamily conversation gets a separate native DS-Bot chat/session.
    const bot = rt.botOf(botId)
    const freshId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId }) })
    startOpenPart(bot, freshId)
    rt.chatOwners.set(freshId, botId)
    await rt.save()
    await rt.applyModel(bot, { force: true })
    await rt.applyPermission(bot, freshId, undefined)
    map[id] = freshId
    writeFileSync(chatsPath + '.tmp', JSON.stringify(map), { mode: 0o600 })
    renameSync(chatsPath + '.tmp', chatsPath)
  }

  async function setup() {
    try {
      await rt.addProvider({ provider: PROVIDER, custom: true, api: 'openai-completions', name: 'OpenTeamily', baseURL,
        models: [{ id: MODEL_ID, name: 'OpenTeamily model', contextWindow: 128000, maxTokens: 8192, input: ['text'] }],
        key: state.token })
    } catch (error) {
      if (!/already set up/.test(String(error?.message))) throw error
      await rt.setProviderKey(PROVIDER, state.token)
    }
    await rt.bootstrap()
    botId = rt.state.mainBotIds.find(id => rt.botOf(id))
    if (!botId) throw new Error('DS-Bot has no Main Bot')
    const bot = rt.botOf(botId)
    if (!String(bot.model || '').endsWith('/' + MODEL_ID) && bot.model !== MODEL_ID) await rt.updateBot(botId, { model: MODEL_ID })
    return botId
  }
  const ensureSetup = () => (ready ??= setup().catch(error => { ready = null; throw error }))

  const attachedNow = () => new Set(rt.botOf(botId)?.capabilities ?? [])
  async function syncSkills(material) {
    const wanted = new Map(material.map(item => [skillCapabilityName(item.id), item]))
    // Survives restarts: what is attached lives in DS-Bot's own team state.
    skillNames = new Set([...attachedNow()].filter(name => name.startsWith('ot-skill-')))
    for (const [name, item] of wanted) {
      await rt.capabilitySave({ name, kind: 'skill', description: `${item.name} (OpenTeamily skill ${item.id} v${item.version}, instruction-only)`.slice(0, 200), content: item.content }, { ui: true })
      if (!skillNames.has(name)) await rt.changeCapabilityAttachment('attach', { name }, botId)
    }
    for (const name of skillNames) {
      if (!wanted.has(name)) await rt.changeCapabilityAttachment('detach', { name }, botId).catch(() => {})
    }
    skillNames = new Set(wanted.keys())
    return [...wanted.keys()]
  }

  async function syncTools(connected) {
    toolsAttached = attachedNow().has(TOOLS_CAPABILITY)
    if (connected) {
      const catalog = createHash('sha256').update(JSON.stringify(state.tools)).digest('hex').slice(0, 16)
      await rt.capabilitySave({ name: TOOLS_CAPABILITY, kind: 'mcp', description: 'OpenTeamily connected app tools (owner approves every call)', transport: 'streamable-http', url: `http://127.0.0.1:${listenPort}/mcp?catalog=${catalog}` }, { ui: true })
      if (!toolsAttached) await rt.changeCapabilityAttachment('attach', { name: TOOLS_CAPABILITY }, botId)
      toolsAttached = true
    } else if (!connected && toolsAttached) {
      await rt.changeCapabilityAttachment('detach', { name: TOOLS_CAPABILITY }, botId).catch(() => {})
      toolsAttached = false
    }
  }

  // One DS-Bot turn at a time per runtime: management tasks and @openteamily/web
  // plugin chat both switch the Main Bot's active part, so they share this lock.
  let turnQueue = Promise.resolve()
  function exclusive(fn) {
    const run = turnQueue.then(() => fn())
    turnQueue = run.catch(() => {})
    return run
  }
  const infer = (origin, token, payload) => exclusive(() => inferUnlocked(origin, token, payload))

  async function inferUnlocked(origin, token, payload) {
    const access = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/model-access`, { skill_format: 'openteamily.prompt-skill.v2' })
    const active = { taskId: payload.id, modelApi: access.model_api, modelCalls: 0, toolCalls: 0, bridge: null, tools: [] }
    let stage = 'DS-Bot setup'
    // Active before setup: picking the Bot's model may release DS-Bot's greeting turn.
    state.active = active
    try {
      await ensureSetup()
      await selectConversation(access.conversation_id || (rt.createSession ? 'task:' + payload.id : null))
      stage = 'skill verification/loading'
      const material = access.skills || []
      loadSkillMaterial(material, '')
      const skills = await syncSkills(material)
      if (material.length) {
        const ack = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/skills/ack`, { digests: material.map(item => item.digest) })
        if (ack.acknowledged !== true) throw new Error('Skill loading was not acknowledged')
      }
      stage = 'connected tool discovery'
      if (access.connected_tools) {
        active.bridge = toolBridge(origin, token, payload, requester)
        active.tools = ((await active.bridge.discover()).tools || []).filter(tool => typeof tool?.function?.name === 'string')
        state.tools = active.tools
      }
      await syncTools(!!access.connected_tools)
      stage = 'DS-Bot turn'
      const requestId = 'ot:' + payload.id
      const beat = setInterval(() => { requester(origin, token, 'POST', '/v1/agent/heartbeat', {}).catch(() => {}) }, 10000)
      let turn
      const deadlineMs = payload.deadline ? payload.deadline * 1000 - Date.now() - 2000 : 170000
      try { turn = await runTurn(rt, ctx, botId, payload.prompt, requestId, Math.max(5000, Math.min(deadlineMs, 600000))) }
      catch (error) { await rt.stopChat?.(botId).catch(() => {}); throw error }
      finally { clearInterval(beat) }
      if (!active.modelCalls) throw new Error('DS-Bot turn did not use the OpenTeamily model')
      // Read through DSH's native history API, not grep over its binary store.
      let historyVerified = false
      if (rt.eventsBackwards && rt.resolveAgent && ctx.sessions?.flush) {
        const agent = await rt.resolveAgent(turn.sessionId)
        await ctx.sessions.flush(agent.session)
        for await (const event of rt.eventsBackwards(turn.sessionId, AbortSignal.timeout(5000), 3)) {
          if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) { historyVerified = true; break }
        }
        if (!historyVerified) throw new Error('DS-Bot persisted turn verification failed')
      }
      return { text: turn.text.slice(0, RESULT_TEXT_LIMIT), model: active.modelApi?.model, source: active.modelApi?.source, engine: 'ds-bot',
        ds_bot: { bot_id: botId, session_id: turn.sessionId, request_id: requestId, turn_id: turn.turnId, model_calls: active.modelCalls,
          tool_calls: active.toolCalls, history_verified: historyVerified, skills, tools: active.tools.length } }
    } catch (error) {
      log('ds-bot-bridge: ' + stage + ' failed: ' + redact(error?.message || 'error'))
      throw Object.assign(new Error(stage), { stage })
    } finally {
      if (state.active === active) state.active = null
      if (active.modelApi) delete active.modelApi.api_key
    }
  }

  async function cycle(config, { once = true } = {}) {
    const { origin, token, hostname } = config
    await requester(origin, token, 'POST', '/v1/agent/connect', { hostname, skill_formats: SKILL_FORMATS })
    await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
    const listed = await requester(origin, token, 'GET', '/v1/agent/tasks')
    const processed = []
    for (const task of listed.items || []) {
      let claimed
      try { claimed = await requester(origin, token, 'POST', `/v1/agent/tasks/${task.id}/claim`, {}) }
      catch (error) { if ([404, 409].includes(error.status)) continue; throw error }
      const payload = claimed.task || task
      let status = 'failed'
      let result = { error: 'unsupported task kind' }
      try {
        if (payload.kind === 'echo') { status = 'succeeded'; result = { echo: payload.prompt } }
        else if (payload.kind === 'infer') { result = await infer(origin, token, payload); status = 'succeeded' }
      } catch (error) {
        status = 'failed'
        result = { error: (error?.stage || 'model access or runtime compatibility') + ' failed; check configuration and upgrade runtime if required; no automatic retry' }
      }
      try { await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/result`, { status, result }) }
      catch (error) { if ([404, 409].includes(error.status)) continue; throw error }
      processed.push(payload.id)
    }
    return processed
  }

  return { state, setup: ensureSetup, cycle, infer, exclusive, syncSkills, syncTools, selectConversation, legacySession: key => loadChats()[key], port: listenPort, baseURL, get botId() { return botId } }
}

// Plugin entry: start the loopback server and the management task loop.
export function startBridge(rt, ctx, options = {}) {
  const log = options.log ?? console.error
  const env = options.env ?? process.env
  const bridge = createBridge(rt, ctx, { ...options, env, log })
  const server = createBridgeServer(bridge.state, { log })
  server.on('error', error => log('ds-bot-bridge: loopback server error: ' + redact(error?.message || 'error')))
  server.listen(bridge.port, '127.0.0.1')
  let stopped = false
  const loop = agentMain(env, log, { cycle: config => (stopped ? Promise.resolve([]) : bridge.cycle(config)) })
    .then(code => { if (code) log('ds-bot-bridge: management task loop stopped') })
  const dispose = () => { stopped = true; server.close() }
  ctx.on?.('dispose', dispose)
  return { bridge, server, loop, dispose }
}
