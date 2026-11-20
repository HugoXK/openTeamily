// Personal agent profile, kept in the user's own DS-Bot (moved from personal.py).
// The legacy `/v1/personal-agent` API is served here from the owner's migrated
// personal binding so /chat/ and /agents/ pages no longer need the platform.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { fail } from '../../src/store.js'

const DEFAULTS = Object.freeze({ name: 'My assistant', instructions: '', recall: 'all' })
const WORKSPACE_NAME = '个人空间'
const BUILTINS = Object.freeze([
  ['teamily-agent', 'Teamily Agent'],
  ['content-creator', 'Content Creator'],
  ['finance-assistant', 'Finance Assistant'],
  ['health-assistant', 'Health Assistant'],
  ['ai-stock-assistant', 'AI Stock Assistant'],
  ['market-research', 'Market Research'],
  ['travel-planner', 'Travel Planner'],
  ['accounting-assistant', 'Accounting Assistant'],
  ['slides-assistant', 'Slides Assistant'],
  ['webpage-developer', 'Webpage Developer'],
])

function legacyAgent(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: row.workspace_id ?? workspaceId,
    name: row.name,
    summary: row.summary ?? '',
    instructions: row.instructions ?? '',
    revision: row.revision ?? 1,
    created: row.created ?? 0,
    updated: row.updated ?? row.created ?? 0,
    created_by: row.created_by ?? ownerId(process.env),
    archived: row.archived ? 1 : 0,
    category: row.category ?? null,
    quick_starts: Array.isArray(row.quick_starts) ? row.quick_starts : [],
    homepage: row.homepage ?? { visibility: 'restricted' },
  }
}

export default function personal(host) {
  const file = () => join(host.featureDir(), 'profile.json')
  const read = () => {
    try { return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) } } catch { return { ...DEFAULTS } }
  }
  const call = (endpoint, payload) => host.call(endpoint, payload)

  async function binding() {
    try {
      const value = await call('agents/personal-binding')
      return value?.workspace_id && value?.agent_id ? value : null
    } catch (error) {
      if (error?.code === 'openteamily/not-found') return null
      throw error
    }
  }

  async function payload(current) {
    const { agent } = await call('agents/get', { workspace_id: current.workspace_id, id: current.agent_id })
    if (!agent) throw new Fault(404, 'not_found', 'Personal agent not found')
    let look = null
    try { look = (await call('settings/look'))?.look ?? null } catch { look = null }
    let builtinAgents = []
    try {
      const { items = [] } = await call('agents/list', { workspace_id: current.workspace_id })
      const byName = new Map(items.map((item) => [item.name, item]))
      builtinAgents = BUILTINS
        .filter(([, name]) => byName.has(name))
        .map(([key, name]) => ({ key, agent: legacyAgent(byName.get(name), current.workspace_id) }))
    } catch { builtinAgents = [] }
    return {
      personal_agent: {
        workspace: { id: current.workspace_id, name: WORKSPACE_NAME, kind: 'personal' },
        agent: legacyAgent(agent, current.workspace_id),
        look,
      },
      builtin_agents: builtinAgents,
    }
  }

  const routes = [
    {
      method: 'GET', path: /^\/v1\/personal-agent$/,
      async handle({ query }) {
        if (query) throw new Fault(400, 'invalid', 'Invalid personal agent request')
        const current = await binding()
        return [200, current ? await payload(current) : { personal_agent: null }]
      },
    },
    {
      method: 'POST', path: /^\/v1\/personal-agent$/,
      async handle() {
        const current = await binding()
        if (!current) throw new Fault(503, 'unavailable', 'Personal agent is not provisioned on this DS-Bot')
        return [200, await payload(current)]
      },
    },
  ]

  return {
    endpoints: {
      async get() { return read() },
      async set(payload) {
        if (!payload || typeof payload !== 'object') fail('personal/invalid', 'Object payload required')
        const next = read()
        if (payload.name !== undefined) {
          if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) fail('personal/invalid', 'Name must be 1–60 characters')
          next.name = payload.name.trim()
        }
        if (payload.instructions !== undefined) {
          if (typeof payload.instructions !== 'string' || payload.instructions.length > 4000) fail('personal/invalid', 'Instructions must be at most 4000 characters')
          next.instructions = payload.instructions
        }
        if (payload.recall !== undefined) {
          if (!['all', 'off'].includes(payload.recall)) fail('personal/invalid', 'personal recall must be all or off')
          next.recall = payload.recall
        }
        writeFileSync(file() + '.tmp', JSON.stringify(next), { mode: 0o600 })
        renameSync(file() + '.tmp', file())
        return next
      },
      v1: compatHandler(routes),
    },
  }
}
