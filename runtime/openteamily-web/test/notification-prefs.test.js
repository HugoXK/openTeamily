// #284 in the DS-Bot shape: the notification switches must change what the
// inbox returns, not only what the settings page draws. The preferences live in
// the settings feature (settings.js notificationPrefs); the inbox read path is
// this feature. Turning a category off filters the rows out of the listing and
// out of unread_count, and turning it back on returns the same rows.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsFeature } from '../features/settings/settings.js'
import { compatHandler } from '../lib/b4/compat.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import social from '../features/social/index.js'

const WS = 'a'.repeat(32)
const INBOX = `/v1/workspaces/${WS}/notifications`
const PREFS = '/v1/notification-prefs'

const settingsCall = (f, method, path, body) => compatHandler(f.legacy)({ method, path, body, query: '' })
const prefsFeature = () => createSettingsFeature({ dir: mkdtempSync(join(tmpdir(), 'ot-notify-prefs-')) })

function fakeBotSocial(rows) {
  const calls = []
  return {
    calls,
    request: async (method, path) => {
      calls.push(`${method} ${path}`)
      assert.equal(method, 'GET', 'the inbox only reads here')
      assert.match(path, /^\/v1\/ot\/notifications\?/)
      const unreadOnly = /[?&]unread=1(?:&|$)/.test(path)
      const listed = unreadOnly ? rows.filter(row => !row.read) : rows
      return { unread: listed.filter(row => !row.read).length, notifications: listed }
    },
  }
}

// The real cross-feature call: dispatch hands `settings/notificationPrefs` the
// plain payload the settings feature returns, and an unavailable feature throws.
function host(f, { prefsUnavailable = false } = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'ot-notify-host-')),
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: WS }
      if (name === 'settings/notificationPrefs') {
        if (prefsUnavailable) throw new Error('settings feature is not installed')
        const listed = await settingsCall(f, 'GET', PREFS)
        return listed.body
      }
      throw new Error('unexpected endpoint ' + name)
    },
  }
}

const row = (id, kind, read = false, data = {}) => ({
  id, seq: Number(id.slice(1)), kind, read, created_at: 1700000000000,
  data: { conversation_id: 'c'.repeat(32), ...data },
})

// One row of each kind the Bot Social inbox produces that a preference covers,
// plus a row no preference covers (it must survive every filter).
const rows = () => [
  row('n1', 'messenger.mention', false, { excerpt: '@ann 看一下这个' }),
  row('n2', 'discover.published', false, { listing_id: 'l1', title: '周报' }),
  row('n3', 'messenger.added', true),
]

const list = async (H, query = '') => (await social(H).endpoints.v1({ method: 'GET', path: INBOX, query })).body

test('提及我 off: the mention row is gone from the listing and from unread_count', async () => {
  setSharedBotSocial(fakeBotSocial(rows()))
  const f = prefsFeature()
  const H = host(f)
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { mentions: false } })).status, 200)
  const body = await list(H)
  assert.deepEqual(body.items.map(item => item.kind), ['discover.published', 'messenger.added'])
  assert.equal(body.unread_count, 1, 'only the published work is still unread')
})

test('作品通知 off: a followed work is filtered, not dropped, and returns when switched back on', async () => {
  setSharedBotSocial(fakeBotSocial(rows()))
  const f = prefsFeature()
  const H = host(f)
  const before = await list(H)
  assert.deepEqual(before.items.map(item => item.id), ['n1', 'n2', 'n3'])
  assert.equal(before.unread_count, 2)
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { artifacts: false } })).status, 200)
  const off = await list(H)
  assert.deepEqual(off.items.map(item => item.kind), ['messenger.mention', 'messenger.added'])
  assert.equal(off.unread_count, 1)
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { artifacts: true } })).status, 200)
  const back = await list(H)
  assert.deepEqual(back.items.map(item => item.id), ['n1', 'n2', 'n3'], 'the same rows come back')
  assert.equal(back.unread_count, 2)
})

test('the unread-only view follows the same filter and its count matches the rows shown', async () => {
  setSharedBotSocial(fakeBotSocial(rows()))
  const f = prefsFeature()
  const H = host(f)
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { mentions: false, artifacts: false } })).status, 200)
  const body = await list(H, 'filter=unread')
  assert.deepEqual(body.items.map(item => item.id), [], 'every unread row belongs to a category that is off')
  assert.equal(body.unread_count, 0)
})

test('defaults keep every row, and a missing settings feature cannot hide a notification', async () => {
  setSharedBotSocial(fakeBotSocial(rows()))
  const fresh = await list(host(prefsFeature()))
  assert.deepEqual(fresh.items.map(item => item.id), ['n1', 'n2', 'n3'])
  assert.equal(fresh.unread_count, 2)
  const missing = await list(host(prefsFeature(), { prefsUnavailable: true }))
  assert.deepEqual(missing.items.map(item => item.id), ['n1', 'n2', 'n3'])
  assert.equal(missing.unread_count, 2)
})
