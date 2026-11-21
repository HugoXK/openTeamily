import { sharedBotSocial } from '../../lib/c/bot-social.js'
// Legacy /v1 artifact routes, executed inside this user's DS-Bot. The browser
// shim turns the works-library page's existing fetches into artifacts/v1.
import { pagination, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import {
  canEdit, content, createArtifact, createMedia, createShare, exportResult, HEX32, listShares, listing,
  load, mediaDigests, parseExportFormat, recordVersion, replaceMedia, restoreArtifact, revokeShare, shareView,
  unlinkMedia, updateArtifact, view, versionView,
} from './library.js'
import { decodeUpload } from './media.js'
import { publicKind } from './model.js'
import {decodeWorkbook,normalizeWorkbook,workbookText} from './workbook.js'

function ctx(req) {
  return { store: req.store, owner: req.owner, featureDir: req.host.featureDir(), role: 'owner' }
}

function mustLoad(req, workspaceId, artifactId) {
  if (!HEX32.test(workspaceId) || !HEX32.test(artifactId || '')) refuse(404, 'not_found', 'Artifact not found')
  const row = load(req.store, workspaceId, artifactId)
  if (!row) refuse(404, 'not_found', 'Artifact not found')
  return row
}

export async function dispatch(req, workspaceId, artifactId, action) {
  const context = ctx(req)
  if (!artifactId && req.method === 'GET') {
    const { limit, cursor, args } = pagination(req.query, ['q'])
    const needle = (args.get('q') ?? '').trim().toLocaleLowerCase('en-US')
    if (needle.length > 80) refuse(400, 'invalid', 'Invalid artifact request')
    const rows = listing(req.store, workspaceId, cursor, limit + 1, needle)
    const favorites = new Set(req.store.all(
      'SELECT f.artifact_id AS id FROM artifact_favorites f JOIN artifacts a ON a.id=f.artifact_id WHERE a.workspace_id=? AND f.user_id=?',
      workspaceId, req.owner,
    ).map((row) => row.id))
    const items = rows.slice(0, limit).map((row) => view(row, false, { favorited: favorites.has(row.id) }))
    return { body: { items, cursor: rows.length > limit ? rows[limit - 1].id : null } }
  }
  if (!artifactId && req.method === 'POST' && !req.queryString) {
    const raw = await req.json(4 * 1024 * 1024)
    if (raw?._multipart) {
      const upload = decodeUpload(raw)
      const mime = undefined
      return createMedia(context, workspaceId, {
        title: upload.fields.title, data: upload.data, filename: upload.filename, mime, key: req.headers.get('idempotency-key'),
      })
    }
    const body = requireBodyKeys(raw, ['title', 'body', 'kind', 'board', 'slides', 'dashboard', 'spreadsheet', 'source'])
    return createArtifact(context, workspaceId, body, req.headers.get('idempotency-key'))
  }
  if (!artifactId) refuse(400, 'invalid', 'Invalid artifact request')
  const row = mustLoad(req, workspaceId, artifactId)
  if (action === 'export') {
    if (req.method !== 'GET') refuse(400, 'invalid', 'Invalid artifact request')
    recordVersion(req.store, row)
    return exportResult(row, context.featureDir, workspaceId, false, parseExportFormat(req.query))
  }
  if (action === 'favorite') {
    if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid favorite request')
    const enabled = (await req.json()).enabled
    if (typeof enabled !== 'boolean') refuse(400, 'invalid', 'Provide enabled as a boolean')
    if (enabled) req.store.run('INSERT OR IGNORE INTO artifact_favorites VALUES(?,?,?)', row.id, req.owner, req.now)
    else req.store.run('DELETE FROM artifact_favorites WHERE artifact_id=? AND user_id=?', row.id, req.owner)
    return { body: { favorited: enabled } }
  }
  if (action === 'remove') {
    if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
    if (!canEdit('owner', req.owner, row)) refuse(403, 'forbidden', 'Not allowed to change this document')
    await req.json()
    const digests = mediaDigests(req.store, row.id)
    req.store.run('DELETE FROM artifacts WHERE id=?', row.id)
    for (const digestHex of digests) unlinkMedia(context.featureDir, req.store, workspaceId, digestHex)
    return { body: { removed: view(row, false) } }
  }
  if (action === 'preview') {
    if (req.method !== 'GET' || req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
    return content(row, context.featureDir, { preview: true })
  }
  if (action === 'file') {
    if (req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
    if (req.method === 'GET') return content(row, context.featureDir, { preview: false })
    if (req.method !== 'POST') refuse(400, 'invalid', 'Invalid artifact request')
    if (!canEdit('owner', req.owner, row) || publicKind(row) !== 'media') refuse(403, 'forbidden', 'Not allowed to change this document')
    const upload = decodeUpload(await req.json(4 * 1024 * 1024))
    const revision = Number(upload.fields.revision)
    const latest = mustLoad(req, workspaceId, artifactId)
    return replaceMedia(context, latest, { title: upload.fields.title, data: upload.data, filename: upload.filename, revision })
  }
  if (action === 'restore') {
    if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
    if (!canEdit('owner', req.owner, row)) refuse(403, 'forbidden', 'Not allowed to change this document')
    const body = requireBodyKeys(await req.json(), ['revision', 'to'])
    return restoreArtifact(context, mustLoad(req, workspaceId, artifactId), body.revision, body.to)
  }
  if (action) refuse(400, 'invalid', 'Invalid artifact request')
  if (req.method === 'GET' && !req.queryString) return { body: { artifact: view(row) } }
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
  if (!canEdit('owner', req.owner, row)) refuse(403, 'forbidden', 'Not allowed to change this document')
  const limit = publicKind(row) === 'spreadsheet' ? 1024 * 1024 : 70000
  const body = requireBodyKeys(await req.json(limit), ['revision', 'changes'])
  return updateArtifact(context, mustLoad(req, workspaceId, artifactId), body.changes, body.revision)
}

export async function history(req, workspaceId, artifactId, version, exporting) {
  const context = ctx(req)
  const row = mustLoad(req, workspaceId, artifactId)
  recordVersion(req.store, row)
  if (req.method !== 'GET' || (req.queryString && !exporting)) refuse(400, 'invalid', 'Invalid artifact request')
  if (!version) {
    const items = req.store.all('SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY revision DESC', row.id)
      .map((item) => versionView(item, false, req.store))
    return { body: { items } }
  }
  const revision = Number(version)
  if (!Number.isInteger(revision)) refuse(400, 'invalid', 'Invalid artifact request')
  const snapshot = req.store.get('SELECT * FROM artifact_versions WHERE artifact_id=? AND revision=?', row.id, revision)
  if (!snapshot) refuse(404, 'not_found', 'Version not found')
  if (exporting) return exportResult(snapshot, context.featureDir, workspaceId, true, parseExportFormat(req.query))
  return { body: { version: versionView(snapshot, true, req.store) } }
}

export async function shares(req, workspaceId, artifactId, shareId, revoking) {
  const row = mustLoad(req, workspaceId, artifactId)
  if (!shareId && req.method === 'GET' && !req.queryString) {
    return { body: { items: listShares(req.store, row.id).map((item) => shareView(item, { store: req.store })) } }
  }
  if (!shareId && req.method === 'POST' && !req.queryString) {
    if (!canEdit('owner', req.owner, row)) refuse(403, 'forbidden', 'Not allowed to share this document')
    const body = requireBodyKeys(await req.json(), ['expires_in'])
    const created = createShare(req.store, row, req.owner, req.now, body.expires_in)
    // Public /share/<token> pages are served by the dedicated Bot Social from this
    // read-only snapshot; only the token hash leaves this DS-Bot.
    const item = req.store.get('SELECT * FROM artifact_shares WHERE id=?', created.body.share.id)
    try {
      const workbook = row.spreadsheet_json && decodeWorkbook(row.spreadsheet_json)
      const body = workbook ? workbookText(workbook) : String(row.body ?? '')
      await sharedBotSocial(req.host).put('/v1/ot/public-shares', {
        token_hash: item.token_hash, ref: row.id, title: row.title, kind: row.kind,
        body: body.slice(0,200000), expires_at: item.expires ? item.expires * 1000 : null,
      })
    } catch {
      revokeShare(req.store, row.id, item.id, req.now)
      refuse(503, 'unavailable', 'Bot Social is not reachable; the share link was not created')
    }
    return created
  }
  if (shareId && revoking) {
    if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid artifact request')
    if (!canEdit('owner', req.owner, row)) refuse(403, 'forbidden', 'Not allowed to share this document')
    await req.json()
    const revoked = revokeShare(req.store, row.id, shareId, req.now)
    const item = req.store.get('SELECT * FROM artifact_shares WHERE id=?', shareId)
    if (item) await sharedBotSocial(req.host).del(`/v1/ot/public-shares/${item.token_hash}`).catch(() => {})
    return revoked
  }
  refuse(400, 'invalid', 'Invalid artifact request')
}

const activeDrafts = new WeakSet()
async function spreadsheetDraft(req,workspaceId) {
  if (req.method !== 'POST' || req.queryString) refuse(405,'method','请提交表格起草请求。')
  const {prompt} = requireBodyKeys(await req.json(8192),['prompt'])
  if (!validLongText(prompt,1600) || !prompt.trim()) refuse(400,'invalid','请输入需要整理的表格内容。')
  const binding = await req.host.call('agents/personal-binding',{}).catch(() => null)
  if (binding?.workspace_id !== workspaceId) {
    const teams = await req.host.call('teams/activeWorkspaces',{}).catch(() => [])
    if (!teams.some(team=>team.id===workspaceId)) refuse(404,'not_found','无法访问此工作区。')
  }
  const runtime = req.host.currentRuntime?.()
  if (typeof runtime?.backgroundTextOnly !== 'function') refuse(503,'unavailable','DS-Bot 暂时无法起草表格。')
  if (activeDrafts.has(req.store)) refuse(429,'busy','已有表格草稿正在生成，请稍后重试。')
  activeDrafts.add(req.store)
  try {
    const response = await runtime.backgroundTextOnly([
      'Draft an editable workbook from the supplied description. Return one JSON object and no other output.',
      'Use {"title":"…","sheets":[{"name":"…","rows":[["heading","heading"],["text","72"]]}]}. Each cell is a string.',
      'Use the prompt language, descriptive sheet names up to 31 characters, at most 4 sheets with 40 rows and 12 columns each.',
      'Use blank cells for absent facts. Only invent sample data if the user explicitly asks for examples.',
      'Allowed subtotal formulas have the form =SUM(B2:B5). Do not include external references or executable content.',
      'Description: ' + JSON.stringify(prompt.trim()),
    ].join('\n'))
    const parsed = JSON.parse(String(response).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'))
    const workbook = normalizeWorkbook({schema:'openteamily.spreadsheet.v1',sheets:parsed?.sheets})
    if (!workbook || !workbook.sheets.some(sheet => sheet.rows.some(row=>row.some(cell=>cell.trim())))) throw Error('Invalid workbook')
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0,80) : ''
    return {body:{title:validLongText(title,80) && title ? title : '表格草稿',spreadsheet:workbook}}
  } catch {
    refuse(502,'draft_failed','表格草稿暂时无法生成，请重试。')
  } finally { activeDrafts.delete(req.store) }
}

export const routes = [
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/spreadsheet\/draft$/,handle:spreadsheetDraft},
  { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/versions(?:\/(\d{1,8})(?:\/(export))?)?$/, handle: history },
  { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/shares(?:\/([0-9a-f]{32})(\/revoke)?)?$/, handle: shares },
  { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts(?:\/([0-9a-f]{32})(?:\/(remove|favorite|preview|file|export|restore))?)?$/, handle: dispatch },
]
