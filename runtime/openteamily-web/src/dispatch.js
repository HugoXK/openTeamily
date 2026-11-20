// POST /api/openteamily: one JSON channel for every OpenTeamily feature that has
// moved into the user's DS-Bot. Phase A only answers shell/identity; later
// batches add their endpoints here (see docs/DSBOT_PLUGIN_ARCHITECTURE.md §6).
export const API_PATH = '/api/openteamily'
export const PLUGIN_VERSION = '0.1.0'

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

export function createEndpoints({ identity }) {
  return {
    'shell/identity': async () => ({
      served_by: 'ds-bot',
      plugin: '@openteamily/web',
      version: PLUGIN_VERSION,
      instance_id: identity.instanceId,
    }),
  }
}

export function createDispatch({ identity, endpoints = createEndpoints({ identity }) }) {
  return async (request) => {
    let body
    try { body = await request.json() } catch { body = null }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ ok: false, error: { code: 'openteamily/invalid', message: 'JSON object body required', details: {} } })
    }
    const name = String(body.endpoint ?? '')
    const handler = Object.hasOwn(endpoints, name) ? endpoints[name] : null
    if (!handler) {
      return json({ ok: false, error: { code: 'openteamily/not-found', message: `Unknown OpenTeamily endpoint ${name.slice(0, 80)}`, details: {} } })
    }
    try {
      return json({ ok: true, value: await handler(body.payload ?? null, request) })
    } catch (error) {
      return json({ ok: false, error: { code: error?.code ?? 'openteamily/error', message: error?.message ?? 'Request failed', details: {} } })
    }
  }
}
