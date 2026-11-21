// Presence and typing leases (#399) inside this user's DS-Bot: a lease says the
// owner is online in, or typing in, one workspace conversation. Rows are
// ephemeral and carry an explicit expiry; readers treat an expired row as absent
// even before any cleanup runs. Honest scope: this volume has exactly one owner,
// so a list is that owner's own state; cross-user visibility is a later transport
// slice, and no page calls these routes yet.
import { defineFeature } from '../../featurekit/feature.js'
import { refuse, requireBodyKeys } from '../../featurekit/http.js'

const W = '([0-9a-f]{32})'
const C = '([A-Za-z0-9._-]{1,80})'
const U = '([A-Za-z0-9._-]{1,128})'
const KINDS = ['online', 'typing']
const DEFAULT_TTL = 30
const MIN_TTL = 1
const MAX_TTL = 3600

// A lease is one row per (workspace, conversation, user, kind): heartbeats
// upsert it instead of appending, and the expiry index answers "who is active
// here" without scanning another user's rows.
export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS presence_leases (
 workspace_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('online','typing')),
 expires INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, conversation_id, user_id, kind));
CREATE INDEX IF NOT EXISTS presence_lease_active
 ON presence_leases(workspace_id, conversation_id, expires);
`]

const leaseView = (row) => ({ user_id: row.user_id, kind: row.kind, expires: row.expires, updated: row.updated })

function kindOf(value) {
  if (!KINDS.includes(value)) refuse(400, 'invalid', 'kind must be online or typing')
  return value
}

function ttlOf(value) {
  if (value === undefined) return DEFAULT_TTL
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_TTL || value > MAX_TTL) {
    refuse(400, 'invalid', `ttl_seconds must be an integer between ${MIN_TTL} and ${MAX_TTL}`)
  }
  return value
}

// A caller may only act as itself. The path is already authenticated to this
// DS-Bot's owner; naming another user is refused instead of silently writing
// a lease that person never asked for.
function userOf(req, claimed) {
  if (claimed === undefined) return req.owner
  if (typeof claimed !== 'string' || !claimed || claimed.length > 128 || !/^[A-Za-z0-9._-]+$/.test(claimed)) {
    refuse(400, 'invalid', 'user_id must be a bounded identifier')
  }
  if (claimed !== req.owner) refuse(403, 'forbidden', 'Only the authenticated user can renew or clear this lease')
  return claimed
}

const loadLease = (store, workspaceId, conversationId, userId, kind) => store.get(
  'SELECT user_id, kind, expires, updated FROM presence_leases WHERE workspace_id=? AND conversation_id=? AND user_id=? AND kind=?',
  workspaceId, conversationId, userId, kind)

function heartbeat(req, workspaceId, conversationId, body) {
  const kind = kindOf(body.kind)
  const ttl = ttlOf(body.ttl_seconds)
  // No background sweeper: drop this conversation's expired rows on the next
  // write, so they cannot accumulate per conversation forever.
  req.store.run('DELETE FROM presence_leases WHERE workspace_id=? AND conversation_id=? AND expires<=?',
    workspaceId, conversationId, req.now)
  const user = userOf(req, body.user_id)
  req.store.run(
    'INSERT INTO presence_leases (workspace_id, conversation_id, user_id, kind, expires, updated) '
    + 'VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(workspace_id, conversation_id, user_id, kind) DO UPDATE SET '
    + 'expires=MAX(presence_leases.expires, excluded.expires), '
    + 'updated=MAX(presence_leases.updated, excluded.updated)',
    workspaceId, conversationId, user, kind, req.now + ttl, req.now)
  return { body: { presence: leaseView(loadLease(req.store, workspaceId, conversationId, user, kind)) } }
}

function list(req, workspaceId, conversationId) {
  const rows = req.store.all(
    'SELECT user_id, kind, expires, updated FROM presence_leases '
    + 'WHERE workspace_id=? AND conversation_id=? AND expires>? ORDER BY user_id, kind',
    workspaceId, conversationId, req.now)
  return { body: { presence: rows.map(leaseView) } }
}

function clear(req, workspaceId, conversationId, body) {
  const kind = body.kind === undefined ? null : kindOf(body.kind)
  const user = userOf(req, body.user_id)
  let sql = 'DELETE FROM presence_leases WHERE workspace_id=? AND conversation_id=? AND user_id=? AND updated<=?'
  const args = [workspaceId, conversationId, user, req.now]
  if (kind) { sql += ' AND kind=?'; args.push(kind) }
  return { body: { cleared: req.store.run(sql, ...args).changes } }
}

function typing(req, workspaceId, conversationId, userId) {
  if (req.method !== 'GET' || req.queryString) refuse(400, 'invalid', 'Invalid presence request')
  const row = req.store.get(
    "SELECT 1 AS ok FROM presence_leases WHERE workspace_id=? AND conversation_id=? AND user_id=? AND kind='typing' AND expires>?",
    workspaceId, conversationId, userId, req.now)
  return { body: { user_id: userId, typing: row !== null } }
}

async function presenceRoute(req, workspaceId, conversationId) {
  if (req.queryString) refuse(400, 'invalid', 'Invalid presence request')
  if (req.method === 'GET') return list(req, workspaceId, conversationId)
  if (req.method === 'POST') return heartbeat(req, workspaceId, conversationId, requireBodyKeys(await req.json(), ['kind', 'ttl_seconds', 'user_id']))
  refuse(400, 'invalid', 'Invalid presence request')
}

async function clearRoute(req, workspaceId, conversationId) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid presence request')
  return clear(req, workspaceId, conversationId, requireBodyKeys(await req.json(), ['kind', 'user_id']))
}

async function typingRoute(req, workspaceId, conversationId, userId) {
  return typing(req, workspaceId, conversationId, userId)
}

export const routes = [
  { pattern: new RegExp(`^/v1/workspaces/${W}/conversations/${C}/presence/clear$`), handle: clearRoute },
  { pattern: new RegExp(`^/v1/workspaces/${W}/conversations/${C}/presence/typing/${U}$`), handle: typingRoute },
  { pattern: new RegExp(`^/v1/workspaces/${W}/conversations/${C}/presence$`), handle: presenceRoute },
]

export default defineFeature({ name: 'presence', migrations: MIGRATIONS, routes })
