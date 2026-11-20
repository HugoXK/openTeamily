
import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayDispatch, GATEWAY_PATH } from '../src/dispatch.js'

const token = 'ota_' + '1'.repeat(32) + '_' + 'K'.repeat(43)
const agent = 'a'.repeat(32)
const inv = 'c'.repeat(32)

function request(path, { method = 'POST', headers = {}, body } = {}) {
  return new Request('http://127.0.0.1' + GATEWAY_PATH + '?path=' + encodeURIComponent(path), {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

test('external agent API is shaped like /v1/gateway and verifies the token in the plugin', async () => {
  const calls = []
  const dispatch = createGatewayDispatch({
    endpoints: {
      'agent-api/invoke': async (payload) => { calls.push(['invoke', payload]); return { status: 202, invocation: { id: inv, status: 'queued' } } },
      'agent-api/invocation': async (payload) => { calls.push(['status', payload]); return { invocation: { id: payload.id, status: 'succeeded', reply: 'ok' } } },
    },
  })
  const created = await dispatch(request(`/v1/gateway/agents/${agent}/invocations`, {
    headers: { 'x-ot-gateway-token': token, 'idempotency-key': 'k'.repeat(16) }, body: { prompt: 'hello' },
  }))
  assert.equal(created.status, 202)
  assert.deepEqual(await created.json(), { invocation: { id: inv, status: 'queued' } })
  assert.equal(calls[0][1].token, token)
  assert.equal(calls[0][1].prompt, 'hello')
  const polled = await dispatch(request(`/v1/gateway/invocations/${inv}`, {
    method: 'GET', headers: { 'x-ot-gateway-token': token },
  }))
  assert.equal(polled.status, 200)
  assert.equal((await polled.json()).invocation.reply, 'ok')
  const denied = await dispatch(request(`/v1/gateway/agents/${agent}/invocations`, { body: { prompt: 'x' } }))
  assert.equal(denied.status, 401)
})
