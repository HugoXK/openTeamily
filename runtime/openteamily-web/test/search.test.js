import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, key, WS } from './helpers.js'

// Seed chat history directly in the chat feature's own store (a real send needs a running DS-Bot).
async function seedChat(bot) {
  const convo = await bot.endpoint('chat/create', { title: '周报助手' })
  assert.equal(convo.ok, true, JSON.stringify(convo))
  const db = new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'chat', 'chat.sqlite3'))
  const insert = db.prepare('INSERT INTO messages (id, conversation_id, role, text, created) VALUES (?,?,?,?,?)')
  const ids = []
  for (const [i, text] of ['帮我写周报', '好的，周报草稿见 https://example.com/report。', '谢谢'].entries()) {
    const id = String(i + 1).repeat(32).slice(0, 32)
    insert.run(id, convo.value.id, i % 2 ? 'assistant' : 'user', text, 1800000000000 + i * 1000)
    ids.push(id)
  }
  db.close()
  return { conversation: convo.value.id, ids }
}

test('message search runs in DS-Bot over this owner\'s own conversations', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('search'), JSON.stringify(bot.features.failed))
  const { conversation, ids } = await seedChat(bot)
  const call = (path) => bot.call('search', 'GET', path)
  const found = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1`)
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.deepEqual(found.body.items.map((item) => item.message_id), [ids[0]])
  assert.equal(found.body.items[0].title, '周报助手')
  assert.equal(found.body.items[0].created, 1800000000)
  assert.equal(found.body.cursor, ids[0])
  const next = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1&cursor=${ids[0]}`)
  assert.deepEqual(next.body.items.map((item) => item.message_id), [ids[1]])
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${'f'.repeat(32)}`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&kind=social`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=`)).status, 400)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=x&bogus=1`)).status, 400)
  const links = await call(`/v1/workspaces/${WS}/search/resources?kind=links&q=`)
  assert.deepEqual(links.body.items.map((item) => item.href), ['https://example.com/report'])
  const files = await call(`/v1/workspaces/${WS}/search/resources?kind=files&q=x`)
  assert.equal(files.status, 200)
  const other = await boot()
  assert.equal((await other.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报`)).body.items.length, 0)
  assert.ok(conversation)
})

test('search/all spans memory and meetings in this DS-Bot', async () => {
  const bot = await boot()
  await bot.call('memory', 'POST', `/v1/workspaces/${WS}/memory`, { title: '季度目标', body: '增长 20%' }, key())
  await bot.call('meetings', 'POST', `/v1/workspaces/${WS}/meetings`, { title: '季度复盘', summary: '回顾目标' }, key())
  const all = await bot.endpoint('search/all', { q: '季度' })
  assert.equal(all.ok, true, JSON.stringify(all))
  assert.deepEqual(all.value.items.map((item) => item.kind).sort(), ['meeting', 'memory'])
  assert.equal((await bot.endpoint('search/all', { q: '' })).ok, false)
})
