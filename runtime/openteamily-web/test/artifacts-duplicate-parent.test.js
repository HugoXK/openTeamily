// Duplicating a document must keep it where its source sits in the tree:
// the copy is a sibling of the source, a root source stays at the root, and a
// parent that no longer exists must not leave a dangling parent_id behind.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import test from 'node:test'
import { boot, key, WS } from './helpers.js'

const base = (rest = '', ws = WS) => '/v1/workspaces/' + ws + '/artifacts' + rest
const database = bot => new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'artifacts', 'artifacts.sqlite3'))

test('duplicating a child document keeps the copy beside its source', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const create = async (title, parentId = null) => (await call('POST', base(), {
    title, body: '文档内容', ...(parentId ? {parent_id: parentId} : {}),
  }, key())).body.artifact

  const parent = await create('父文档')
  const child = await create('子文档', parent.id)
  const copy = (await call('POST', base(), {
    title: '子文档副本', duplicate_from: {artifact_id: child.id, revision: child.revision},
  }, key())).body.artifact

  assert.notEqual(copy.id, child.id)
  assert.deepEqual(copy.parent, {id: parent.id, title: parent.title}, 'the copy stays a sibling, not a child, of its source')
  const tree = (await call('GET', base('/document-tree'))).body.items
  assert.equal(tree.find(row => row.id === copy.id).parent_id, parent.id, 'document-tree reports the copied parent')
  assert.equal(tree.find(row => row.id === child.id).parent_id, parent.id, 'the source keeps its own parent')
})

test('duplicating a root document leaves the copy at the root', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const source = (await call('POST', base(), {title: '根文档', body: '文档内容'}, key())).body.artifact
  const copy = (await call('POST', base(), {
    title: '根文档副本', duplicate_from: {artifact_id: source.id, revision: source.revision},
  }, key())).body.artifact

  assert.equal(copy.parent, undefined, 'a root copy has no parent')
  const tree = (await call('GET', base('/document-tree'))).body.items
  assert.equal(tree.find(row => row.id === copy.id).parent_id, null)
})

test('a source whose parent row is gone duplicates to the root without a dangling link', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const create = async (title, parentId = null) => (await call('POST', base(), {
    title, body: '文档内容', ...(parentId ? {parent_id: parentId} : {}),
  }, key())).body.artifact

  const parent = await create('父文档')
  const child = await create('子文档', parent.id)
  const gone = 'f'.repeat(32)
  const raw = database(bot)
  try {
    raw.exec('PRAGMA foreign_keys=OFF')
    raw.prepare('INSERT OR REPLACE INTO artifact_document_parents VALUES(?,?)').run(child.id, gone)
  } finally {
    raw.close()
  }

  const copy = await call('POST', base(), {
    title: '子文档副本', duplicate_from: {artifact_id: child.id, revision: child.revision},
  }, key())
  assert.equal(copy.status, 201, 'the duplicate still succeeds')
  assert.equal(copy.body.artifact.parent, undefined, 'a missing parent lands the copy at the root')
  const tree = (await call('GET', base('/document-tree'))).body.items
  assert.equal(tree.find(row => row.id === copy.body.artifact.id).parent_id, null)

  const check = database(bot)
  try {
    assert.equal(check.prepare('SELECT parent_id FROM artifact_document_parents WHERE artifact_id=?').get(copy.body.artifact.id), undefined,
      'no dangling parent row was written for the copy')
  } finally {
    check.close()
  }
})
