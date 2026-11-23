// Messenger thread endpoints: they relay the shared thread state through the Bot Social client
// and never keep a second copy on this user's volume.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import messenger from '../features/messenger/index.js'

const SERVER = 'https://social.example.test'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ot-threads-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  return dir
}

function fake(routes = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path, body })
    const handler = routes[`${init.method} ${path.split('?')[0]}`]
    return new Response(JSON.stringify(handler ? handler(body, path) : {}), { status: 200 })
  }
  return { fetch, calls }
}

function endpoints() {
  const dir = fixture()
  const f = fake()
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch: f.fetch }))
  return { f, E: messenger({ dataDir: dir }).endpoints }
}

test('thread endpoints use the workspace-scoped Bot Social conversation routes', async () => {
  const { f, E } = endpoints()
  const workspace = 'a'.repeat(32)
  await E.createThread({ workspace_id: workspace, conversation_id: 'otc_1', root_message_id: 'otm_1', title: 'Launch' })
  await E.listThreads({ workspace_id: workspace, conversation_id: 'otc_1', include_resolved: false, limit: 5, cursor: 'otmt_1' })
  await E.threadView({ workspace_id: workspace, conversation_id: 'otc_1', thread_id: 'otmt_1', limit: 2, cursor: 'otmr_2' })
  await E.addReply({ workspace_id: workspace, conversation_id: 'otc_1', thread_id: 'otmt_1', body: 'first reply' })
  await E.markRead({ workspace_id: workspace, conversation_id: 'otc_1', thread_id: 'otmt_1' })
  await E.resolveThread({ workspace_id: workspace, conversation_id: 'otc_1', thread_id: 'otmt_1', resolved: false })
  await E.deleteReply({ workspace_id: workspace, conversation_id: 'otc_1', thread_id: 'otmt_1', reply_id: 'otmr_1' })

  const base = `/v1/ot/workspaces/${workspace}/conversations/otc_1/threads`
  assert.deepEqual(f.calls.map((call) => `${call.method} ${call.path}`), [
    `POST ${base}`,
    `GET ${base}?include_resolved=false&limit=5&cursor=otmt_1`,
    `GET ${base}/otmt_1?limit=2&cursor=otmr_2`,
    `POST ${base}/otmt_1/replies`,
    `POST ${base}/otmt_1/read`,
    `POST ${base}/otmt_1/resolve`,
    `DELETE ${base}/otmt_1/replies/otmr_1`,
  ])
  assert.deepEqual(f.calls[0].body, { root_message_id: 'otm_1', title: 'Launch' })
  assert.deepEqual(f.calls[3].body, { body: 'first reply' })
  assert.deepEqual(f.calls[4].body, {})
  assert.deepEqual(f.calls[5].body, { resolved: false })
})

test('unscoped account conversations omit the workspace and default resolve to true', async () => {
  const { f, E } = endpoints()
  await E.createThread({ conversation_id: 'otc_2', root_message_id: 'otm_2' })
  await E.resolveThread({ conversation_id: 'otc_2', thread_id: 'otmt_2' })
  await E.markRead({ conversation_id: 'otc_2', thread_id: 'otmt_2', last_read: 123 })

  assert.deepEqual(f.calls.map((call) => `${call.method} ${call.path}`), [
    'POST /v1/ot/conversations/otc_2/threads',
    'POST /v1/ot/conversations/otc_2/threads/otmt_2/resolve',
    'POST /v1/ot/conversations/otc_2/threads/otmt_2/read',
  ])
  assert.deepEqual(f.calls[0].body, { root_message_id: 'otm_2' })
  assert.deepEqual(f.calls[1].body, { resolved: true })
  assert.deepEqual(f.calls[2].body, { last_read: 123 })
})

test('browser supplied ids never shape the Bot Social path', async () => {
  const { f, E } = endpoints()
  await assert.rejects(E.threadView({ conversation_id: '../teams', thread_id: 'otmt_1' }), /invalid/)
  await assert.rejects(E.deleteReply({ conversation_id: 'otc_1', thread_id: 'otmt_1', reply_id: '../x' }), /invalid/)
  await assert.rejects(E.createThread({ workspace_id: '../x', conversation_id: 'otc_1', root_message_id: 'otm_1' }), /invalid/)
  assert.equal(f.calls.length, 0)
})
