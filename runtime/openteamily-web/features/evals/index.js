// Agent evaluation suites, cases, deterministic rule scoring, runs and run
// comparison (port of #493's openteamily/agent_evaluations.py into the user's own
// DS-Bot).
//
// 纯规则评分、不调模型 — an evaluation never calls an agent turn, a model, the
// network or the clock: scoring is a pure function of the stored case checks and
// the caller-supplied candidate output. The same suite plus the same outputs
// always produce the same numbers bit for bit. Timestamps come only from the
// injected clock, and only for created/started/finished bookkeeping.
//
// A case owns 1-8 weighted checks (equals, contains, not-contains, regex,
// min-length, max-length). Its score is the weighted share of checks that pass;
// the run score is the weight-weighted mean of the case scores, recorded together
// with every part so a reviewer can recompute the total from the response alone.
// Ties are broken by case name, then case id, so a comparison never depends on
// insertion order. Every lookup is scoped by workspace: a suite, case or run from
// another workspace answers exactly like an id that never existed.
import { openDatabase, newId } from '../../src/store.js'

const ID = /^[0-9a-f]{32}$/
const LIMITS = { name: 80, agentId: 128, input: 8000, expected: 8000, output: 16000, checks: 8, page: 50, maxPage: 100, pattern: 200 }
const CASE_THRESHOLD = 0.5
const DEFAULT_THRESHOLD = 0.5
const KINDS = new Set(['equals', 'contains', 'not-contains', 'regex', 'min-length', 'max-length'])
const NUMERIC = new Set(['min-length', 'max-length'])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_suites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  name TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(workspace_id, agent_id, name));
CREATE INDEX IF NOT EXISTS eval_suite_workspace_agent ON eval_suites(workspace_id, agent_id, id);
CREATE TABLE IF NOT EXISTS eval_cases (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  position INTEGER NOT NULL, name TEXT NOT NULL, input TEXT NOT NULL, expected TEXT NOT NULL,
  weight REAL NOT NULL CHECK(weight > 0), checks TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(suite_id, name));
CREATE INDEX IF NOT EXISTS eval_case_suite ON eval_cases(suite_id, position, id);
CREATE TABLE IF NOT EXISTS eval_runs (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','failed')), score REAL, passed INTEGER,
  threshold REAL NOT NULL, started INTEGER NOT NULL, finished INTEGER);
CREATE INDEX IF NOT EXISTS eval_run_workspace_suite ON eval_runs(workspace_id, suite_id, id);
CREATE TABLE IF NOT EXISTS eval_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, output TEXT NOT NULL, score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
  passed INTEGER NOT NULL CHECK(passed IN (0,1)), parts TEXT NOT NULL, created INTEGER NOT NULL,
  UNIQUE(run_id, case_id));
