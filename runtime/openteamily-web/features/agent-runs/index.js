// Agent run trace: the second OpenTeamily Agent Runtime capability.
//
// It persists normalized DSH events in this user's own DS-Bot and exposes a
// read/query API. It observes existing `session/event` and
// `agent/assistant-stream` events; it does not modify Agents, the runtime
// bridge, tool execution, subagents, permissions or Bot Social.
import { openDatabase } from '../../src/store.js'
import { HEX32, refuse } from '../../featurekit/http.js'
import { createRunStore, RUN_STATUSES, RUN_SOURCES } from './store.js'
import { attachRunObserver } from './observer.js'

const validId = (value) => typeof value === 'string' && HEX32.test(value)
const validText = (value, maximum = 200) => typeof value === 'string' && value.length >= 1
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const teams = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(teams) && teams.some(team => team?.id === workspace)
}

export async function createAgentRuns({ host, db, clock }) {
  const store = createRunStore(db, { clock })
  const observer = attachRunObserver({ host, store, log: host.log })

  async function requireWorkspace(workspace) {
    if (!validId(workspace)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!await canAccess(host, workspace)) refuse(404, 'not_found', 'Workspace not found')
    return workspace
  }

  async function requireRun(runId) {
    if (!validId(runId)) refuse(400, 'invalid', 'run_id must be 32 lowercase hex characters')
    const run = store.getRun(runId)
    if (!run) refuse(404, 'not_found', 'Agent run not found')
    await requireWorkspace(run.workspace_id)
    return run
  }

  const endpoints = {
    async start(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      const agent = payload?.agent_id
      if (!validId(agent)) refuse(400, 'invalid', 'agent_id must be 32 lowercase hex characters')
      if (!validText(payload?.session_id) || !validText(payload?.turn_id, 160)) {
        refuse(400, 'invalid', 'session_id and turn_id are required')
      }
      const source = payload?.source ?? 'manual'
      if (!RUN_SOURCES.includes(source)) refuse(400, 'invalid', 'Invalid run source')
      const created = store.ensureRun({
        workspace_id: workspace, agent_id: agent, session_id: payload.session_id,
        turn_id: String(payload.turn_id), source, at: payload.at,
      })
      return { run: created.run, created: created.created }
    },

    async ingest(payload) {
      const run = await requireRun(payload?.run_id)
      const events = payload?.events
      if (!Array.isArray(events) || !events.length || events.length > 500) {
        refuse(400, 'invalid', 'events must contain 1-500 normalized events')
      }
      for (const event of events) {
        if (event?.run_id !== run.run_id) refuse(400, 'invalid', 'All events must belong to the requested run')
      }
      return store.appendEvents(run.run_id, events)
    },

    async get(payload) {
      return { run: await requireRun(payload?.run_id) }
    },

    async list(payload) {
      if (payload?.workspace_id !== undefined) await requireWorkspace(payload.workspace_id)
      return store.listRuns(payload ?? {})
    },

    async events(payload) {
      const run = await requireRun(payload?.run_id)
      return { items: store.getEvents(run.run_id, payload ?? {}) }
    },

    async replay(payload) {
      const run = await requireRun(payload?.run_id)
      return { run, events: store.getEvents(run.run_id, { limit: 500 }) }
    },

    async stats(payload) {
      if (payload?.workspace_id !== undefined) await requireWorkspace(payload.workspace_id)
      return store.stats(payload ?? {})
    },

    async contract(payload) {
      return {
        run_statuses: [...RUN_STATUSES],
        run_sources: [...RUN_SOURCES],
        endpoints: ['start', 'ingest', 'get', 'list', 'events', 'replay', 'stats'],
        observer: 'session/event + agent/assistant-stream',
        reuse: ['dsh session/event', 'dsh agent/assistant-stream', 'agent-runtime-contract'],
        new_in_this_feature: ['durable trace store', 'run aggregates', 'query/replay API'],
        not_in_this_feature: ['execution', 'tool policy', 'subagent control', 'UI'],
      }
    },
  }

  return { endpoints, observer, store }
}

export default async function agentRuns(host) {
  const db = await openDatabase(host, 'agent-runs.sqlite3')
  const { endpoints, observer } = await createAgentRuns({ host, db })
  return { endpoints, observer }
}
