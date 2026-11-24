import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgentRuns } from '../features/agent-runs/index.js'
import { normalizeEvent } from '../lib/agent-runtime/contract.js'

const W = 'a'.repeat(32)
const A = 'b'.repeat(32)
const S = 'session-1'
const FOREIGN = 'c'.repeat(32)

function fixture({ allowed = W } = {}) {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-agent-runs-')), 'runs.sqlite3'))
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter(item => item !== handler))
      }
    },
  }
  const bot = { id: 'bot-1', openteamily: { workspace_id: W, agent_id: A } }
  const other = { id: 'bot-2' }
  const rt = {
    chatOwners: new Map([[S, 'bot-1'], ['other-session', 'bot-2']]),
    botOf: id => id === 'bot-1' ? bot : id === 'bot-2' ? other : undefined,
  }
  const host = {
    log: () => {},
    runtime: async () => ({ rt, ctx }),
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: allowed }
      if (name === 'teams/activeWorkspaces') return [{ id: allowed }]
      throw new Error('Unexpected endpoint ' + name)
    },
  }
  return { db, host, ctx, listeners, rt, bot, other }
}

const emit = (listeners, name, ...args) => {
  for (const handler of listeners.get(name) ?? []) handler(...args)
}

async function api(options) {
  const f = fixture(options)
  const created = await createAgentRuns({ host: f.host, db: f.db, clock: () => 1760000000 })
  await created.observer.ready
  return { ...f, ...created }
}

test('the observer records a real DSH turn as a durable run trace', async () => {
  const f = await api()
  try {
    emit(f.listeners, 'session/event', { id: S }, {
      type: 'turn/start', time: 1760000001000, data: { turn: 4 },
    })
    emit(f.listeners, 'session/event', { id: S }, {
      type: 'tool/call', time: 1760000002000, data: { turn: 4, callId: 'call-1', name: 'read_file', arguments: '{"path":"/x"}' },
    })
    emit(f.listeners, 'session/event', { id: S }, {
      type: 'assistant/message', time: 1760000003000, data: {
        turn: 4, step: 1, message: { content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 },
      },
    })
    emit(f.listeners, 'session/event', { id: S }, {
      type: 'turn/end', time: 1760000004000, data: { turn: 4, reason: { kind: 'completed' } },
    })

    const list = await f.endpoints.list({ workspace_id: W })
    assert.equal(list.items.length, 1)
    const run = list.items[0]
    assert.equal(run.agent_id, A)
    assert.equal(run.status, 'completed')
    assert.equal(run.tool_calls, 1)
    assert.equal(run.usage.input, 11)
    assert.equal(run.usage.cache_read, 3)
    assert.equal(run.usage.output, 5)
    assert.equal(run.event_count, 5)

    const replay = await f.endpoints.replay({ run_id: run.run_id })
    assert.deepEqual(replay.events.map(event => event.type), [
      'step.started', 'tool.call', 'assistant.message', 'usage', 'step.completed',
    ])
    assert.equal(replay.events[1].data.arguments.path, '/x')
  } finally {
    f.observer.dispose()
    f.db.close()
  }
})

test('stream frames, subagents and failures are traceable; non-agent sessions are ignored', async () => {
  const f = await api()
  try {
    emit(f.listeners, 'session/event', { id: S }, { type: 'turn/start', time: 1, data: { turn: 8 } })
    emit(f.listeners, 'session/event', { id: S }, { type: 'subagent/start', time: 2, data: { turn: 8, childId: 'child-1' } })
    emit(f.listeners, 'agent/assistant-stream', {
      time: 3, agent: { session: { id: S } },
      frame: { type: 'start', turn: 8, step: 1, attemptId: 'a-1' },
    })
    emit(f.listeners, 'agent/assistant-stream', {
      time: 4, agent: { session: { id: S } },
      frame: { type: 'chunk', turn: 8, step: 1, attemptId: 'a-1', chunk: { type: 'text-delta', text: 'hi' } },
    })
    emit(f.listeners, 'session/event', { id: S }, { type: 'turn/end', time: 5, data: { turn: 8, error: { code: 'boom' } } })
    emit(f.listeners, 'session/event', { id: 'other-session' }, { type: 'turn/start', time: 6, data: { turn: 1 } })

    const list = await f.endpoints.list({ workspace_id: W })
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].status, 'failed')
    assert.equal(list.items[0].subagent_count, 1)
    assert.equal(list.items[0].error_code, 'boom')
    const events = await f.endpoints.events({ run_id: list.items[0].run_id })
    assert.deepEqual(events.items.map(event => event.type), [
      'step.started', 'subagent.started', 'assistant.attempt', 'assistant.delta', 'step.failed',
    ])
  } finally {
    f.observer.dispose()
    f.db.close()
  }
})

test('manual runs, idempotent event ingest and usage aggregates work', async () => {
  const f = await api()
  try {
    const started = await f.endpoints.start({
      workspace_id: W, agent_id: A, session_id: 'manual-session', turn_id: '1', source: 'manual',
      at: 1760000001000,
    })
    assert.equal(started.created, true)
    const again = await f.endpoints.start({
      workspace_id: W, agent_id: A, session_id: 'manual-session', turn_id: '1', source: 'manual',
    })
    assert.equal(again.run.run_id, started.run.run_id)

    const usage = normalizeEvent(started.run.run_id, {
      type: 'usage', time: 1760000002000, data: { inputTokens: 7, outputTokens: 2, model: 'test' },
    })[0]
    const first = await f.endpoints.ingest({ run_id: started.run.run_id, events: [usage] })
    assert.equal(first.appended.length, 1)
    const replay = await f.endpoints.ingest({ run_id: started.run.run_id, events: [usage] })
    assert.equal(replay.appended.length, 0)
    assert.equal(replay.skipped.length, 1)
    const run = (await f.endpoints.get({ run_id: started.run.run_id })).run
    assert.equal(run.usage.input, 7)
    assert.equal(run.model, 'test')
    assert.equal(run.event_count, 1)

    const stats = await f.endpoints.stats({ workspace_id: W })
    assert.equal(stats.total, 1)
    assert.equal(stats.counts.running, 1)
  } finally {
    f.observer.dispose()
    f.db.close()
  }
})

test('workspace access, missing runs and foreign events fail closed', async () => {
  const f = await api({ allowed: W })
  try {
    const started = await f.endpoints.start({
      workspace_id: W, agent_id: A, session_id: 's', turn_id: '1',
    })
    await assert.rejects(f.endpoints.ingest({
      run_id: started.run.run_id,
      events: normalizeEvent('d'.repeat(32), { type: 'heartbeat', time: 1 }),
    }), (error) => error.status === 400)
    await assert.rejects(f.endpoints.get({ run_id: 'd'.repeat(32) }), (error) => error.status === 404)
    const foreign = await api({ allowed: FOREIGN })
    try {
      await assert.rejects(foreign.endpoints.list({ workspace_id: W }), (error) => error.status === 404)
    } finally {
      foreign.observer.dispose()
      foreign.db.close()
    }
  } finally {
    f.observer.dispose()
    f.db.close()
  }
})

test('contract endpoint states the runtime boundary and reuse', async () => {
  const f = await api()
  try {
    const contract = await f.endpoints.contract()
    assert.ok(contract.run_statuses.includes('running'))
    assert.ok(contract.reuse.includes('dsh session/event'))
    assert.ok(contract.not_in_this_feature.includes('tool policy'))
    assert.ok(contract.endpoints.includes('replay'))
  } finally {
    f.observer.dispose()
    f.db.close()
  }
})
