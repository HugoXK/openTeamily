// Deterministic, explainable ranking for Discover works and agents inside this
// user's DS-Bot (#462). The module is pure: the caller passes the candidates,
// the current time and the caller's workspace; the same inputs must always give
// the same order and every result must explain its own score.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_AGENT_WEIGHTS,
  DEFAULT_RECENCY_HALF_LIFE,
  DEFAULT_WORK_WEIGHTS,
  MAX_LIMIT,
  explain,
  paginate,
  rankAgents,
  rankWorks,
} from '../features/discover/ranking.js'

const NOW = 1800000000
const WS = 'ws_caller'

const work = (id, author = 'alice', created = NOW, extra = {}) => ({
  id,
  title: id.toUpperCase(),
  author_id: author,
  created,
  workspace_id: WS,
  listed: true,
  ...extra,
})

const agent = (id, creator = 'alice', created = NOW, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  creator_id: creator,
  created,
  workspace_id: WS,
  listed: true,
  ...extra,
})

const ids = (ranked) => ranked.map((item) => item.id)
const byId = (ranked) => new Map(ranked.map((item) => [item.id, item]))
const scores = (ranked) => ranked.map((item) => item.score)
const zeroWeights = { recency: 0, engagement: 0, follow: 0, seen_penalty: 1, author_cap: 5 }

test('the same fixture ranks identically twice and does not depend on input order', () => {
  const items = [
    work('w2', 'alice', NOW - 100, { likes: 3 }),
    work('w1', 'bob', NOW - 50, { collects: 1 }),
    work('w3', 'carol', NOW - 200, { comments: 2 }),
  ]
  const snapshot = JSON.stringify(items)
  const first = rankWorks(items, NOW, { workspaceId: WS })
  const second = rankWorks(items, NOW, { workspaceId: WS })
  const reversed = rankWorks([...items].reverse(), NOW, { workspaceId: WS })
  assert.deepEqual(ids(first), ids(second))
  assert.deepEqual(ids(first), ids(reversed))
  assert.deepEqual(scores(first), scores(second))
  // The candidates are copied, not annotated in place.
  assert.equal(JSON.stringify(items), snapshot)
  for (const item of first) {
    assert.equal(typeof item.score, 'number')
    assert.equal(typeof item.reasons, 'object')
  }
})

test('ranking never reads the clock', () => {
  const realNow = Date.now
  Date.now = () => {
    throw new Error('Date.now() was called while ranking')
  }
  try {
    const ranked = rankWorks([work('a'), work('b', 'bob', NOW - 60)], NOW, { workspaceId: WS })
    assert.deepEqual(ids(ranked), ['a', 'b'])
  } finally {
    Date.now = realNow
  }
})

test('recency decays with age and clamps a future timestamp to one', () => {
  const old = work('old', 'alice', NOW - 10 * DEFAULT_RECENCY_HALF_LIFE)
  const fresh = work('new', 'bob', NOW)
  const future = work('future', 'carol', NOW + 3600)
  const rows = byId(rankWorks([old, fresh, future], NOW, { workspaceId: WS, weights: { author_cap: 5 } }))
  assert.ok(rows.get('old').reasons.recency < rows.get('new').reasons.recency)
  assert.ok(Math.abs(rows.get('new').reasons.recency - 1) < 1e-12)
  assert.ok(Math.abs(rows.get('future').reasons.recency - 1) < 1e-12)
  assert.equal(ids(rankWorks([old, fresh, future], NOW, { workspaceId: WS, weights: { author_cap: 5 } })).at(-1), 'old')
})

test('engagement counts raise the score and missing metrics count as zero', () => {
  const low = work('low', 'alice')
  const liked = work('liked', 'bob', NOW, { likes: 10 })
  const rich = work('rich', 'carol', NOW, { likes: 1, collects: 2, comments: 1 })
  const rows = byId(rankWorks([low, liked, rich], NOW, { workspaceId: WS, weights: { author_cap: 5 } }))
  assert.ok(rows.get('liked').reasons.engagement > 0)
  assert.ok(rows.get('rich').reasons.engagement > 0)
  assert.ok(rows.get('liked').score > rows.get('low').score)
  assert.ok(rows.get('rich').score > rows.get('low').score)
  assert.equal(rows.get('low').reasons.engagement, 0)

  const implicit = work('implicit', 'alice')
  const explicit = work('explicit', 'bob', NOW, { likes: 0, collects: 0, comments: 0 })
  const nulls = work('nulls', 'carol', NOW, { likes: null, collects: null, comments: null })
  const nullRows = byId(rankWorks([implicit, explicit, nulls], NOW, { workspaceId: WS, weights: { author_cap: 5 } }))
  for (const id of ['implicit', 'explicit', 'nulls']) {
    assert.equal(nullRows.get(id).reasons.engagement, 0)
    assert.ok(Math.abs(nullRows.get(id).score - nullRows.get('implicit').score) < 1e-12)
  }
})

