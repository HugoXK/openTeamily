// Poll the management /v1/agent task API from a FlyBot container.
// Uses the lease-injected runtime key file. Never writes the token to stdout.
import { readFileSync } from 'node:fs'

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
  return { origin, token, hostname }
}

function redact(value) {
  return String(value || '').replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]')
}

async function call(origin, token, method, path, body) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = {}
  try { parsed = await response.json() } catch { parsed = {} }
  if (!response.ok) {
    const error = new Error('agent request failed')
    error.status = response.status
    throw error
  }
  return parsed
}

async function infer(modelApi, prompt) {
  const base = String(modelApi.base_url || '').replace(/\/+$/, '')
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + modelApi.api_key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelApi.model,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const parsed = await response.json()
  const text = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
    ? parsed.choices[0].message.content : null
  if (!response.ok || typeof text !== 'string') throw new Error('model provider returned an unexpected body')
  return text
}

export async function runCycle(config, { requester = call, inferer = infer, once = true } = {}) {
  const { origin, token, hostname } = config
  await requester(origin, token, 'POST', '/v1/agent/connect', { hostname })
  await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
  const listed = await requester(origin, token, 'GET', '/v1/agent/tasks')
  const processed = []
  for (const task of listed.items || []) {
    const claimed = await requester(origin, token, 'POST', `/v1/agent/tasks/${task.id}/claim`, {})
    const payload = claimed.task || task
    let status = 'failed'
    let result = { error: 'unsupported task kind' }
    let modelApi
    try {
      if (payload.kind === 'echo') {
        status = 'succeeded'
        result = { echo: payload.prompt }
      } else if (payload.kind === 'infer') {
        const access = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/model-access`, {})
        modelApi = access.model_api
        const text = await inferer(modelApi, payload.prompt)
        status = 'succeeded'
        result = { text, model: modelApi && modelApi.model, source: modelApi && modelApi.source }
      }
    } catch (error) {
      status = 'failed'
      result = { error: 'infer failed' }
    } finally {
      if (modelApi) delete modelApi.api_key
    }
    await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/result`, { status, result })
    processed.push(payload.id)
  }
  return processed
}

export async function main(env = process.env, log = console.error) {
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
  try {
    do {
      await runCycle(config)
      if (once) return 0
      await new Promise(resolve => setTimeout(resolve, poll * 1000))
    } while (true)
  } catch (error) {
    log('agent-loop: ' + redact(error && error.message))
    return 1
  }
}

const entry = process.argv[1] ? process.argv[1].endsWith('agent-loop.mjs') : false
if (entry && import.meta.url.endsWith('agent-loop.mjs')) {
  main().then(code => { if (code) process.exit(code) }, () => process.exit(1))
}
