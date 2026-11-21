// Chat polls: one owner's polls, options and votes, stored on this user's own
// DS-Bot volume under /data/openteamily/features/polls/. It replaces the
// platform module `openteamily/polls.py`, which had no route and was never
// reachable; this is the same capability behind the plugin endpoint contract
// (docs/DSBOT_PLUGIN_ARCHITECTURE.md §2.1).
//
// The page `chat` is already in `openteamily/dsbot_routes.json` `moved_pages`
// and chat turns run in this DS-Bot, so poll data has to live here too.
//
// Scope is one account: defineFeature hands us that owner and every statement
// is filtered by owner_id, so a stale row left on the volume by someone else is
// invisible and cannot be voted on, closed or deleted. `workspace_id` and
// `conversation_id` are opaque navigation keys from the moved page; this store
// does not resolve them against platform tables (a per-user volume has none).
//
// One deliberate narrowing against the platform module this replaces: the only
// voter on this volume is the account owner. Cross-member voting in a Bot
// Social conversation would have to record other members' votes on the
// conversation server, not on one participant's volume, so it is out of scope
// here and not claimed.
//
// Endpoints: polls/<op> — create, get, list, vote, close, delete.
import { FeatureError, HEX32, newId, nowSeconds } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'

export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS polls (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 created_by TEXT NOT NULL,
 question TEXT NOT NULL,
 multi_select INTEGER NOT NULL DEFAULT 0 CHECK(multi_select IN (0,1)),
 anonymous INTEGER NOT NULL DEFAULT 0 CHECK(anonymous IN (0,1)),
 closes INTEGER,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS poll_owner_conversation
 ON polls(owner_id, workspace_id, conversation_id, created);
CREATE INDEX IF NOT EXISTS poll_owner_created ON polls(owner_id, workspace_id, created);
CREATE TABLE IF NOT EXISTS poll_options (
 id TEXT PRIMARY KEY,
 poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 text TEXT NOT NULL,
 UNIQUE(poll_id, position));
CREATE INDEX IF NOT EXISTS poll_option_order ON poll_options(poll_id, position, id);
CREATE TABLE IF NOT EXISTS poll_votes (
 poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY(poll_id, option_id, user_id));
CREATE INDEX IF NOT EXISTS poll_vote_user ON poll_votes(poll_id, user_id);
`]

export const QUESTION_MAX = 500
export const OPTION_MAX = 200
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 20
export const LIMIT_DEFAULT = 20
export const LIMIT_MAX = 100
const CONVERSATION_MAX = 64
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

const invalid = (message) => { throw new FeatureError(400, 'polls/invalid', message) }
const notFound = (message) => { throw new FeatureError(404, 'polls/not-found', message) }
const closed = (message) => { throw new FeatureError(409, 'polls/closed', message) }

function text(value, limit) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= limit
    && !CONTROL.test(value)
}

function conversationId(value) {
  if (typeof value !== 'string' || !value || value.length > CONVERSATION_MAX || CONTROL.test(value)) {
    invalid('conversation_id is required')
  }
  return value
}

function optionTexts(options) {
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    invalid(`polls require ${MIN_OPTIONS} to ${MAX_OPTIONS} options`)
  }
  const texts = []
  const seen = new Set()
  for (const option of options) {
    if (!text(option, OPTION_MAX)) invalid(`option text must be 1 to ${OPTION_MAX} characters`)
    const value = option.trim()
    const key = value.toLowerCase()
    if (seen.has(key)) invalid('duplicate poll option')
    seen.add(key)
    texts.push(value)
  }
  return texts
}

function optionIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_OPTIONS) {
    invalid('at least one option id is required')
  }
  const result = []
  const seen = new Set()
  for (const optionId of value) {
    if (typeof optionId !== 'string' || !HEX32.test(optionId) || seen.has(optionId)) invalid('invalid option id')
    seen.add(optionId)
    result.push(optionId)
  }
  return result
}

function closeTime(value) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value)) invalid('closes must be an integer timestamp')
  return value
}

function load(store, owner, workspace, pollId) {
  if (typeof pollId !== 'string' || !HEX32.test(pollId)) invalid('poll id is required')
  const row = store.get('SELECT * FROM polls WHERE id=? AND owner_id=? AND workspace_id=?', pollId, owner, workspace)
  if (!row) notFound('poll not found')
  return row
}

function view(store, row, viewer) {
  const options = store.all('SELECT * FROM poll_options WHERE poll_id=? ORDER BY position, id', row.id)
  const counts = new Map(store.all(
    'SELECT option_id, COUNT(*) AS count FROM poll_votes WHERE poll_id=? GROUP BY option_id', row.id,
  ).map((item) => [item.option_id, item.count]))
  const voters = new Map()
  if (!row.anonymous) {
    for (const item of store.all(
      'SELECT option_id, user_id FROM poll_votes WHERE poll_id=? ORDER BY created, user_id', row.id,
    )) {
      if (!voters.has(item.option_id)) voters.set(item.option_id, [])
      voters.get(item.option_id).push(item.user_id)
    }
  }
  const viewerVotes = viewer
    ? store.all(
      'SELECT v.option_id FROM poll_votes v JOIN poll_options o ON o.id=v.option_id '
      + 'WHERE v.poll_id=? AND v.user_id=? ORDER BY o.position, o.id', row.id, viewer,
    ).map((item) => item.option_id)
    : []
  const voterCount = store.get('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE poll_id=?', row.id).n
  return {
    id: row.id,
    owner_id: row.owner_id,
    workspace_id: row.workspace_id,
    conversation_id: row.conversation_id,
    created_by: row.created_by,
    question: row.question,
    multi_select: row.multi_select === 1,
    anonymous: row.anonymous === 1,
    closes: row.closes,
    status: row.status,
    created: row.created,
    options: options.map((option) => ({
      id: option.id,
      poll_id: option.poll_id,
      position: option.position,
      text: option.text,
      count: counts.get(option.id) ?? 0,
      voters: voters.get(option.id) ?? [],
    })),
    votes: viewerVotes,
    viewer_votes: viewerVotes,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    voter_count: voterCount,
  }
}

export function createPoll(store, owner, payload = {}, now = nowSeconds()) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  const conversation = conversationId(payload.conversation_id)
  if (!text(payload.question, QUESTION_MAX)) invalid(`question must be 1 to ${QUESTION_MAX} characters`)
  const texts = optionTexts(payload.options)
  const closes = closeTime(payload.closes)
  const id = newId()
  store.transaction(() => {
    store.run(
      'INSERT INTO polls (id,owner_id,workspace_id,conversation_id,created_by,question,multi_select,'
      + 'anonymous,closes,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, owner, payload.workspace_id, conversation, owner, payload.question.trim(),
      payload.multi_select === true ? 1 : 0, payload.anonymous === true ? 1 : 0, closes, 'open', now,
    )
    for (const [position, value] of texts.entries()) {
      store.run('INSERT INTO poll_options (id,poll_id,position,text) VALUES(?,?,?,?)', newId(), id, position, value)
    }
  })
  return view(store, load(store, owner, payload.workspace_id, id), owner)
}

export function getPoll(store, owner, payload = {}) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  return view(store, load(store, owner, payload.workspace_id, payload.id), owner)
}

export function listPolls(store, owner, payload = {}) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  const conversation = conversationId(payload.conversation_id)
  const limit = payload.limit === undefined || payload.limit === null ? LIMIT_DEFAULT : payload.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) invalid(`limit must be an integer from 1 to ${LIMIT_MAX}`)
  const where = ['owner_id=?', 'workspace_id=?', 'conversation_id=?']
  const params = [owner, payload.workspace_id, conversation]
  if (payload.cursor !== undefined && payload.cursor !== null) {
    if (typeof payload.cursor !== 'string' || !HEX32.test(payload.cursor)) invalid('invalid cursor')
    const anchor = store.get(
      'SELECT rowid, created FROM polls WHERE id=? AND owner_id=? AND workspace_id=? AND conversation_id=?',
      payload.cursor, owner, payload.workspace_id, conversation,
    )
    if (!anchor) notFound('unknown poll cursor')
    where.push('(created>? OR (created=? AND rowid>?))')
    params.push(anchor.created, anchor.created, anchor.rowid)
  }
  const rows = store.all(
    'SELECT rowid, * FROM polls WHERE ' + where.join(' AND ') + ' ORDER BY created, rowid LIMIT ?',
    ...params, limit + 1,
  )
  const page = rows.slice(0, limit)
  const next = rows.length > limit ? page[page.length - 1].id : null
  return { items: page.map((row) => view(store, row, owner)), next_cursor: next, cursor: next }
}

export function vote(store, owner, payload = {}, now = nowSeconds()) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  const row = load(store, owner, payload.workspace_id, payload.id)
  if (row.status !== 'open') closed('poll is closed')
  if (row.closes !== null && now >= row.closes) closed('poll has closed')
  const ids = optionIds(payload.option_ids)
  if (!row.multi_select && ids.length !== 1) invalid('single-choice polls accept exactly one option')
  const found = new Set(store.all(
    'SELECT id FROM poll_options WHERE poll_id=? AND id IN (' + ids.map(() => '?').join(',') + ')',
    row.id, ...ids,
  ).map((item) => item.id))
  if (found.size !== ids.length) invalid('option does not belong to this poll')
  store.transaction(() => {
    if (!row.multi_select) {
      store.run('DELETE FROM poll_votes WHERE poll_id=? AND user_id=? AND option_id<>?', row.id, owner, ids[0])
    }
    for (const optionId of ids) {
      store.run(
        'INSERT OR IGNORE INTO poll_votes (poll_id,option_id,user_id,created) VALUES(?,?,?,?)',
        row.id, optionId, owner, now,
      )
    }
  })
  return view(store, load(store, owner, payload.workspace_id, row.id), owner)
}

export function closePoll(store, owner, payload = {}) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  const row = load(store, owner, payload.workspace_id, payload.id)
  if (row.status !== 'closed') {
    store.run("UPDATE polls SET status='closed' WHERE id=? AND owner_id=? AND workspace_id=?",
      row.id, owner, payload.workspace_id)
  }
  return view(store, load(store, owner, payload.workspace_id, row.id), owner)
}

export function deletePoll(store, owner, payload = {}) {
  if (!HEX32.test(payload.workspace_id ?? '')) invalid('workspace_id is required')
  const row = load(store, owner, payload.workspace_id, payload.id)
  return store.transaction(() => {
    store.run('DELETE FROM poll_votes WHERE poll_id=?', row.id)
    store.run('DELETE FROM poll_options WHERE poll_id=?', row.id)
    return store.run('DELETE FROM polls WHERE id=? AND owner_id=? AND workspace_id=?',
      row.id, owner, payload.workspace_id).changes > 0
  })
}

export default defineFeature({
  name: 'polls',
  migrations: MIGRATIONS,
  endpoints: ({ store, owner }) => ({
    async create(payload) { return { poll: createPoll(store, owner, payload) } },
    async get(payload) { return { poll: getPoll(store, owner, payload) } },
    async list(payload) { return listPolls(store, owner, payload) },
    async vote(payload) { return { poll: vote(store, owner, payload) } },
    async close(payload) { return { poll: closePoll(store, owner, payload) } },
    async delete(payload) { return { deleted: deletePoll(store, owner, payload) } },
  }),
})
