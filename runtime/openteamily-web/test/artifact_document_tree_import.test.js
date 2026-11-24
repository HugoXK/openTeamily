// A moved Space keeps its document tree (#10): the artifacts bundle carries
// artifact_document_parents, the import contract accepts it after artifacts, and
// a bundle whose parent row is missing brings the child in at the root instead
// of failing the whole import.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { boot, deliverBundle, volume, WS } from './helpers.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const TREE = `/v1/workspaces/${WS}/artifacts/document-tree`
const PARENTS = 'artifact_document_parents'

// The platform exports the bundle; this fixture builds one database with a
// parent document, one child and one loose document, and prints its bundle.
// The interpreter is discovered, not assumed: CI images carry python3, not
// python3.11, and a missing one must say so instead of throwing undefined.
const PYTHON = (process.env.OPENTEAMILY_PYTHON ? [process.env.OPENTEAMILY_PYTHON] : [])
  .concat(['python3', 'python3.11', 'python'])
  .find((name) => spawnSync(name, ['-c', 'pass'], { encoding: 'utf8' }).status === 0)

function exported() {
  assert.ok(PYTHON, 'no python interpreter found to export the platform bundle')
  const run = spawnSync(PYTHON, [join(HERE, 'fixtures', 'document_tree_bundle.py')], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: REPO_ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (run.status !== 0) {
    const detail = [
      run.error?.message,
      run.signal && `signal ${run.signal}`,
      String(run.stderr ?? '').trim().slice(-2000),
    ].filter(Boolean).join(' | ')
    throw new Error(`export fixture failed (status ${run.status}): ${detail}`)
  }
  return JSON.parse(run.stdout)
}

async function imported(bundle) {
  const vol = volume()
  deliverBundle(vol, 'artifacts-tree.bundle', JSON.stringify(bundle))
  const bot = await boot(vol)
  const status = (await bot.endpoint('artifacts/routes')).value.imported.map((item) => item.status)
  const items = (await bot.call('artifacts', 'GET', TREE)).body.items
  return { vol, bot, status, items, tree: new Map(items.map((row) => [row.id, row.parent_id])) }
}

// Walk every document to its root; a cycle or a missing ancestor shows up here.
function rooted(tree) {
  for (const id of tree.keys()) {
    const seen = new Set([id])
    let cursor = tree.get(id)
    while (cursor !== null && cursor !== undefined) {
      assert.ok(!seen.has(cursor), `cycle through ${cursor}`)
      seen.add(cursor)
      cursor = tree.get(cursor)
    }
  }
}

function resign(bundle, table, rows) {
  bundle.tables[table] = JSON.stringify(rows)
  bundle.manifest[table] = { rows: rows.length, sha256: createHash('sha256').update(bundle.tables[table], 'utf8').digest('hex') }
}

test('a moved Space keeps the document tree', async () => {
  const fixture = exported()
  const { status, tree } = await imported(fixture.bundle)
  assert.deepEqual(status, ['imported'])
  assert.deepEqual(tree, new Map([[fixture.parent, null], [fixture.child, fixture.parent], [fixture.orphan, null]]))
  rooted(tree)
  assert.ok(Object.hasOwn(fixture.bundle.tables, PARENTS), 'the export must carry the document tree')
})

test('a bundle exported before the tree table existed still imports and stays flat', async () => {
  const fixture = exported()
  const bundle = structuredClone(fixture.bundle)
  delete bundle.tables[PARENTS]
  delete bundle.manifest[PARENTS]
  const { status, tree } = await imported(bundle)
  assert.deepEqual(status, ['imported'])
  assert.deepEqual(tree, new Map([[fixture.parent, null], [fixture.child, null], [fixture.orphan, null]]))
})

test('a child whose parent row is missing lands at the root without failing the import', async () => {
  const fixture = exported()
  const bundle = structuredClone(fixture.bundle)
  // Drop the parent artifact from the bundle but keep the parent link row.
  const kept = JSON.parse(bundle.tables.artifacts).filter((row) => row.id !== fixture.parent)
  resign(bundle, 'artifacts', kept)
  // An export from a tree that has no parent rows at all still names the table.
  if (!bundle.tables[PARENTS]) resign(bundle, PARENTS, [{ artifact_id: fixture.child, parent_id: fixture.parent }])
  assert.equal(JSON.parse(bundle.tables[PARENTS]).length, 1)
  const { vol, status, tree } = await imported(bundle)
  assert.deepEqual(status, ['imported'])
  assert.deepEqual(tree, new Map([[fixture.child, null], [fixture.orphan, null]]))
  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'artifacts', 'artifacts.sqlite3'))
  try {
    assert.deepEqual(db.prepare(`SELECT * FROM ${PARENTS}`).all(), [], 'no dangling parent link is kept')
  } finally {
    db.close()
  }
})
