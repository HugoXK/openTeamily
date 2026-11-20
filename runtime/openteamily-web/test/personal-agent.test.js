import assert from 'node:assert/strict'
import test from 'node:test'
import { boot, WS } from './helpers.js'
import { attachRuntime, detachRuntime } from '../src/host.js'

const PERSONAL = 'a'.repeat(32)
const BUILTIN = 'b'.repeat(32)
const CREATED = 1800000000

function stubRuntime() {
  const bots = new Map()
  let next = 0
  const rt = {
    state: { bots: {} },
    botOf(id) { return bots.get(id) },
    async createBot({ name, instructions }) {
      const bot = { id: 'native-' + (++next), name, instructions, capabilities: [], hidden: false }
      bots.set(bot.id, bot)
      rt.state.bots[bot.id] = bot
      return bot
    },
    async save() {},
  }
  return { rt, ctx: {}, mainBot: async () => 'main' }
}

function agent(id, name, summary) {
  return { id, workspace_id: WS, name, summary, instructions: '', revision: 1, created: CREATED, updated: CREATED, archived: 0 }
}

test('personal legacy /v1 uses the migrated personal binding on this DS-Bot', async () => {
  const app = await boot()
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, { personal_agent: null })
  const unavailable = await app.call('personal', 'POST', '/v1/personal-agent')
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.body.error.code, 'unavailable')

  const imported = await app.endpoint('agents/import', {
    agents: [agent(PERSONAL, "alice's Personal Agent", 'Your Cross-context Super AI Agent.'), agent(BUILTIN, 'Teamily Agent', 'Teamily 平台助手')],
  })
  assert.equal(imported.ok, true)
  attachRuntime(stubRuntime())
  try {
    const adopted = await app.endpoint('agents/adopt-personal-chat', { workspace_id: WS, id: PERSONAL })
    assert.equal(adopted.ok, true)
    const created = await app.call('personal', 'POST', '/v1/personal-agent')
    assert.equal(created.status, 200)
    const personal = created.body.personal_agent
    assert.equal(personal.workspace.id, WS)
    assert.equal(personal.workspace.name, '个人空间')
    assert.equal(personal.workspace.kind, 'personal')
    assert.equal(personal.agent.id, PERSONAL)
    assert.equal(personal.agent.summary, 'Your Cross-context Super AI Agent.')
    assert.deepEqual(created.body.builtin_agents.map((item) => item.key), ['teamily-agent'])
    assert.equal(created.body.builtin_agents[0].agent.id, BUILTIN)
    assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, created.body)
    const bad = await app.call('personal', 'GET', '/v1/personal-agent?unexpected=1')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'invalid')
  } finally { detachRuntime() }
})

test('the retired homepage start is not claimed by the homepages feature', async () => {
  const app = await boot()
  const result = await app.endpoint('homepages/v1', { method: 'POST', path: '/v1/agent-homepages/start', body: { quick_start: 0 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'openteamily/not-found')
})
