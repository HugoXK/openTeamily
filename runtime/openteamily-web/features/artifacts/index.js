// Artifacts feature (stream B3): saving a work into this user's library runs
// inside their DS-Bot. artifacts/create is the in-process entry B2 team runs
// call to store a finished step's output (kind=document). Later batches add
// the studio routes, media, boards, shares and exports.
import { defineFeature } from '../../featurekit/feature.js'
import { HEX32, digest, newId, nowSeconds, refuse, stableJson } from '../../featurekit/http.js'
import { titleHash, validBody, validTitle } from './model.js'
import { MIGRATIONS } from './schema.js'

export const PER_WORKSPACE = 50
const KEY = /^[A-Za-z0-9_-]{16,64}$/

const username = () => process.env.OPENTEAMILY_OWNER_USERNAME || 'me'
const load = (store, workspaceId, id) => store.get('SELECT * FROM artifacts WHERE id=? AND workspace_id=?', id, workspaceId)

export function view(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    kind: 'document',
    revision: row.revision,
    created: row.created,
    updated: row.updated,
    created_by: row.created_by_username ?? username(),
    updated_by: row.updated_by_username ?? username(),
    body: row.body,
  }
}

function recordVersion(store, row) {
  store.run(
    'INSERT OR IGNORE INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.revision, row.title, 'document', row.body, null, null, null, null, null, row.updated, row.updated_by,
  )
}

export function createArtifact({ store, owner }, payload) {
  const input = payload ?? {}
  const workspaceId = input.workspace_id
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
  const title = input.title
  const content = input.body ?? ''
  const kind = input.kind ?? 'document'
  if (kind !== 'document' || !validTitle(title) || !validBody(content)) {
    refuse(400, 'invalid', 'Provide a document title and body')
  }
  const trimmed = title.trim()
  const key = input.idempotency_key ?? ''
  if (!KEY.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const keyHash = digest('artifact:' + key)
  const requestHash = digest(stableJson({ title: trimmed, body: content, kind }))
  return store.transaction(() => {
    const prior = store.get('SELECT * FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { artifact: view(load(store, workspaceId, prior.id)) }
    }
    const hash = titleHash(trimmed)
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429, 'quota', 'Artifact capacity reached')
    }
    const id = newId()
    const now = nowSeconds()
    store.run(
      'INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id, workspaceId, trimmed, hash, 'document', content, now, now, owner, owner, keyHash, requestHash,
    )
    const row = load(store, workspaceId, id)
    recordVersion(store, row)
    return { artifact: view(row) }
  })
}

export default defineFeature({
  name: 'artifacts',
  pages: ['artifacts'],
  migrations: MIGRATIONS,
  endpoints: (context) => ({
    async create(payload) { return createArtifact(context, payload) },
  }),
})