CREATE INDEX IF NOT EXISTS eval_result_case ON eval_results(case_id);
`

const now = () => Math.floor(Date.now() / 1000)
const fail = (code, message, status) => { throw Object.assign(new Error(message), { code: `evals/${code}`, status }) }
// Fixed six-place rounding, applied at every boundary, so a stored score and a
// score recomputed from the stored parts are the same number.
const round6 = (n) => Math.round(n * 1e6) / 1e6
const normalize = (text) => String(text).replace(/\r\n?/g, '\n').trim()

function text(value, field, limit, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail('invalid', `${field} must be text`, 400)
  if (value.length > limit) fail('invalid', `${field} is longer than ${limit} characters`, 400)
  if (value.includes('\u0000')) fail('invalid', `${field} must not contain NUL`, 400)
  if (!allowEmpty && value.trim() === '') fail('invalid', `${field} must not be empty`, 400)
  return value
}

function name(value, field, limit) {
  text(value, field, limit, { allowEmpty: false })
  const clean = value.trim()
  if (clean.length > limit) fail('invalid', `${field} is longer than ${limit} characters`, 400)
  return clean
}

function positive(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('invalid', `${field} must be a finite number greater than 0`, 400)
  return value
}

function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('invalid', 'score must be a number between 0 and 1', 400)
  return value
}

function page(cursor, limit) {
  const size = limit === undefined ? LIMITS.page : limit
  if (!Number.isInteger(size) || size < 1 || size > LIMITS.maxPage) fail('invalid', `limit must be between 1 and ${LIMITS.maxPage}`, 400)
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 64)) fail('invalid', 'cursor must be text', 400)
  return { cursor: cursor ?? null, size }
}

// Resolve the stored checks once, at write time, so scoring never re-reads the
// request and cannot drift with the caller's later changes.
function parseChecks(value, expected) {
  const list = value === undefined ? [{ kind: 'equals' }] : value
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.checks) fail('invalid', `Provide 1-${LIMITS.checks} checks`, 400)
  return list.map((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) fail('invalid', 'Each check must be an object', 400)
    const kind = String(check.kind ?? '')
    if (!KINDS.has(kind)) fail('invalid', `Unknown check kind ${kind.slice(0, 20)}`, 400)
    const weight = check.weight === undefined ? 1 : positive(check.weight, 'check weight')
    if (NUMERIC.has(kind)) {
      const value = check.value
      if (!Number.isInteger(value) || value < 0 || value > LIMITS.output) fail('invalid', `${kind} needs an integer value between 0 and ${LIMITS.output}`, 400)
      return { kind, value, weight }
    }
    const value = check.value === undefined ? expected : text(check.value, 'check value', LIMITS.expected)
    if (kind === 'regex') {
      if (value.length > LIMITS.pattern) fail('invalid', `A pattern is limited to ${LIMITS.pattern} characters`, 400)
      try { new RegExp(value) } catch { fail('invalid', 'The pattern is not a valid regular expression', 400) }
    }
    return { kind, value, weight }
  })
}

function passes(check, output) {
  const haystack = normalize(output)
  switch (check.kind) {
    case 'equals': return haystack === normalize(check.value)
    case 'contains': return haystack.includes(normalize(check.value))
    case 'not-contains': return !haystack.includes(normalize(check.value))
    case 'regex': return new RegExp(check.value).test(haystack)
    case 'min-length': return haystack.length >= check.value
    case 'max-length': return haystack.length <= check.value
    default: return false
  }
}

// Score one case: the weighted share of its checks that pass. Parts are kept in
// stored order, so the breakdown is reproducible and auditable on its own.
function scoreCase(kase, output) {
  const parts = kase.checks.map((check) => ({ kind: check.kind, value: check.value, weight: check.weight, ok: passes(check, output) }))
  const total = parts.reduce((sum, part) => sum + part.weight, 0)
  const hit = parts.reduce((sum, part) => sum + (part.ok ? part.weight : 0), 0)
  const score = round6(hit / total)
  return { score, passed: score >= CASE_THRESHOLD, parts }
}

export function createEvals({ db, host, clock = now, log = () => {} }) {
  db.exec(SCHEMA)
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const ws = (payload) => {
    if (typeof payload?.workspace_id !== 'string' || !ID.test(payload.workspace_id)) fail('invalid', 'workspace_id required', 400)
    return payload.workspace_id
  }
  const suiteView = (row) => ({ id: row.id, workspace_id: row.workspace_id, agent_id: row.agent_id, name: row.name,
    created: row.created, updated: row.updated })
  const caseView = (row) => ({ id: row.id, suite_id: row.suite_id, workspace_id: row.workspace_id, position: row.position,
    name: row.name, input: row.input, expected: row.expected, weight: row.weight, checks: JSON.parse(row.checks), created: row.created })
  const resultView = (row, kase) => ({ id: row.id, run_id: row.run_id, case_id: row.case_id, case_name: kase.name,
    weight: kase.weight, output: row.output, score: row.score, passed: Boolean(row.passed), parts: JSON.parse(row.parts), created: row.created })
  const runView = (row) => ({ id: row.id, suite_id: row.suite_id, workspace_id: row.workspace_id, status: row.status,
    score: row.score, passed: row.passed === null ? null : Boolean(row.passed), threshold: row.threshold,
    started: row.started, finished: row.finished })

  // Every lookup carries workspace_id: a foreign id is indistinguishable from an
  // absent one, including the message.
  const loadSuite = (workspaceId, id) => {
    const row = typeof id === 'string' && ID.test(id) ? one('SELECT * FROM eval_suites WHERE id=? AND workspace_id=?', id, workspaceId) : undefined
    if (!row) fail('not-found', 'Evaluation suite not found', 404)
    return row
  }
  const loadRun = (workspaceId, id) => {
    const row = typeof id === 'string' && ID.test(id) ? one('SELECT * FROM eval_runs WHERE id=? AND workspace_id=?', id, workspaceId) : undefined
    if (!row) fail('not-found', 'Evaluation run not found', 404)
    return row
  }
  const casesOf = (workspaceId, suiteId) => all('SELECT * FROM eval_cases WHERE workspace_id=? AND suite_id=? ORDER BY position', workspaceId, suiteId)

  function resultsOf(workspaceId, runRow) {
    const cases = new Map(casesOf(workspaceId, runRow.suite_id).map((kase) => [kase.id, kase]))
    const rows = all('SELECT * FROM eval_results WHERE workspace_id=? AND run_id=?', workspaceId, runRow.id)
    return rows.map((row) => resultView(row, cases.get(row.case_id))).sort((a, b) => cases.get(a.case_id).position - cases.get(b.case_id).position)
  }

  function fullRun(workspaceId, runRow) {
    const results = resultsOf(workspaceId, runRow)
    const caseCount = one('SELECT COUNT(*) AS n FROM eval_cases WHERE workspace_id=? AND suite_id=?', workspaceId, runRow.suite_id).n
    return { ...runView(runRow), case_count: Number(caseCount), result_count: results.length, results }
  }

  const endpoints = {
    async 'create-suite'(payload) {
      const workspaceId = ws(payload)
      const agentId = name(payload.agent_id, 'agent_id', LIMITS.agentId)
      const clean = name(payload.name, 'name', LIMITS.name)
      // Only this workspace's roster answers; anything else is the same 404.
      try {
        await host.call('agents/get', { workspace_id: workspaceId, id: agentId })
      } catch {
        fail('not-found', 'Agent not found', 404)
      }
      if (one('SELECT id FROM eval_suites WHERE workspace_id=? AND agent_id=? AND name=?', workspaceId, agentId, clean)) {
        fail('conflict', 'A suite with this name already exists for the agent', 409)
      }
      const id = newId()
      const t = clock()
      run('INSERT INTO eval_suites VALUES(?,?,?,?,?,?)', id, workspaceId, agentId, clean, t, t)
      return { status: 201, suite: suiteView(loadSuite(workspaceId, id)) }
    },

    async 'list-suites'(payload) {
      const workspaceId = ws(payload)
      const { cursor, size } = page(payload.cursor, payload.limit)
      const filters = ['workspace_id=?']
      const args = [workspaceId]
      if (payload.agent_id !== undefined) { filters.push('agent_id=?'); args.push(name(payload.agent_id, 'agent_id', LIMITS.agentId)) }
      if (cursor) { filters.push('id>?'); args.push(cursor) }
      const rows = all(`SELECT * FROM eval_suites WHERE ${filters.join(' AND ')} ORDER BY id LIMIT ?`, ...args, size)
      return { items: rows.map(suiteView), cursor: rows.length === size ? rows[rows.length - 1].id : null }
    },

    async 'get-suite'(payload) {
      const workspaceId = ws(payload)
      const suite = loadSuite(workspaceId, payload.id)
      return { suite: suiteView(suite), cases: casesOf(workspaceId, suite.id).map(caseView) }
    },

    async 'add-case'(payload) {
      const workspaceId = ws(payload)
      const suite = loadSuite(workspaceId, payload.suite_id)
      const clean = name(payload.name, 'name', LIMITS.name)
      const input = text(payload.input, 'input', LIMITS.input)
      const expected = text(payload.expected, 'expected', LIMITS.expected)
      const weight = payload.weight === undefined ? 1 : positive(payload.weight, 'weight')
      const checks = parseChecks(payload.checks, expected)
      if (one('SELECT id FROM eval_cases WHERE suite_id=? AND name=?', suite.id, clean)) fail('conflict', 'A case with this name already exists in the suite', 409)
      const id = newId()
      const t = clock()
      const position = all('SELECT position FROM eval_cases WHERE suite_id=?', suite.id).reduce((max, row) => Math.max(max, row.position), -1) + 1
      run('INSERT INTO eval_cases VALUES(?,?,?,?,?,?,?,?,?,?)', id, suite.id, workspaceId, position, clean, input, expected, weight, JSON.stringify(checks), t)
      run('UPDATE eval_suites SET updated=? WHERE id=? AND workspace_id=?', t, suite.id, workspaceId)
      return { status: 201, case: caseView(one('SELECT * FROM eval_cases WHERE id=?', id)) }
    },

    async 'list-cases'(payload) {
      const workspaceId = ws(payload)
      const suite = loadSuite(workspaceId, payload.suite_id)
      const { cursor, size } = page(payload.cursor, payload.limit)
      if (cursor !== null && !/^\d{1,9}$/.test(cursor)) fail('invalid', 'cursor must be a case position', 400)
      const rows = all('SELECT * FROM eval_cases WHERE workspace_id=? AND suite_id=? AND position>? ORDER BY position LIMIT ?',
        workspaceId, suite.id, cursor === null ? -1 : Number(cursor), size)
      return { items: rows.map(caseView), cursor: rows.length === size ? String(rows[rows.length - 1].position) : null }
    },

    // One call: score every case against the supplied outputs, store the run, and
    // return the parts. Cases with no output count as zero and are reported through
    // case_count/result_count rather than silently changing the denominator.
    async evaluate(payload) {
      const workspaceId = ws(payload)
      const suite = loadSuite(workspaceId, payload.suite_id)
      const cases = casesOf(workspaceId, suite.id).map(caseView)
      if (!cases.length) fail('invalid', 'Add at least one case before evaluating', 400)
      const outputs = payload.outputs === undefined ? [] : payload.outputs
      if (!Array.isArray(outputs)) fail('invalid', 'outputs must be a list of {case_id, output}', 400)
      const known = new Map(cases.map((kase) => [kase.id, kase]))
      const supplied = new Map()
      for (const item of outputs) {
        if (!item || typeof item !== 'object' || typeof item.case_id !== 'string') fail('invalid', 'Every output needs a case_id', 400)
        if (!known.has(item.case_id)) fail('not-found', 'Evaluation case not found', 404)
        if (supplied.has(item.case_id)) fail('invalid', 'Each case takes one output', 400)
        supplied.set(item.case_id, text(item.output === undefined ? '' : String(item.output), 'output', LIMITS.output))
      }
      const threshold = payload.threshold === undefined ? DEFAULT_THRESHOLD : unit(payload.threshold)
      const id = newId()
      const started = clock()
      run('INSERT INTO eval_runs VALUES(?,?,?,?,?,?,?,?,?)', id, suite.id, workspaceId, 'completed', null, null, threshold, started, null)
      const scored = []
      for (const kase of cases) {
        if (!supplied.has(kase.id)) continue
        const { score, passed, parts } = scoreCase(kase, supplied.get(kase.id))
        run('INSERT INTO eval_results VALUES(?,?,?,?,?,?,?,?,?)', newId(), id, kase.id, workspaceId, supplied.get(kase.id), score, passed ? 1 : 0, JSON.stringify(parts), clock())
        scored.push({ kase, score, passed })
      }
      // Weighted mean over every case in the suite, in stored position order; a case
      // without an output contributes weight * 0.
      const weightSum = cases.reduce((sum, kase) => sum + kase.weight, 0)
      const total = scored.reduce((sum, row) => sum + row.kase.weight * row.score, 0)
      const score = round6(weightSum ? total / weightSum : 0)
      const passed = score >= threshold
      run('UPDATE eval_runs SET score=?, passed=?, finished=? WHERE id=? AND workspace_id=?', score, passed ? 1 : 0, clock(), id, workspaceId)
      log(`evaluation ${id} scored ${score} over ${scored.length}/${cases.length} cases`)
      return { run: fullRun(workspaceId, loadRun(workspaceId, id)) }
    },

    async 'get-run'(payload) {
      const workspaceId = ws(payload)
      return { run: fullRun(workspaceId, loadRun(workspaceId, payload.id)) }
    },

    async 'list-runs'(payload) {
      const workspaceId = ws(payload)
      const { cursor, size } = page(payload.cursor, payload.limit)
      const filters = ['workspace_id=?']
      const args = [workspaceId]
      if (payload.suite_id !== undefined) { filters.push('suite_id=?'); args.push(loadSuite(workspaceId, payload.suite_id).id) }
      if (cursor) { filters.push('id>?'); args.push(cursor) }
      const rows = all(`SELECT * FROM eval_runs WHERE ${filters.join(' AND ')} ORDER BY id LIMIT ?`, ...args, size)
      return { items: rows.map(runView), cursor: rows.length === size ? rows[rows.length - 1].id : null }
    },

    async compare(payload) {
      const workspaceId = ws(payload)
      const first = loadRun(workspaceId, payload.run_a)
      const second = loadRun(workspaceId, payload.run_b)
      if (first.suite_id !== second.suite_id) fail('invalid', 'Runs must belong to the same evaluation suite', 400)
      const cases = casesOf(workspaceId, first.suite_id)
      const resultsA = new Map(all('SELECT * FROM eval_results WHERE workspace_id=? AND run_id=?', workspaceId, first.id).map((row) => [row.case_id, row]))
      const resultsB = new Map(all('SELECT * FROM eval_results WHERE workspace_id=? AND run_id=?', workspaceId, second.id).map((row) => [row.case_id, row]))
      const rows = cases.map((kase) => {
        const a = resultsA.get(kase.id)
        const b = resultsB.get(kase.id)
        return { case_id: kase.id, case_name: kase.name, weight: kase.weight,
          score_a: a ? a.score : null, score_b: b ? b.score : null,
          passed_a: a ? Boolean(a.passed) : null, passed_b: b ? Boolean(b.passed) : null,
          delta: a && b ? round6(b.score - a.score) : null }
      })
      // Stable tie-break: delta, then case name, then case id. Never insertion order.
      const ranking = rows.filter((row) => row.delta !== null)
        .sort((x, y) => y.delta - x.delta || (x.case_name < y.case_name ? -1 : x.case_name > y.case_name ? 1 : 0)
          || (x.case_id < y.case_id ? -1 : x.case_id > y.case_id ? 1 : 0))
      const aggregate = first.score === null || second.score === null ? null : round6(second.score - first.score)
      return { comparison: { workspace_id: workspaceId, suite_id: first.suite_id, run_a: runView(first), run_b: runView(second),
        cases: rows, ranking, aggregate_delta: aggregate } }
    },

    async 'remove-suite'(payload) {
      const workspaceId = ws(payload)
      const suite = loadSuite(workspaceId, payload.id)
      run('DELETE FROM eval_results WHERE workspace_id=? AND run_id IN (SELECT id FROM eval_runs WHERE workspace_id=? AND suite_id=?)', workspaceId, workspaceId, suite.id)
      run('DELETE FROM eval_runs WHERE workspace_id=? AND suite_id=?', workspaceId, suite.id)
      run('DELETE FROM eval_cases WHERE workspace_id=? AND suite_id=?', workspaceId, suite.id)
      run('DELETE FROM eval_suites WHERE id=? AND workspace_id=?', suite.id, workspaceId)
      return { removed: suite.id }
    },
  }
  return { endpoints, db }
}

export default async function evals(host) {
  const db = await openDatabase(host, 'evals.sqlite3')
  const feature = createEvals({ db, host, clock: host.clock ?? now, log: host.log })
  const wrapped = {}
  for (const [name, handler] of Object.entries(feature.endpoints)) wrapped[name] = async (payload) => handler(payload ?? {})
  return { pages: [], endpoints: wrapped }
}
