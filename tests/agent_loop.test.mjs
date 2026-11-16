import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeKey } from '../runtime/flybot-image/agent-loop.mjs'

test('loadRuntimeKey ignores a missing or empty file', () => {
  assert.equal(loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: '/no/such/runtime-key.json'}), null)
  const empty = loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: 'x'}, () => '')
  assert.equal(empty, null)
})

test('loadRuntimeKey reads origin token hostname and does not throw the token', () => {
  const payload = JSON.stringify({
    origin: 'https://management.test',
    token: 'secret-token-value-0001',
    hostname: 'flybot-abcd1234ef00',
  })
  const loaded = loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: 'x'}, () => payload)
  assert.equal(loaded.origin, 'https://management.test')
  assert.equal(loaded.token, 'secret-token-value-0001')
  assert.equal(loaded.hostname, 'flybot-abcd1234ef00')
})
