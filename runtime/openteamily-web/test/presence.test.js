// Presence and typing leases (#399) inside this user's DS-Bot: a lease says the
// owner is online in, or typing in, one workspace conversation. Leases are
// ephemeral rows with an explicit expiry; readers treat an expired row as absent.
// No page calls these routes yet, so this file pins the HTTP contract and the
// lease semantics a later "对方正在输入" slice will build on.
import assert from 'node:assert/strict'
import test from 'node:test'
import { boot, WS } from './helpers.js'

const WS_B = 'b'.repeat(32)
const C1 = 'c1-conversation'
const C2 = 'c2-conversation'
const base = (workspace = WS, conversation = C1) => `/v1/workspaces/${workspace}/conversations/${conversation}/presence`

// The plugin's generic dispatcher answers 404 when a feature has no v1 endpoint;
// turn that into the legacy {status, body} shape so a missing route reads as a
// behaviour difference (404 !== 200), not as a thrown module error.
async function call(bot, method, path, body) {
  const result = await bot.endpoint('presence/v1', { method, path, body })
  if (result.ok) return { status: result.value.status ?? 200, body: result.value.body ?? {} }
  if (result.error?.code === 'openteamily/not-found') {
    return { status: 404, body: { error: { code: 'not_moved', message: result.error.message } } }
  }
  throw new Error(`presence/v1 failed: ${JSON.stringify(result.error)}`)
}

function freezeClock(t, seconds = 1800000000) {
  const real = Date.now
  let now = seconds * 1000
  Date.now = () => now
  t.after(() => { Date.now = real })
  return (next) => { now = next * 1000 }
}

test('one heartbeat per user and kind, repeated beats extend the same lease monotonically', async (t) => {
  const clock = freezeClock(t)
  const bot = await boot()
  const first = await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: 30 })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.presence.user_id, 'owner')
  assert.equal(first.body.presence.kind, 'online')
  assert.equal(first.body.presence.expires, 1800000030)
  assert.equal(first.body.presence.updated, 1800000000)

  clock(1800000010)
  const second = await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: 30 })
  assert.equal(second.body.presence.expires, 1800000040)
  const list = await call(bot, 'GET', base())
  assert.equal(list.status, 200, JSON.stringify(list.body))
  assert.equal(list.body.presence.length, 1)
  assert.equal(list.body.presence[0].expires, 1800000040)

  // A late, out-of-order heartbeat must not shorten the lease or move it back.
  clock(1800000000)
  const late = await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: 30 })
  assert.equal(late.body.presence.expires, 1800000040)
  assert.equal(late.body.presence.updated, 1800000010)
  assert.equal((await call(bot, 'GET', base())).body.presence.length, 1)
})

test('an expired lease disappears from the list and no history is invented', async (t) => {
  const clock = freezeClock(t)
  const bot = await boot()
  assert.equal((await call(bot, 'POST', base(), { kind: 'typing', ttl_seconds: 5 })).status, 200)
  clock(1800000004)
  const active = await call(bot, 'GET', base())
  assert.equal(active.body.presence.length, 1)
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, true)
  clock(1800000005)
  const expired = await call(bot, 'GET', base())
  assert.equal(expired.body.presence.length, 0)
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, false)
  // There is no durable presence history to read back later.
  assert.equal((await call(bot, 'GET', base() + '/history')).status, 404)
})

test('clear removes only the named kind of the caller and repeating it is harmless', async (t) => {
  freezeClock(t)
  const bot = await boot()
  await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: 60 })
  await call(bot, 'POST', base(), { kind: 'typing', ttl_seconds: 60 })
  const one = await call(bot, 'POST', base() + '/clear', { kind: 'typing' })
  assert.equal(one.status, 200, JSON.stringify(one.body))
  assert.equal(one.body.cleared, 1)
  assert.deepEqual((await call(bot, 'GET', base())).body.presence.map((row) => row.kind), ['online'])
  assert.equal((await call(bot, 'POST', base() + '/clear', { kind: 'typing' })).body.cleared, 0)
  const all = await call(bot, 'POST', base() + '/clear', {})
  assert.equal(all.body.cleared, 1)
  assert.equal((await call(bot, 'GET', base())).body.presence.length, 0)
})

