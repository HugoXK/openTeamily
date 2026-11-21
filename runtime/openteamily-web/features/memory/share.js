// Read-only share links for one memory page (#299), inside this user's DS-Bot.
// The link is one 43-character token; this store keeps only sha256('share:'+token)
// plus a short prefix for display. The public page is rendered by Bot Social from
// the snapshot published on create/update, so a signed-out reader needs no session
// and no route here; revoking deletes that snapshot, which makes the link 404.
import { randomBytes } from 'node:crypto'
import { digest, newId, refuse, requireBodyKeys } from '../../featurekit/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { actor, loadPage } from './common.js'

const W = '([0-9a-f]{32})'
const BODY_MAX = 200_000
const opaque = () => randomBytes(32).toString('base64url')

const latest = (store, workspaceId, pageId) => store.get(
  'SELECT * FROM memory_shares WHERE workspace_id=? AND page_id=? ORDER BY rowid DESC LIMIT 1', workspaceId, pageId)
const activeShares = (store, workspaceId, pageId) => store.all(
  'SELECT * FROM memory_shares WHERE workspace_id=? AND page_id=? AND revoked=0', workspaceId, pageId)

function shareView(row, token = null) {
  const data = {
    id: row.id, page_id: row.page_id, workspace_id: row.workspace_id, prefix: row.token_prefix,
    created: row.created, created_by: row.created_by, active: !row.revoked, revoked: Boolean(row.revoked),
    scope: 'read',
  }
  // The token is only in the answer to the create call: after a reload the page
  // knows the state but cannot show the link again.
  if (token) { data.token = token; data.path = '/share/' + token }
  return data
}

function mustPage(req, workspaceId, pageId) {
  const page = loadPage(req.store, workspaceId, pageId)
  if (!page) refuse(404, 'not_found', 'Memory page not found')
  return page
}

// Bot Social renders /share/<token> from this snapshot; only the hash of the
// token leaves this volume, never the token itself.
async function publish(req, row, page) {
  await sharedBotSocial(req.host).put('/v1/ot/public-shares', {
    token_hash: row.token_hash, ref: page.id, title: page.title, kind: 'memory',
    body: String(page.body ?? '').slice(0, BODY_MAX), expires_at: null,
  })
}

async function retire(req, rows) {
  for (const row of rows) {
    req.store.run('UPDATE memory_shares SET revoked=1 WHERE id=?', row.id)
    await sharedBotSocial(req.host).del('/v1/ot/public-shares/' + row.token_hash).catch(() => {})
  }
}

async function create(req, workspaceId, pageId) {
  const page = mustPage(req, workspaceId, pageId)
  requireBodyKeys(await req.json(), [])
  const token = opaque()
  const id = newId()
  req.store.run('INSERT INTO memory_shares(id, workspace_id, page_id, token_hash, token_prefix, created, created_by, revoked) VALUES(?,?,?,?,?,?,?,0)',
    id, workspaceId, pageId, digest('share:' + token), token.slice(0, 8), req.now, actor(req))
  const row = req.store.get('SELECT * FROM memory_shares WHERE id=?', id)
  try {
    await publish(req, row, page)
  } catch {
    req.store.run('DELETE FROM memory_shares WHERE id=?', id)
    refuse(503, 'unavailable', 'Bot Social is not reachable; the share link was not created')
  }
  // Sharing again replaces the old link: the earlier snapshots are taken down
  // after the new one is live, so a failure above leaves the old link working.
  await retire(req, activeShares(req.store, workspaceId, pageId).filter((old) => old.id !== id))
  return { status: 201, body: { share: shareView(row, token) } }
}

async function state(req, workspaceId, pageId) {
  mustPage(req, workspaceId, pageId)
  if (req.method !== 'GET' || req.queryString) refuse(400, 'invalid', 'Invalid memory share request')
  const row = latest(req.store, workspaceId, pageId)
  return { body: { share: row ? shareView(row) : null } }
}

async function revoke(req, workspaceId, pageId) {
  mustPage(req, workspaceId, pageId)
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid memory share request')
  requireBodyKeys(await req.json(), [])
  const row = latest(req.store, workspaceId, pageId)
  if (!row) refuse(404, 'not_found', 'Share not found')
  if (row.revoked) return { body: { share: shareView(row) } }
  await retire(req, [row])
  return { body: { share: shareView(req.store.get('SELECT * FROM memory_shares WHERE id=?', row.id)) } }
}

async function share(req, workspaceId, pageId) {
  if (req.method === 'GET') return state(req, workspaceId, pageId)
  if (req.method === 'POST') return create(req, workspaceId, pageId)
  refuse(400, 'invalid', 'Invalid memory share request')
}

async function shareRevoke(req, workspaceId, pageId) {
  return revoke(req, workspaceId, pageId)
}

export const routes = [
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/share/revoke$`), handle: shareRevoke },
  { pattern: new RegExp(`^/v1/workspaces/${W}/memory/${W}/share$`), handle: share },
]

// Kept fresh: an edited page keeps its link and the public snapshot follows.
export async function republishShare(req, page) {
  for (const row of activeShares(req.store, page.workspace_id, page.id)) {
    await publish(req, row, page).catch(() => {})
  }
}

// A deleted page must not leave a readable public snapshot behind.
export async function retireShares(req, workspaceId, pageId) {
  const rows = req.store.all('SELECT * FROM memory_shares WHERE workspace_id=? AND page_id=? AND revoked=0', workspaceId, pageId)
  await retire(req, rows)
}
