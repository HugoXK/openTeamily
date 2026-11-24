// Durable OpenTeamily agent-run trace store. It consumes the normalized events
// from lib/agent-runtime/contract.js; it does not execute a model, tool or
// subagent. All rows live in this user's own DS-Bot volume.
import { createHash } from 'node:crypto'
import { HEX32, refuse } from '../../featurekit/http.js'
import { validateEvent } from '../../lib/agent-runtime/contract.js'

export const RUN_STATUSES = Object.freeze(['running', 'completed', 'failed', 'cancelled'])
export const RUN_SOURCES = Object.freeze(['dsh', 'manual'])
const CURSOR = /^([0-9]{1,16})\.([0-9a-f]{32})$/
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
  source TEXT NOT NULL CHECK(source IN ('dsh','manual')),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  finished INTEGER,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  UNIQUE(session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS agent_runs_workspace ON agent_runs(workspace_id, updated DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent_id, updated DESC, run_id DESC);
CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status, updated DESC, run_id DESC);
CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_run_events_order ON agent_run_events(run_id, sequence);
`

export function runIdFor(workspaceId, agentId, sessionId, turnId) {
  return createHash('sha256')
    .update([workspaceId, agentId, sessionId, turnId].join('\0'), 'utf8')
    .digest('hex').slice(0, 32)
}

const validId = (value) => typeof value === 'string' && HEX32.test(value)
const validText = (value, maximum = 200) => typeof value === 'string' && value.length >= 1
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)

function seconds(at, now) {
  const value = Math.floor(Number(at) / 1000)
  return Number.isSafeInteger(value) && value > 0 ? value : now
}

function viewRun(row) {
  if (!row) return null
  return {
    run_id: row.run_id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    status: row.status,
    source: row.source,
    created: row.created,
    updated: row.updated,
    finished: row.finished,
    duration_ms: row.finished ? Math.max(0, (row.finished - row.created) * 1000) : null,
    provider: row.provider,
    model: row.model,
    usage: {
      input: row.input_tokens,
      cache_read: row.cache_read_tokens,
      cache_write: row.cache_write_tokens,
      output: row.output_tokens,
    },
    tool_calls: row.tool_calls,
    subagent_count: row.subagent_count,
    retry_count: row.retry_count,
    event_count: row.event_count,
    error_code: row.error_code,
  }
}

function errorCode(event) {
  const reason = event.data?.reason
  const candidate = reason?.code ?? reason?.reason?.code ?? event.data?.error?.code
    ?? (typeof event.data?.error === 'string' ? event.data.error : null)
  return typeof candidate === 'string' && candidate.length <= 120 ? candidate : 'failed'
}

export function createRunStore(db, { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(SCHEMA)
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const now = () => Math.max(0, Math.floor(clock()))

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  function getRun(runId) {
    if (!validId(runId)) refuse(400, 'invalid', 'run_id must be 32 lowercase hex characters')
    return viewRun(one('SELECT * FROM agent_runs WHERE run_id=?', runId))
  }

  function ensureRun(payload) {
    const workspaceId = payload?.workspace_id
    const agentId = payload?.agent_id
    const sessionId = payload?.session_id
    const turnId = String(payload?.turn_id ?? '')
    const source = payload?.source ?? 'dsh'
    if (!validId(workspaceId) || !validId(agentId) || !validText(sessionId) || !validText(turnId, 160)) {
      refuse(400, 'invalid', 'workspace_id, agent_id, session_id and turn_id are required')
    }
    if (!RUN_SOURCES.includes(source)) refuse(400, 'invalid', 'Invalid run source')
    const at = seconds(payload?.at, now())
    const runId = runIdFor(workspaceId, agentId, sessionId, turnId)
    const created = run(`INSERT OR IGNORE INTO agent_runs
      (run_id,workspace_id,agent_id,session_id,turn_id,status,source,created,updated)
      VALUES(?,?,?,?,?,'running',?,?,?)`,
    runId, workspaceId, agentId, sessionId, turnId, source, at, at)
    return { run: getRun(runId), created: created.changes > 0 }
  }

  function nextSequence(runId) {
    const row = one('SELECT COALESCE(MAX(sequence),-1) AS last FROM agent_run_events WHERE run_id=?', runId)
    return Number(row?.last ?? -1) + 1
  }

  function updateAggregates(event) {
    const runId = event.run_id
    const at = seconds(event.at, now())
    if (event.type === 'usage') {
      run(`UPDATE agent_runs SET updated=?, event_count=event_count+1,
        input_tokens=input_tokens+?, cache_read_tokens=cache_read_tokens+?,
        cache_write_tokens=cache_write_tokens+?, output_tokens=output_tokens+?,
        provider=COALESCE(?,provider), model=COALESCE(?,model) WHERE run_id=?`,
      at, Number(event.data?.input) || 0, Number(event.data?.cache_read) || 0,
      Number(event.data?.cache_write) || 0, Number(event.data?.output) || 0,
      event.data?.provider ?? null, event.data?.model ?? null, runId)
      return
    }
    if (event.type === 'tool.call') {
      run('UPDATE agent_runs SET updated=?, event_count=event_count+1, tool_calls=tool_calls+1 WHERE run_id=?', at, runId)
      return
    }
    if (event.type === 'subagent.started') {
      run('UPDATE agent_runs SET updated=?, event_count=event_count+1, subagent_count=subagent_count+1 WHERE run_id=?', at, runId)
      return
    }
    if (event.type === 'step.retried') {
      run('UPDATE agent_runs SET updated=?, event_count=event_count+1, retry_count=retry_count+1 WHERE run_id=?', at, runId)
      return
    }
    const terminal = event.type === 'run.completed' || event.type === 'step.completed' ? 'completed'
      : event.type === 'run.failed' || event.type === 'step.failed' ? 'failed'
      : event.type === 'run.cancelled' || event.type === 'step.cancelled' ? 'cancelled' : null
    if (terminal) {
      run(`UPDATE agent_runs SET updated=?, event_count=event_count+1, status=?, finished=?, error_code=?
        WHERE run_id=? AND status='running'`,
      at, terminal, at, terminal === 'failed' ? errorCode(event) : null, runId)
      return
    }
    run('UPDATE agent_runs SET updated=?, event_count=event_count+1 WHERE run_id=?', at, runId)
  }

  function appendEvents(runId, events) {
    if (!Array.isArray(events) || !events.length || events.length > 500) {
      refuse(400, 'invalid', 'events must contain 1-500 normalized events')
    }
    if (!getRun(runId)) refuse(404, 'not_found', 'Agent run not found')
    const appended = []
    const skipped = []
    transaction(() => {
      for (const event of events) {
        validateEvent(event)
        if (event.run_id !== runId) refuse(400, 'invalid', 'Event belongs to another run')
        const byId = one('SELECT run_id, sequence FROM agent_run_events WHERE event_id=?', event.event_id)
        if (byId) {
          skipped.push(event.event_id)
          continue
        }
        const atSequence = one('SELECT event_id FROM agent_run_events WHERE run_id=? AND sequence=?', runId, event.sequence)
        if (atSequence) refuse(409, 'conflict', 'Event sequence is already used by another event')
        run('INSERT INTO agent_run_events (run_id,sequence,event_id,type,at,payload) VALUES(?,?,?,?,?,?)',
          runId, event.sequence, event.event_id, event.type, event.at, JSON.stringify(event))
        updateAggregates(event)
        appended.push(event.event_id)
      }
    })
    return { run: getRun(runId), appended, skipped }
  }

  function listRuns(payload = {}) {
    const limit = Number(payload.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) refuse(400, 'invalid', 'limit must be 1-100')
    const status = payload.status ?? null
    if (status !== null && !RUN_STATUSES.includes(status)) refuse(400, 'invalid', 'Invalid run status')
    const workspace = payload.workspace_id ?? null
    const agent = payload.agent_id ?? null
    if (workspace !== null && !validId(workspace)) refuse(400, 'invalid', 'Invalid workspace_id')
    if (agent !== null && !validId(agent)) refuse(400, 'invalid', 'Invalid agent_id')
    const cursor = payload.cursor ?? ''
    const position = cursor ? CURSOR.exec(cursor) : null
    if (cursor && !position) refuse(400, 'invalid', 'Invalid cursor')
    const where = []
    const args = []
    if (workspace) { where.push('workspace_id=?'); args.push(workspace) }
    if (agent) { where.push('agent_id=?'); args.push(agent) }
    if (status) { where.push('status=?'); args.push(status) }
    if (position) { where.push('(updated,run_id)<(?,?)'); args.push(Number(position[1]), position[2]) }
    const rows = all(`SELECT * FROM agent_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY updated DESC,run_id DESC LIMIT ?`, ...args, limit + 1)
    const items = rows.slice(0, limit).map(viewRun)
    const last = items.at(-1)
    return { items, cursor: rows.length > limit && last ? `${last.updated}.${last.run_id}` : null }
  }

  function getEvents(runId, payload = {}) {
    if (!getRun(runId)) refuse(404, 'not_found', 'Agent run not found')
    const after = payload.after_sequence ?? -1
    const limit = Number(payload.limit ?? 200)
    if (!Number.isInteger(after) || after < -1) refuse(400, 'invalid', 'Invalid after_sequence')
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) refuse(400, 'invalid', 'limit must be 1-500')
    const rows = all('SELECT sequence,payload FROM agent_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
      runId, after, limit)
    return rows.map(row => JSON.parse(row.payload))
  }

  function stats(payload = {}) {
    const workspace = payload.workspace_id ?? null
    if (workspace !== null && !validId(workspace)) refuse(400, 'invalid', 'Invalid workspace_id')
    const rows = all(`SELECT status,COUNT(*) AS count FROM agent_runs ${workspace ? 'WHERE workspace_id=?' : ''}
      GROUP BY status`, ...(workspace ? [workspace] : []))
    const counts = Object.fromEntries(RUN_STATUSES.map(status => [status, 0]))
    for (const row of rows) counts[row.status] = row.count
    return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) }
  }

  return { ensureRun, getRun, nextSequence, appendEvents, listRuns, getEvents, stats, runIdFor }
}
