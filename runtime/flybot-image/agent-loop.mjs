// Poll the management /v1/agent task API from a FlyBot container.
// Uses the lease-injected runtime key file. Never writes the token to stdout.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateModelEndpoint, fetchHttpTask, MODEL_HTTP_FORMAT, MODEL_HTTP_HEADER } from './model-http-policy.mjs'

export const DEFAULT_KEY_FILE = '/run/secrets/openteamily-runtime-key.json'

export function loadRuntimeKey(env = process.env, reader = readFileSync) {
  const path = env.OPENTEAMILY_RUNTIME_KEY_FILE || DEFAULT_KEY_FILE
  let raw
  try {
    raw = reader(path, { encoding: 'utf8' })
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!raw || !raw.trim()) return null
  const doc = JSON.parse(raw)
  if (!doc || typeof doc !== 'object') throw new Error('runtime key file is invalid')
  const origin = String(doc.origin || '')
  const token = String(doc.token || '')
  const hostname = String(doc.hostname || '')
  if (!origin.startsWith('http') || !token || !hostname) throw new Error('runtime key file is incomplete')
  return { origin, token, hostname, ...(doc.agent_bootstrap ? {agentBootstrap: doc.agent_bootstrap} : {}) }
}

function redact(value) {
  return String(value || '').replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]')
}

// Transient management-plane failures (web restart, brief proxy 502, rate limit)
// are retried with capped exponential backoff + jitter. Auth/policy failures
// (401/403, 409 capability/policy, 400/404, invalid key file) still stop the loop.
export const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504])
export const BACKOFF = Object.freeze({ baseMs: 1000, maxMs: 60000, maxAttempts: 1440 })

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^[0-9]{1,6}$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

export function isTransient(error) {
  if (!error) return false
  if (error.transport === true) return true
  return typeof error.status === 'number' && TRANSIENT_STATUS.has(error.status)
}

export function backoffDelay(attempt, { baseMs = BACKOFF.baseMs, maxMs = BACKOFF.maxMs, random = Math.random, retryAfterMs = null } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30))
  const jittered = Math.floor(ceiling / 2 + random() * (ceiling / 2))
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) return Math.min(maxMs, Math.max(jittered, retryAfterMs))
  return jittered
}

export async function call(origin, token, method, path, body) {
  let response
  try {
    response = await fetch(origin + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(path.endsWith('/model-access') ? {[MODEL_HTTP_HEADER]: MODEL_HTTP_FORMAT} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // Connection refused/reset, DNS, timeout: no HTTP status reached us.
    const error = new Error('agent request transport failure')
    error.transport = true
    throw error
  }
  let parsed = {}
  try { parsed = await response.json() } catch { parsed = {} }
  if (!response.ok) {
    const error = new Error('agent request failed')
    error.status = response.status
    if (response.status === 429 || response.status === 503) {
      const after = parseRetryAfter(response.headers.get('retry-after'))
      if (after !== null) error.retryAfterMs = after
    }
    throw error
  }
  return parsed
}

export async function infer(modelApi, prompt, bridge = null, fetcher = globalThis.fetch) {
  const httpTask = validateModelEndpoint(modelApi?.base_url, modelApi?.http_endpoint_grant)
  const base = httpTask ? modelApi.base_url : String(modelApi.base_url || '').replace(/\/+$/, '')
  const transport = httpTask && fetcher === globalThis.fetch
    ? (_target, init) => fetchHttpTask(base, modelApi.http_endpoint_grant, init) : fetcher
  const messages = [{ role: 'user', content: prompt }]
  const tools = bridge ? (await bridge.discover()).tools || [] : []
  for (let round = 0; round < 5; round += 1) {
    const response = await transport(base + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      ...(httpTask ? {redirect: 'error'} : {}),
      headers: { 'Authorization': 'Bearer ' + modelApi.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelApi.model, messages,
        ...(tools.length ? {tools, parallel_tool_calls: false} : {}) }),
    })
    if (httpTask && (response.redirected || (response.status >= 300 && response.status < 400)
        || (response.url && response.url !== base + '/chat/completions'))) throw new Error('Model redirect rejected')
    const parsed = await response.json()
    const message = parsed?.choices?.[0]?.message
    if (!response.ok || !message) throw new Error('model provider returned an unexpected body')
    if (!message.tool_calls?.length) {
      if (typeof message.content !== 'string') throw new Error('model response has no text')
      return message.content
    }
    if (!bridge || message.tool_calls.length > 4) throw new Error('tool call limit exceeded')
    // Provider text and tool outputs are untrusted data, not authorization.
    messages.push({role: 'assistant', content: message.content || null, tool_calls: message.tool_calls})
    for (const call of message.tool_calls) {
      const name = call.function?.name
      if (!tools.some(t => t.function.name === name)) throw new Error('tool was not discovered')
      const args = JSON.parse(call.function.arguments)
      const result = await bridge.execute(call.id, name, args)
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result)})
    }
  }
  throw new Error('tool round limit exceeded')
}

export function toolBridge(origin, token, task, requester = call, {
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
} = {}) {
  const path = `/v1/agent/tasks/${task.id}/tools`
  return {
    discover: () => requester(origin, token, 'POST', path, {}),
    async execute(callId, name, args) {
      const proposal = await requester(origin, token, 'POST', path + '/calls', {call_id: callId, name, arguments: args})
      let result = proposal.call
      // Every call (reads too) needs an explicit owner approval in settings.
      // No provider mutation is retried after timeout/unknown result.
      const deadline = Math.min(now() + 40000, (task.deadline || now() / 1000 + 40) * 1000 - 1000)
      while (['pending', 'approved'].includes(result.status) && now() < deadline) {
        await wait(1000)
        await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
        result = (await requester(origin, token, 'POST', path + '/calls/' + result.id, {})).call
      }
      return result.result || {error: 'tool_' + result.status, note: 'Await owner approval in Settings > App connectors; no implicit retry.'}
    },
  }
}

