// Chat polls inside the user's own DS-Bot: one SQLite file per account, one
// migration, and the polls/<op> endpoints the moved chat page calls. A fresh
// temp volume per boot, so every test starts with an empty poll store.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'

const WS = 'a'.repeat(32)
const OTHER_WS = 'b'.repeat(32)
const CONV = 'c'.repeat(32)

const call = (bot, op, payload) => bot.endpoint(`polls/${op}`, payload)
const ok = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, `${op} failed: ${JSON.stringify(result.error)}`)
  return result.value
}
const fails = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `${op} was expected to fail but returned ${JSON.stringify(result.value)}`)
  assert.equal(result.error.code, code, `${op} error code: ${JSON.stringify(result.error)}`)
  return result.error
}

const created = async (bot, payload = {}) => (await ok(bot, 'create', {
  workspace_id: WS, conversation_id: CONV, question: 'Lunch?', options: ['Yes', 'No'], ...payload,
})).poll

test('migrations are idempotent and this owner keeps its polls across a reboot', async () => {
  const vol = volume()
  const first = await boot(vol)
  const poll = await created(first)
  assert.equal((await ok(first, 'list', { workspace_id: WS, conversation_id: CONV })).items.length, 1)

  // Same volume, fresh plugin boot: migrate runs again and must not lose or duplicate anything.
  const second = await boot(vol)
  const again = (await ok(second, 'get', { workspace_id: WS, id: poll.id })).poll
  assert.equal(again.question, 'Lunch?')
  assert.deepEqual(again.options.map((option) => option.text), ['Yes', 'No'])
  assert.equal((await ok(second, 'list', { workspace_id: WS, conversation_id: CONV })).items.length, 1)

  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'polls', 'polls.sqlite3'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('polls') && tables.includes('poll_options') && tables.includes('poll_votes'), tables.join(','))
  const applied = db.prepare("SELECT COUNT(*) AS n FROM ot_feature_migrations WHERE feature='polls'").get()
  assert.equal(applied.n, 1)
  db.close()
})

test('create, get and list page the oldest first with an opaque cursor', async () => {
  const bot = await boot()
  const first = await created(bot, { question: 'First' })
  const second = await created(bot, { question: 'Second' })
  const third = await created(bot, { question: 'Third' })
  assert.equal(first.status, 'open')
  assert.equal(first.total, 0)
  assert.equal(first.voter_count, 0)
  assert.deepEqual(first.votes, [])
  assert.deepEqual(first.viewer_votes, [])
  assert.equal(first.created_by, first.owner_id)
  assert.ok(first.created > 0)

  const page = await ok(bot, 'list', { workspace_id: WS, conversation_id: CONV, limit: 2 })
  assert.deepEqual(page.items.map((poll) => poll.id), [first.id, second.id])
  assert.equal(page.next_cursor, second.id)
  const rest = await ok(bot, 'list', { workspace_id: WS, conversation_id: CONV, limit: 2, cursor: page.next_cursor })
  assert.deepEqual(rest.items.map((poll) => poll.id), [third.id])
  assert.equal(rest.next_cursor, null)
  assert.deepEqual((await ok(bot, 'list', { workspace_id: WS, conversation_id: CONV, limit: 10 })).items.map((poll) => poll.id),
    [first.id, second.id, third.id])
  await fails(bot, 'list', { workspace_id: WS, conversation_id: CONV, cursor: 'f'.repeat(32) }, 'polls/not-found')
  await fails(bot, 'list', { workspace_id: WS }, 'polls/invalid')
  await fails(bot, 'list', { workspace_id: WS, conversation_id: CONV, limit: 0 }, 'polls/invalid')
  await fails(bot, 'list', { workspace_id: WS, conversation_id: CONV, limit: 101 }, 'polls/invalid')
})

test('a single-choice vote replaces, and repeating the same vote is idempotent', async () => {
  const bot = await boot()
  const poll = await created(bot)
  const [yes, no] = poll.options.map((option) => option.id)
  const voted = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes] })).poll
  assert.deepEqual(voted.votes, [yes])
  assert.equal(voted.total, 1)
  assert.equal(voted.voter_count, 1)
  assert.deepEqual(voted.options.map((option) => option.count), [1, 0])

  const repeated = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes] })).poll
  assert.equal(repeated.total, 1)
  assert.deepEqual(repeated.options.map((option) => option.count), [1, 0])

  const changed = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [no] })).poll
  assert.deepEqual(changed.votes, [no])
  assert.equal(changed.total, 1)
  assert.deepEqual(changed.options.map((option) => option.count), [0, 1])

  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes, no] }, 'polls/invalid')
})

test('a multi-choice vote adds selections and dedupes the same selection', async () => {
  const bot = await boot()
  const poll = await created(bot, { multi_select: true })
  const [yes, no] = poll.options.map((option) => option.id)
  const one = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes] })).poll
  assert.equal(one.total, 1)
  const both = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [no] })).poll
  assert.deepEqual(both.votes, [yes, no])
  assert.equal(both.total, 2)
  assert.deepEqual(both.options.map((option) => option.count), [1, 1])
  const repeated = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes, no] })).poll
  assert.equal(repeated.total, 2)
  assert.deepEqual(repeated.options.map((option) => option.count), [1, 1])
})

