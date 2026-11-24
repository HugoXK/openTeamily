// Memory bundles must carry per-owner read state and pins, and a bundle
// produced before those tables existed must still import.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { bootMemory as boot, deliverBundle, volume, WS } from './helpers.js'

const OWNER = '1'.repeat(32)
const PINNED = 'a'.repeat(32)
const READ = 'b'.repeat(32)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function page(id, title, revision, updated) {
  return {
    id, workspace_id: WS, title, title_hash: sha(title), body: title + ' 正文', revision,
    created: 1, updated, created_by: OWNER, updated_by: OWNER,
    key_hash: sha('key:' + id), request_hash: sha('request:' + id),
  }
}

const PAGES = [
  page(PINNED, '置顶的一页', 2, 2),
  page(READ, '读过的一页', 1, 1),
]

function bundle(tables) {
  const out = { format: 'openteamily-dsbot-import', version: 1, feature: 'memory', tables: {}, manifest: {} }
  for (const [name, rows] of Object.entries(tables)) {
    out.tables[name] = JSON.stringify(rows)
    out.manifest[name] = { rows: rows.length, sha256: sha(out.tables[name]) }
  }
  return out
}

const users = [{ id: OWNER, username: 'alice', is_owner: 1 }]

test('a memory bundle keeps the pinned page and the read revision after import', async () => {
  const vol = volume()
  deliverBundle(vol, 'memory-state.bundle', JSON.stringify(bundle({
    ot_users: users,
    memory_pages: PAGES,
    memory_page_pins: [{ page_id: PINNED, user_id: OWNER }],
    memory_page_reads: [{ page_id: READ, user_id: OWNER, revision: 1 }],
  })))
  const bot = await boot(vol, { personal: WS })
  assert.deepEqual((await bot.endpoint('memory/routes')).value.imported.map((item) => item.status), ['imported'])
  const route = `/v1/workspaces/${WS}/memory`
  const pinned = (await bot.call('memory', 'GET', route + '?order=recent&pinned=1')).body
  assert.deepEqual(pinned.items.map((item) => item.id), [PINNED])
  assert.equal(pinned.items[0].pinned, true)
  assert.equal(pinned.unread_total, 1, 'only the pinned page is unread; the read page stays read')
  const unread = (await bot.call('memory', 'GET', route + '?order=recent&unread=1')).body
  assert.deepEqual(unread.items.map((item) => item.id), [PINNED])
  const all = (await bot.call('memory', 'GET', route + '?order=recent')).body
  assert.deepEqual(all.items.map((item) => [item.id, item.unread]), [[PINNED, true], [READ, false]])
})

test('a memory bundle without the state tables still imports and treats them as empty', async () => {
  const vol = volume()
  deliverBundle(vol, 'memory-old.bundle', JSON.stringify(bundle({
    ot_users: users,
    memory_pages: PAGES,
  })))
  const bot = await boot(vol, { personal: WS })
  assert.deepEqual((await bot.endpoint('memory/routes')).value.imported.map((item) => item.status), ['imported'])
  const route = `/v1/workspaces/${WS}/memory`
  const recent = (await bot.call('memory', 'GET', route + '?order=recent')).body
  assert.deepEqual(recent.items.map((item) => item.id).sort(), [PINNED, READ].sort())
  assert.deepEqual(recent.items.map((item) => item.pinned), [false, false])
  assert.equal(recent.unread_total, 2)
})