test('someone else cannot renew or clear your lease', async (t) => {
  freezeClock(t)
  const bot = await boot()
  const other = await call(bot, 'POST', base(), { kind: 'online', user_id: 'mallory' })
  assert.equal(other.status, 403, JSON.stringify(other.body))
  assert.equal((await call(bot, 'GET', base())).body.presence.length, 0)
  await call(bot, 'POST', base(), { kind: 'online' })
  const steal = await call(bot, 'POST', base() + '/clear', { user_id: 'mallory' })
  assert.equal(steal.status, 403, JSON.stringify(steal.body))
  assert.equal((await call(bot, 'GET', base())).body.presence.length, 1)
})

test('typing is kind-, conversation- and workspace-aware', async (t) => {
  const clock = freezeClock(t)
  const bot = await boot()
  await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: 60 })
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, false)
  await call(bot, 'POST', base(), { kind: 'typing', ttl_seconds: 10 })
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, true)
  clock(1800000009)
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, true)
  clock(1800000010)
  assert.equal((await call(bot, 'GET', base() + '/typing/owner')).body.typing, false)
  assert.equal((await call(bot, 'GET', base(WS, C2) + '/typing/owner')).body.typing, false)
  assert.equal((await call(bot, 'GET', base(WS_B, C1) + '/typing/owner')).body.typing, false)
})

test('leases are isolated by workspace and conversation', async (t) => {
  freezeClock(t)
  const bot = await boot()
  await call(bot, 'POST', base(WS, C1), { kind: 'typing', ttl_seconds: 60 })
  assert.equal((await call(bot, 'GET', base(WS, C1))).body.presence.length, 1)
  assert.equal((await call(bot, 'GET', base(WS, C2))).body.presence.length, 0)
  assert.equal((await call(bot, 'GET', base(WS_B, C1))).body.presence.length, 0)
  await call(bot, 'POST', base(WS, C2), { kind: 'typing', ttl_seconds: 60 })
  assert.equal((await call(bot, 'GET', base(WS, C2))).body.presence.length, 1)
  const clear = await call(bot, 'POST', base(WS, C1) + '/clear', {})
  assert.equal(clear.body.cleared, 1)
  assert.equal((await call(bot, 'GET', base(WS, C1))).body.presence.length, 0)
  assert.equal((await call(bot, 'GET', base(WS, C2))).body.presence.length, 1)
})

test('invalid kinds, ttls, fields and identifiers are refused without a write', async (t) => {
  freezeClock(t)
  const bot = await boot()
  for (const kind of ['away', 'ONLINE', '', null, 1]) {
    const bad = await call(bot, 'POST', base(), { kind })
    assert.equal(bad.status, 400, `${JSON.stringify(kind)} -> ${bad.status}`)
  }
  for (const ttl of [0, -1, 3601, '30', true, 1.5, null]) {
    const bad = await call(bot, 'POST', base(), { kind: 'online', ttl_seconds: ttl })
    assert.equal(bad.status, 400, `${JSON.stringify(ttl)} -> ${bad.status}`)
  }
  assert.equal((await call(bot, 'POST', base(), { kind: 'online', extra: true })).status, 400)
  assert.equal((await call(bot, 'POST', base(), { kind: 'online', user_id: 'x'.repeat(129) })).status, 400)
  assert.equal((await call(bot, 'POST', base('not-a-workspace'), { kind: 'online' })).status, 404)
  assert.equal((await call(bot, 'POST', base(WS, 'c'.repeat(81)), { kind: 'online' })).status, 404)
  assert.equal((await call(bot, 'POST', base() + '/clear', { kind: 'away' })).status, 400)
  assert.equal((await call(bot, 'GET', base() + '/typing/' + 'u'.repeat(129))).status, 404)
  assert.equal((await call(bot, 'GET', base())).body.presence.length, 0)
})
