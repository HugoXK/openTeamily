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
