import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createAgents } from '../features/agents/index.js'
import { nativeAgentFixture } from './native-agent-fixture.js'

const W = 'a'.repeat(32)
const AGENT = 'c'.repeat(32)

function fixture() {
  const runtime = nativeAgentFixture()
  runtime.bots.main.name = 'Chief'
  runtime.bots.main.instructions = 'Y'
  runtime.bots.main.hidden = true
  runtime.services.rt.isMain = id => id === runtime.bots.main.id
  const host = {
    runtime: async () => runtime.services,
    currentRuntime: () => ({ rt: runtime.services.rt }),
    call: async name => {
      if (name === 'agents/personal-binding') return { workspace_id: W }
      if (name === 'teams/activeWorkspaces') return [{ id: W, role: 'owner' }]
      if (name === 'personal/get') return { recall: 'off' }
      throw new Error('Unexpected endpoint: ' + name)
    },
  }
  const db = new DatabaseSync(':memory:')
  const { endpoints } = createAgents({ db, host })
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT INTO agents (id, workspace_id, name, name_hash, summary, instructions, category, quick_starts,
    revision, created, updated, archived, key_hash, request_hash, inherit_capabilities, imported_from, portrait)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,0,?,?,1,NULL,NULL)`).run(
    AGENT, W, 'Personal Agent', 'h'.repeat(64), 'Personal workspace agent', 'X', null, '[]',
    now, now, 'k'.repeat(64), 'r'.repeat(64),
  )
  db.prepare('INSERT INTO native_personal_binding VALUES (1,?,?)').run(W, AGENT)
  return { endpoints, db, ...runtime }
}

test('binding a personal agent to the hidden native Chief keeps instructions and archive state', async () => {
  const f = fixture()
  const { agent } = await f.endpoints.get({ workspace_id: W, id: AGENT })
  assert.equal(agent.native_bot_id, f.bots.main.id)
  assert.equal(agent.instructions, 'X')
  assert.equal(agent.archived, 0)
  const listed = await f.endpoints.list({ workspace_id: W })
  assert.deepEqual(listed.items.map(row => row.id), [AGENT])
  const directory = await f.endpoints.v1({
    method: 'GET', path: `/v1/workspaces/${W}/agents?limit=100&include=conversations`,
  })
  assert.deepEqual(directory.body.items.map(row => row.id), [AGENT])
  assert.equal(directory.body.items[0].instructions, 'X')
  assert.equal(directory.body.items[0].archived, 0)
})

test('a no-op binding does not bump the agent revision, and a native rename still lands', async () => {
  const f = fixture()
  const first = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  assert.equal(first.revision, 1)
  const second = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  assert.equal(second.revision, 1)
  f.bots.main.name = 'Chief Renamed'
  const renamed = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  assert.equal(renamed.name, 'Chief Renamed')
  assert.equal(renamed.revision, 2)
})

test('a user-driven archive still archives the agent and hides the native Bot', async () => {
  const f = fixture()
  const archived = (await f.endpoints.archive({ workspace_id: W, id: AGENT, archived: true, revision: 1 })).agent
  assert.equal(archived.archived, 1)
  assert.equal(f.bots.main.hidden, true)
  const reread = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  assert.equal(reread.archived, 1)
  assert.equal(reread.instructions, 'X')
})

test('an archived agent mapped to the Chief keeps refusing startup snapshots after the Chief is unhidden', async () => {
  const f = fixture()
  const created = await f.endpoints['conversation-create']({ workspace_id: W, id: AGENT })
  assert.equal(created.status, 201)
  const conversationId = created.conversation.id
  const before = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  const archived = (await f.endpoints.archive({ workspace_id: W, id: AGENT, archived: true, revision: before.revision })).agent
  assert.equal(archived.archived, 1)
  // The archive write hides the native Chief; unhide it again so `hidden` can no
  // longer stand in for the archived flag. The agent row stays archived.
  assert.equal(f.bots.main.hidden, true)
  f.bots.main.hidden = false
  const reread = (await f.endpoints.get({ workspace_id: W, id: AGENT })).agent
  assert.equal(reread.archived, 1)
  const snapshot = await f.endpoints.v1({
    method: 'GET', path: `/v1/workspaces/${W}/agents/${AGENT}/conversations/${conversationId}?limit=50&snapshot=1`,
  })
  assert.equal(snapshot.status, 409)
  const entry = await f.endpoints.startupEntry(
    { workspace_id: W, agent_id: AGENT, conversation_id: conversationId }, { internal: true })
  assert.equal(entry, null)
})