test('a followed author adds exactly the follow weight', () => {
  const alice = work('w-alice', 'alice', NOW, { likes: 2 })
  const bob = work('w-bob', 'bob', NOW, { likes: 2 })
  const baseline = byId(rankWorks([alice, bob], NOW, { workspaceId: WS, weights: { author_cap: 5 } }))
  const followed = byId(rankWorks([alice, bob], NOW, { workspaceId: WS, followingAuthors: ['alice'], weights: { author_cap: 5 } }))
  assert.equal(baseline.get('w-alice').reasons.follow, 0)
  assert.equal(followed.get('w-alice').reasons.follow, 1)
  assert.ok(Math.abs(followed.get('w-alice').score - baseline.get('w-alice').score - 1) < 1e-12)
  assert.equal(followed.get('w-bob').reasons.follow, 0)
  const asString = byId(rankWorks([alice, bob], NOW, { workspaceId: WS, followingAuthors: 'alice', weights: { author_cap: 5 } }))
  assert.equal(asString.get('w-alice').reasons.follow, 1)
})

test('a seen item is demoted, never excluded', () => {
  const seen = work('seen', 'alice', NOW, { likes: 1 })
  const fresh = work('fresh', 'bob', NOW, { likes: 1 })
  const baseline = byId(rankWorks([seen, fresh], NOW, { workspaceId: WS, weights: { author_cap: 5 } }))
  const demoted = byId(rankWorks([seen, fresh], NOW, { workspaceId: WS, seenIds: ['seen'], weights: { author_cap: 5, seen_penalty: 0.5 } }))
  assert.ok(demoted.has('seen'))
  assert.equal(demoted.get('seen').reasons.seen_penalty, 0.5)
  assert.equal(demoted.get('fresh').reasons.seen_penalty, 1)
  assert.ok(Math.abs(demoted.get('seen').score - baseline.get('seen').score * 0.5) < 1e-12)
  const zeroed = byId(rankWorks([seen, fresh], NOW, { workspaceId: WS, seenIds: ['seen'], weights: { author_cap: 5, seen_penalty: 0 } }))
  assert.ok(zeroed.has('seen'))
  assert.equal(zeroed.get('seen').score, 0)
})

test('an author cap bounds how many items one author can contribute', () => {
  const items = [0, 1, 2, 3].map((index) => work(`a${index}`, 'alice', NOW - index))
  items.push(work('b1', 'bob', NOW - 100), work('c1', 'carol', NOW - 200))
  const capped = rankWorks(items, NOW, { workspaceId: WS, weights: { author_cap: 1 }, limit: 3 })
  assert.equal(capped.length, 3)
  assert.deepEqual([...new Set(capped.map((item) => item.author_id))].sort(), ['alice', 'bob', 'carol'])
  assert.equal(capped.filter((item) => item.author_id === 'alice').length, 1)

  const wider = rankWorks(items, NOW, { workspaceId: WS, weights: { author_cap: 2 }, limit: 3 })
  assert.equal(wider.filter((item) => item.author_id === 'alice').length, 2)

  const onlyAlice = rankWorks(items.slice(0, 4), NOW, { workspaceId: WS, weights: { author_cap: 1 }, limit: 3 })
  assert.deepEqual(onlyAlice.map((item) => item.id), ['a0'])
})

test('ties break by created descending then id ascending', () => {
  const equal = [work('b', 'bob'), work('a', 'alice'), work('c', 'carol')]
  assert.deepEqual(ids(rankWorks(equal, NOW, { workspaceId: WS, weights: { author_cap: 5 } })), ['a', 'b', 'c'])

  const items = [
    work('old', 'alice', NOW - 10),
    work('new', 'bob', NOW),
    work('a', 'carol', NOW),
    work('b', 'dave', NOW),
  ]
  assert.deepEqual(ids(rankWorks(items, NOW, { workspaceId: WS, weights: zeroWeights })), ['a', 'b', 'new', 'old'])
})

test('every result explains its score with components that add up', () => {
  const items = [
    work('w1', 'alice', NOW, { likes: 2 }),
    work('w2', 'bob', NOW - 500, { collects: 1 }),
    work('w3', 'carol', NOW, { comments: 3 }),
  ]
  const ranked = rankWorks(items, NOW, {
    workspaceId: WS,
    followingAuthors: ['alice'],
    seenIds: ['w2'],
    weights: { author_cap: 5, seen_penalty: 0.5 },
  })
  for (const item of ranked) {
    const parts = explain(item)
    assert.deepEqual(parts, item.reasons)
    assert.ok(Math.abs(parts.recency + parts.engagement + parts.follow - parts.base) < 1e-12)
    assert.ok(Math.abs(parts.base * parts.seen_penalty - parts.score) < 1e-12)
    assert.ok(Math.abs(parts.score - item.score) < 1e-12)
  }
  assert.throws(() => explain({ id: 'w' }), (error) => error.code === 'discover/ranking-invalid')
  assert.throws(() => explain(null), (error) => error.code === 'discover/ranking-invalid')
})

