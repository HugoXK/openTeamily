import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'

const base = (id = '', ws = WS) => `/v1/workspaces/${ws}/meetings${id ? '/' + id : ''}`
const body = { title: '周会', attendees: ['alice', 'bob'], summary: '同步进度。', transcript: '讨论排期。', action_items: [{ text: '订会议室', owner: 'bob' }] }

test('meetings feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('meetings'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'meetings', 'meetings.sqlite3')))
  const routes = await bot.endpoint('meetings/routes')
  assert.equal(routes.ok, true)
  assert.ok(routes.value.routes.every((source) => source.startsWith('^\\/v1\\/workspaces')))
})

test('meetings run inside this DS-Bot: create, idempotent replay, list, read, update, export, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const k = key()
  const created = await call('POST', base(), body, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const meeting = created.body.meeting
  assert.equal(meeting.action_count, 1)
  assert.equal(meeting.done_count, 0)
  assert.equal((await call('POST', base(), body, k)).status, 200)
  assert.equal((await call('POST', base(), { ...body, title: '另一个' }, k)).status, 409)
  assert.equal((await call('POST', base(), body, key())).status, 409, 'duplicate title')
  assert.equal((await call('POST', base(), body)).status, 400, 'idempotency key required')
  assert.equal((await call('POST', base(), { ...body, title: '' }, key())).status, 400)

  const listed = await call('GET', base() + '?limit=20')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].transcript, undefined)
  assert.equal((await call('GET', base() + '?bogus=1')).status, 400)
  assert.equal((await call('GET', base(meeting.id))).body.meeting.transcript, '讨论排期。')

  const stale = await call('POST', base(meeting.id), { revision: 9, changes: { summary: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const updated = await call('POST', base(meeting.id), { revision: 1, changes: { action_items: [{ text: '订会议室', owner: 'bob', done: true }] } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.meeting.revision, 2)
  assert.equal(updated.body.meeting.done_count, 1)

  const exported = await call('GET', base(meeting.id) + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/markdown/)
  assert.equal(exported.download.filename, `meeting-${meeting.id}.md`)
  assert.match(exported.text, /^# 周会/)
  assert.match(exported.text, /- \[x\] 订会议室（bob）/)

  assert.equal((await call('POST', base(meeting.id) + '/remove', {})).status, 200)
  assert.equal((await call('GET', base(meeting.id))).status, 404)
})

test('meeting data persists in this volume only; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('meetings', 'POST', base(), body, key())
  const again = await boot(vol)
  assert.equal((await again.call('meetings', 'GET', base(created.body.meeting.id))).status, 200)
  const other = await boot()
  assert.equal((await other.call('meetings', 'GET', base(created.body.meeting.id))).status, 404)
  assert.equal((await other.call('meetings', 'GET', base())).body.items.length, 0)
})

test('unmoved and malformed /v1 targets are refused', async () => {
  const bot = await boot()
  assert.equal((await bot.call('meetings', 'GET', `/v1/workspaces/${WS}/automations`)).body.error.code, 'not_moved')
  for (const bad of ['/v1/workspaces/../meetings', '/x/meetings', '/v1/workspaces/%2e%2e/meetings', '//v1/']) {
    assert.equal((await bot.call('meetings', 'GET', bad)).status, 404, bad)
  }
  assert.equal((await bot.call('meetings', 'DELETE', base())).status, 404)
})

test('legacy meetings of one test account import into that account\'s DS-Bot, idempotently', async () => {
  const { bundles, expect } = legacyBundles(['meetings'])
  const vol = volume()
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const bot = await boot(vol)
  const routes = await bot.endpoint('meetings/routes')
  assert.deepEqual(routes.value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const read = await bot.call('meetings', 'GET', base(expect.meetings.meeting_id, wid))
  assert.equal(read.status, 200)
  assert.equal(read.body.meeting.title, expect.meetings.title)
  assert.equal(read.body.meeting.action_items[0].text, '订会议室')
  const titles = (await bot.call('meetings', 'GET', base('', wid))).body.items.map((item) => item.title)
  assert.ok(!titles.includes(expect.meetings.foreign_title), 'another account\'s meeting never enters this bundle')
  assert.equal(existsSync(join(vol.data, 'openteamily', 'import', 'meetings-1.bundle')), false)
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const again = await boot(vol)
  assert.deepEqual((await again.endpoint('meetings/routes')).value.imported.map((item) => item.status), ['already-imported'])
  const tampered = JSON.parse(bundles.meetings)
  tampered.tables.meetings = tampered.tables.meetings.replace('周会', '改过')
  const evil = volume()
  deliverBundle(evil, 'x.bundle', JSON.stringify(tampered))
  const rejected = await boot(evil)
  assert.equal((await rejected.endpoint('meetings/routes')).value.imported[0].status, 'rejected')
})
