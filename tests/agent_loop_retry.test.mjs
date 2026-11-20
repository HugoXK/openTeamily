import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import {
  backoffDelay, isTransient, parseRetryAfter, main, runCycle, TRANSIENT_STATUS,
} from '../runtime/flybot-image/agent-loop.mjs'
import { sendNotice, RUNTIME_WAIT_ERRORS } from '../openteamily/static/chat/app.mjs'

function keyEnv(origin) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ot-loop-'))
  const file = path.join(dir, 'key.json')
  writeFileSync(file, JSON.stringify({ origin, token: 'synthetic-token-0123456789abcdef', hostname: 'flybot-test' }))
  return { OPENTEAMILY_RUNTIME_KEY_FILE: file }
}

const failure = (status, extra = {}) => Object.assign(new Error('agent request failed'), { status, ...extra })

test('classifies transient vs fatal failures', () => {
  for (const status of [408, 429, 502, 503, 504]) assert.equal(isTransient(failure(status)), true, String(status))
  for (const status of [400, 401, 403, 404, 409, 500]) assert.equal(isTransient(failure(status)), false, String(status))
  assert.equal(isTransient(Object.assign(new Error('x'), { transport: true })), true)
  assert.equal(isTransient(new Error('Skill integrity or permissions rejected')), false)
  assert.equal(TRANSIENT_STATUS.has(401), false)
})

test('backoff is exponential, capped and jittered; Retry-After honored within the cap', () => {
  assert.equal(backoffDelay(1, { random: () => 0 }), 500)
  assert.equal(backoffDelay(1, { random: () => 0.999999 }), 999)
  assert.equal(backoffDelay(4, { random: () => 0 }), 4000)
  assert.equal(backoffDelay(30, { random: () => 0.999999 }), 59999)
  assert.ok(backoffDelay(100, { random: () => 1 }) <= 60000)
  assert.equal(backoffDelay(1, { random: () => 0, retryAfterMs: 7000 }), 7000)
  assert.equal(backoffDelay(1, { random: () => 0, retryAfterMs: 600000 }), 60000)
  assert.equal(parseRetryAfter('12'), 12000)
  assert.equal(parseRetryAfter(new Date(10000 + 5000).toUTCString(), 10000) <= 5000, true)
  assert.equal(parseRetryAfter('soon'), null)
  assert.equal(parseRetryAfter(null), null)
})

test('main resumes after transient failures and resets the counter', async () => {
  const outcomes = [failure(502), Object.assign(new Error('t'), { transport: true }), failure(429, { retryAfterMs: 3000 }), null, failure(503), 'stop']
  const sleeps = []
  const logs = []
  let cycles = 0
  const code = await main(keyEnv('http://127.0.0.1:9'), m => logs.push(m), {
    random: () => 0,
    sleep: async ms => { sleeps.push(ms) },
    cycle: async () => {
      const next = outcomes[cycles++]
      if (next === 'stop') throw failure(401)
      if (next) throw next
    },
  })
  assert.equal(code, 1)
  assert.equal(cycles, 6)
  // 502 -> 500ms, transport -> 1000ms, 429 Retry-After 3s, success -> poll 2s, 503 after reset -> 500ms
  assert.deepEqual(sleeps, [500, 1000, 3000, 2000, 500])
  assert.ok(logs.some(m => m.includes('polling resumed')))
  assert.ok(logs.at(-1).includes('HTTP 401') && logs.at(-1).includes('stopping'))
  assert.ok(!logs.join('\n').includes('synthetic-token'))
})

for (const status of [401, 403, 409]) {
  test(`main stops immediately on ${status}`, async () => {
    let cycles = 0
    const sleeps = []
    const code = await main(keyEnv('http://127.0.0.1:9'), () => {}, {
      sleep: async ms => { sleeps.push(ms) }, cycle: async () => { cycles += 1; throw failure(status) },
    })
    assert.equal(code, 1)
    assert.equal(cycles, 1)
    assert.deepEqual(sleeps, [])
  })
}

test('retry attempts are bounded', async () => {
  let cycles = 0
  const env = { ...keyEnv('http://127.0.0.1:9'), OPENTEAMILY_AGENT_RETRY_LIMIT: '3' }
  const code = await main(env, () => {}, { random: () => 0, sleep: async () => {}, cycle: async () => { cycles += 1; throw failure(503) } })
  assert.equal(code, 1)
  assert.equal(cycles, 4)
})

test('once mode keeps single-shot semantics', async () => {
  let cycles = 0
  const env = { ...keyEnv('http://127.0.0.1:9'), OPENTEAMILY_AGENT_ONCE: '1' }
  const code = await main(env, () => {}, { sleep: async () => {}, cycle: async () => { cycles += 1; throw failure(502) } })
  assert.equal(code, 1)
  assert.equal(cycles, 1)
})

test('real loopback: connection refused then 502 then recovery reconnects with connect+heartbeat', async () => {
  const seen = []
  let mode = 'down'
  const server = createServer((req, res) => {
    seen.push(req.method + ' ' + req.url)
    if (mode === '502') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.url === '/v1/agent/tasks' ? JSON.stringify({ items: [] }) : '{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))  // nothing listening: ECONNREFUSED
  const origin = 'http://127.0.0.1:' + port
  let cycles = 0
  const sleeps = []
  const code = await main(keyEnv(origin), () => {}, {
    random: () => 0,
    sleep: async ms => {
      sleeps.push(ms)
      if (sleeps.length === 1) { mode = '502'; await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)) }
      if (sleeps.length === 2) mode = 'up'
    },
    cycle: async config => {
      cycles += 1
      if (cycles === 4) throw failure(403)
      return runCycle(config)
    },
  })
  await new Promise(resolve => server.close(resolve))
  assert.equal(code, 1)
  assert.deepEqual(sleeps.slice(0, 2), [500, 1000])
  assert.ok(seen.includes('POST /v1/agent/connect'))
  assert.ok(seen.includes('POST /v1/agent/heartbeat'))
  assert.ok(seen.includes('GET /v1/agent/tasks'))
})

test('chat send notice explains personal runtime states', () => {
  assert.equal(sendNotice({ error_code: 'no_agent' }).kind, 'error')
  assert.equal(sendNotice({ error_code: null }).text, '已发送。')
  assert.equal(sendNotice({ error_code: 'runtime_starting' }).kind, 'ok')
  assert.ok(sendNotice({ error_code: 'runtime_capacity' }).text.includes('名额已满'))
  assert.ok(sendNotice({ error_code: 'runtime_unavailable' }).text.includes('联系管理员'))
  assert.deepEqual(Object.keys(RUNTIME_WAIT_ERRORS).sort(), ['runtime_capacity', 'runtime_starting', 'runtime_unavailable'])
})