test('only this workspace\'s listed works and agents are ranked', () => {
  const works = [
    work('mine'),
    work('foreign', 'bob', NOW, { workspace_id: 'ws_other' }),
    work('hidden', 'carol', NOW, { listed: false }),
    { ...work('unlisted', 'dave'), listed: undefined },
    // A foreign row that is malformed must be dropped before validation, not fail the call.
    { id: 'foreign-broken', created: 'not-a-number' },
  ]
  assert.deepEqual(ids(rankWorks(works, NOW, { workspaceId: WS, limit: 10 })), ['mine'])

  const agents = [
    agent('mine-agent'),
    agent('foreign-agent', 'bob', NOW, { workspace_id: 'ws_other' }),
    agent('hidden-agent', 'carol', NOW, { listed: false }),
  ]
  assert.deepEqual(ids(rankAgents(agents, NOW, { workspaceId: WS, limit: 10 })), ['mine-agent'])
})

test('paginate round-trips an opaque cursor and rejects malformed ones', () => {
  const items = [0, 1, 2, 3, 4].map((index) => work(`w${index}`, `author${index}`))
  const ranked = rankWorks(items, NOW, { workspaceId: WS, weights: { author_cap: 5 }, limit: 5 })
  const first = paginate(ranked, null, 2)
  assert.deepEqual(ids(first.items), ids(ranked.slice(0, 2)))
  assert.equal(first.cursor, null)
  assert.equal(typeof first.next_cursor, 'string')
  assert.notEqual(first.next_cursor, '2')
  const second = paginate(ranked, first.next_cursor, 2)
  assert.equal(second.cursor, first.next_cursor)
  assert.deepEqual(ids(second.items), ids(ranked.slice(2, 4)))
  const third = paginate(ranked, second.next_cursor, 2)
  assert.deepEqual(ids(third.items), ids(ranked.slice(4)))
  assert.equal(third.next_cursor, null)
  assert.deepEqual(ids([...first.items, ...second.items, ...third.items]), ids(ranked))
  assert.deepEqual(ids(paginate(ranked, '', 2).items), ids(first.items))
  assert.deepEqual(paginate([], null, 10), { items: [], next_cursor: null, cursor: null })
  for (const cursor of ['not-a-cursor', '!!!!', '2', 123]) {
    assert.throws(() => paginate(ranked, cursor, 2), (error) => error.code === 'discover/ranking-invalid')
  }
  for (const limit of [0, -1, 101, '2', true, null]) {
    assert.throws(() => paginate(ranked, null, limit), (error) => error.code === 'discover/ranking-invalid')
  }
})

test('invalid limits, weights, items and now are refused', () => {
  const items = [work('w')]
  const invalid = (options) => assert.throws(
    () => rankWorks(items, NOW, { workspaceId: WS, ...options }),
    (error) => error.code === 'discover/ranking-invalid',
  )
  for (const weights of [
    { unknown: 1 },
    { recency: -0.1 },
    { recency: Number.NaN },
    { recency: Number.POSITIVE_INFINITY },
    { follow: true },
    { follow: 10001 },
    { seen_penalty: 1.5 },
    { author_cap: 0 },
    { author_cap: 2.5 },
    [],
  ]) invalid({ weights })
  for (const limit of [0, -1, 101, '5', true, null]) invalid({ limit })

  assert.throws(() => rankWorks(items, 'now', { workspaceId: WS }), (error) => error.code === 'discover/ranking-invalid')
  assert.throws(() => rankWorks(items, NOW, {}), (error) => error.code === 'discover/ranking-invalid')

  const badItems = [
    [work('w', 'alice', NOW, { author_id: undefined, creator_id: undefined })],
    [{ id: 'w', author_id: 'alice', workspace_id: WS, listed: true }],
    [{ author_id: 'alice', created: NOW, workspace_id: WS, listed: true }],
    [work(''), work('ok', 'bob')],
    [work('w', '')],
    [work('w', 'alice', 'now')],
    [work('w'), work('w', 'bob')],
    [null],
    ['not-a-mapping'],
  ]
  for (const list of badItems) {
    assert.throws(() => rankWorks(list, NOW, { workspaceId: WS }), (error) => error.code === 'discover/ranking-invalid')
  }

  assert.throws(() => rankAgents([{ id: 'a', name: 'A', created: NOW, workspace_id: WS, listed: true }], NOW, { workspaceId: WS }),
    (error) => error.code === 'discover/ranking-invalid')
  assert.equal(DEFAULT_WORK_WEIGHTS.author_cap, 3)
  assert.equal(DEFAULT_AGENT_WEIGHTS.author_cap, 3)
  assert.equal(MAX_LIMIT, 100)
  assert.equal(typeof DEFAULT_RECENCY_HALF_LIFE, 'number')
})