test('unknown, foreign and repeated option ids are refused and record no votes', async () => {
  const bot = await boot()
  const poll = await created(bot)
  const other = await created(bot, { question: 'Other', options: ['A', 'B'] })
  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: ['missing'] }, 'polls/invalid')
  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [other.options[0].id] }, 'polls/invalid')
  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [] }, 'polls/invalid')
  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [poll.options[0].id, poll.options[0].id] }, 'polls/invalid')
  const unchanged = (await ok(bot, 'get', { workspace_id: WS, id: poll.id })).poll
  assert.equal(unchanged.total, 0)
})

test('a closed poll or a poll past its close time refuses votes', async () => {
  const bot = await boot()
  const closing = await created(bot, { closes: Math.floor(Date.now() / 1000) - 1 })
  await fails(bot, 'vote', { workspace_id: WS, id: closing.id, option_ids: [closing.options[0].id] }, 'polls/closed')

  const poll = await created(bot)
  const closed = (await ok(bot, 'close', { workspace_id: WS, id: poll.id })).poll
  assert.equal(closed.status, 'closed')
  await fails(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [poll.options[0].id] }, 'polls/closed')
  const again = (await ok(bot, 'close', { workspace_id: WS, id: poll.id })).poll
  assert.equal(again.status, 'closed')
})

test('delete removes the poll and cascades to its options and votes', async () => {
  const bot = await boot()
  const poll = await created(bot)
  await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [poll.options[0].id] })
  assert.deepEqual(await ok(bot, 'delete', { workspace_id: WS, id: poll.id }), { deleted: true })
  await fails(bot, 'get', { workspace_id: WS, id: poll.id }, 'polls/not-found')
  await fails(bot, 'delete', { workspace_id: WS, id: poll.id }, 'polls/not-found')
  const vol = bot.vol
  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'polls', 'polls.sqlite3'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poll_options WHERE poll_id=?').get(poll.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id=?').get(poll.id).n, 0)
  db.close()
})

test('an anonymous poll hides voter identities but keeps counts and the viewer vote', async () => {
  const bot = await boot()
  const poll = await created(bot, { anonymous: true })
  const [yes] = poll.options.map((option) => option.id)
  const voted = (await ok(bot, 'vote', { workspace_id: WS, id: poll.id, option_ids: [yes] })).poll
  assert.deepEqual(voted.votes, [yes])
  assert.deepEqual(voted.options[0].voters, [])
  assert.equal(voted.options[0].count, 1)
  assert.equal(voted.total, 1)
  const viewed = (await ok(bot, 'get', { workspace_id: WS, id: poll.id })).poll
  assert.deepEqual(viewed.options[0].voters, [])
  assert.doesNotMatch(JSON.stringify(viewed), /"voters":\["/, 'no voter id leaks in an anonymous view')

  const publicPoll = await created(bot, { question: 'Public' })
  await ok(bot, 'vote', { workspace_id: WS, id: publicPoll.id, option_ids: [publicPoll.options[0].id] })
  const visible = (await ok(bot, 'get', { workspace_id: WS, id: publicPoll.id })).poll
  assert.deepEqual(visible.options[0].voters, [visible.created_by])
})

test('another workspace cannot read, list, vote on, close or delete this poll', async () => {
  const bot = await boot()
  const poll = await created(bot)
  await fails(bot, 'get', { workspace_id: OTHER_WS, id: poll.id }, 'polls/not-found')
  assert.deepEqual((await ok(bot, 'list', { workspace_id: OTHER_WS, conversation_id: CONV })).items, [])
  await fails(bot, 'vote', { workspace_id: OTHER_WS, id: poll.id, option_ids: [poll.options[0].id] }, 'polls/not-found')
  await fails(bot, 'close', { workspace_id: OTHER_WS, id: poll.id }, 'polls/not-found')
  await fails(bot, 'delete', { workspace_id: OTHER_WS, id: poll.id }, 'polls/not-found')
  assert.notEqual((await ok(bot, 'get', { workspace_id: WS, id: poll.id })).poll, null)
})

test('oversize, duplicate and too-few options are refused without storing a poll', async () => {
  const bot = await boot()
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'x'.repeat(501), options: ['Yes', 'No'] }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'Q', options: ['x'.repeat(201), 'No'] }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'Q', options: ['Only one'] }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'Q', options: ['Yes', 'no', 'YES'] }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'Q', options: ['Yes', '   '] }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: WS, conversation_id: CONV, question: 'Q', options: Array.from({ length: 21 }, (_, i) => `Option ${i}`) }, 'polls/invalid')
  await fails(bot, 'create', { workspace_id: 'nope', conversation_id: CONV, question: 'Q', options: ['Yes', 'No'] }, 'polls/invalid')
  assert.deepEqual((await ok(bot, 'list', { workspace_id: WS, conversation_id: CONV })).items, [])
})
