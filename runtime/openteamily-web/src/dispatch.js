// POST /api/openteamily: one JSON channel for every OpenTeamily feature that has
// moved into the user's DS-Bot. Endpoints come from features/<name>/index.js
// (see src/features.js) as '<name>/<op>'.
export const API_PATH = '/api/openteamily'
export const PLUGIN_VERSION = '0.2.0'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

const failure = (code, message) => json({ ok: false, error: { code, message, details: {} } })

// endpoints: a table or a function returning a table (or a promise of one), so the
// route can be registered before features finish loading.
export function createDispatch({ endpoints, host = null }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async (request) => {
    let body
    try { body = await request.json() } catch { body = null }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure('openteamily/invalid', 'JSON object body required')
    }
    const name = String(body.endpoint ?? '')
    const current = await table()
    const handler = Object.hasOwn(current, name) ? current[name] : null
    if (!handler) return failure('openteamily/not-found', `Unknown OpenTeamily endpoint ${name.slice(0, 80)}`)
    try {
      return json({ ok: true, value: await handler(body.payload ?? null, { request, host }) })
    } catch (error) {
      return failure(typeof error?.code === 'string' ? error.code.slice(0, 80) : 'openteamily/error',
        String(error?.message ?? 'Request failed').slice(0, 500))
    }
  }
}

export const GATEWAY_PATH = '/api/openteamily/gateway'

const INVOKE = /^\/v1\/gateway\/agents\/([0-9a-f]{32})\/invocations$/
const STATUS = /^\/v1\/gateway\/invocations\/([0-9a-f]{32})$/
const TOKEN = /^ota_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/

function gatewayJSON(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function gatewayError(status, code, message) {
  return gatewayJSON({ error: { code, message, details: {} } }, status)
}

// External Agent API surface, shaped like the legacy /v1/gateway responses.
export function createGatewayDispatch({ endpoints }) {
  const table = typeof endpoints === 'function' ? endpoints : async () => endpoints
  return async (request) => {
    const url = new URL(request.url)
    const path = url.searchParams.get('path') || ''
    const token = request.headers.get('x-ot-gateway-token') || ''
    if (!TOKEN.test(token)) return gatewayError(401, 'unauthorized', 'Invalid API key')
    const current = await table()
    const invoke = INVOKE.exec(path)
    const status = STATUS.exec(path)
    try {
      if (invoke && request.method === 'POST') {
        let body
        try { body = await request.json() } catch { body = null }
        const prompt = body && typeof body.prompt === 'string' ? body.prompt : ''
        const idempotency = request.headers.get('idempotency-key') || (body && body.idempotency_key)
        const handler = current['agent-api/invoke']
        if (!handler) return gatewayError(503, 'unavailable', 'External Agent API is not available')
        const value = await handler({ token, agent_id: invoke[1], prompt, idempotency_key: idempotency }, { request, host: null })
        return gatewayJSON({ invocation: value.invocation }, value.status || 202)
      }
      if (status && request.method === 'GET') {
        const handler = current['agent-api/invocation']
        if (!handler) return gatewayError(503, 'unavailable', 'External Agent API is not available')
        const value = await handler({ token, id: status[1] }, { request, host: null })
        return gatewayJSON({ invocation: value.invocation }, 200)
      }
      return gatewayError(404, 'not_found', 'Unknown gateway path')
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code.replace(/^agent-api\//, '') : 'error'
      const http = Number(error?.status) || 500
      return gatewayError(http, code.slice(0, 80), String(error?.message ?? 'Request failed').slice(0, 500))
    }
  }
}