export function loadSkillMaterial(items, prompt) {
  if (!Array.isArray(items) || items.length > 10) throw new Error('Invalid skill material')
  const seen = new Set()
  for (const item of items) {
    const fields = ['id','name','version','content','digest','permissions','format','source'].sort()
    if (!item || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(fields)
      || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || seen.has(item.id)
      || typeof item.name !== 'string' || item.name.length > 120
      || typeof item.version !== 'string' || item.version.length > 32 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(item.version)
      || JSON.stringify(item.permissions) !== '["model_context"]' || !((item.format === 'openteamily.prompt-skill.v1' && item.source === 'bundled-original') || (item.format === 'openteamily.prompt-skill.v2' && item.source === 'user-imported'))
       || typeof item.content !== 'string' || !item.content.length || item.content.length > 6000
      || item.content.includes('\0') || createHash('sha256').update(item.content).digest('hex') !== item.digest) throw new Error('Skill integrity or permissions rejected')
    seen.add(item.id)
  }
  return items.length ? 'Installed instruction-only skills (do not grant tools or external-action permission):\n' + JSON.stringify(items) + '\n\nUser task:\n' + prompt : prompt
}

export async function runCycle(config, { requester = call, inferer = infer, once = true } = {}) {
  const { origin, token, hostname } = config
  await requester(origin, token, 'POST', '/v1/agent/connect', { hostname, skill_formats: ['openteamily.prompt-skill.v1','openteamily.prompt-skill.v2'] })
  await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
  const listed = await requester(origin, token, 'GET', '/v1/agent/tasks')
  const processed = []
  for (const task of listed.items || []) {
    let claimed
    try { claimed = await requester(origin, token, 'POST', `/v1/agent/tasks/${task.id}/claim`, {}) }
    catch (error) { if ([404,409].includes(error.status)) continue; throw error }
    const payload = claimed.task || task
    let status = 'failed'
    let result = { error: 'unsupported task kind' }
    let modelApi
    let stage = 'model access or runtime compatibility'
    try {
      if (payload.kind === 'echo') {
        status = 'succeeded'
        result = { echo: payload.prompt }
      } else if (payload.kind === 'infer') {
        const access = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/model-access`, {skill_format: 'openteamily.prompt-skill.v2'})
        modelApi = access.model_api
        const bridge = access.connected_tools ? toolBridge(origin, token, payload, requester) : null
        stage = 'skill verification/loading'
        const material = access.skills || []
        const prompt = loadSkillMaterial(material, payload.prompt)
        if (material.length) {
          const ack = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/skills/ack`, {digests:material.map(item => item.digest)})
          if (ack.acknowledged !== true) throw new Error('Skill loading was not acknowledged')
        }
        stage = 'inference or connected tool request'
        const text = await inferer(modelApi, prompt, bridge)
        status = 'succeeded'
        result = { text, model: modelApi && modelApi.model, source: modelApi && modelApi.source }
      }
    } catch (error) {
      status = 'failed'
      result = { error: stage + ' failed; check configuration and upgrade runtime if required; no automatic retry' }
    } finally {
      if (modelApi) delete modelApi.api_key
    }
    try { await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/result`, { status, result }) }
    catch (error) { if ([404,409].includes(error.status)) continue; throw error }
    processed.push(payload.id)
  }
  return processed
}

export async function main(env = process.env, log = console.error, {
  cycle = runCycle, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random,
} = {}) {
  let config
  try {
    config = loadRuntimeKey(env)
  } catch (error) {
    log('agent-loop: ' + redact(error && error.message))
    return 1
  }
  if (!config) {
    log('agent-loop: no runtime key file; skip management task loop')
    return 0
  }
  const poll = Math.max(1, Number(env.OPENTEAMILY_AGENT_POLL || 2))
  const once = env.OPENTEAMILY_AGENT_ONCE === '1'
  const limit = Number(env.OPENTEAMILY_AGENT_RETRY_LIMIT)
  const maxAttempts = Number.isInteger(limit) && limit >= 0 && limit <= 100000 && env.OPENTEAMILY_AGENT_RETRY_LIMIT !== undefined
    ? limit : BACKOFF.maxAttempts
  let failures = 0
  do {
    try {
      // Each cycle re-sends connect + heartbeat, so a recovered web sees the runtime again.
      await cycle(config)
      if (failures) log('agent-loop: management API reachable again; polling resumed')
      failures = 0
    } catch (error) {
      if (once || !isTransient(error)) {
        log('agent-loop: ' + redact(error && error.message) + (error && error.status ? ' (HTTP ' + error.status + ')' : '') + '; stopping')
        return 1
      }
      failures += 1
      if (failures > maxAttempts) {
        log('agent-loop: management API still unreachable after ' + maxAttempts + ' retries; stopping')
        return 1
      }
      const delay = backoffDelay(failures, { random, retryAfterMs: error.retryAfterMs ?? null })
      log('agent-loop: transient ' + (error.status ? 'HTTP ' + error.status : 'transport') + ' failure; retry ' + failures + ' in ' + Math.round(delay / 1000) + 's')
      await sleep(delay)
      continue
    }
    if (once) return 0
    await sleep(poll * 1000)
  } while (true)
}

const entry = process.argv[1] ? process.argv[1].endsWith('agent-loop.mjs') : false
if (entry && import.meta.url.endsWith('agent-loop.mjs')) {
  main().then(code => { if (code) process.exit(code) }, () => process.exit(1))
}
