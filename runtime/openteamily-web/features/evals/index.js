// Agent evaluation suites: weighted cases carrying an expected rule, a run that
// scores the caller-supplied observed output per case, and comparison of two
// runs of the same suite. All rows live in this owner's own
// /data/openteamily/features/evals/evals.sqlite3 and never leave the volume.
//
// Scoring is a pure function of (weight, rule, output): there is no model call
// and no time or randomness in the total, so the same observations score the
// same number every time. Rules are `equals`, `contains` and `regex`; an
// unknown rule is refused when the case is added instead of being stored as a
// case that can never pass.
//
// This is a new feature directory: no legacy platform module existed and no
// bundle table is imported, so the tables start empty on every volume.
import { FeatureError, digest, newId, nowSeconds } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'

export const NAME_MAX = 200
export const VALUE_MAX = 2000
export const OUTPUT_MAX = 20_000
export const MAX_SUITES = 500
export const MAX_CASES = 100
export const MAX_WEIGHT = 1000
export const MAX_TOTAL_WEIGHT = 1000
export const MAX_RUNS_PER_SUITE = 1000
export const RULES = ['equals', 'contains', 'regex']

const ID = /^[0-9a-f]{32}$/

const invalid = (message) => { throw new FeatureError(400, 'evals/invalid', message) }
const notFound = (message) => { throw new FeatureError(404, 'evals/not-found', message) }
const conflict = (message) => { throw new FeatureError(409, 'evals/conflict', message) }
const suiteMismatch = (message) => { throw new FeatureError(409, 'evals/suite_mismatch', message) }

export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS eval_suites (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(owner_id, name_hash));
CREATE TABLE IF NOT EXISTS eval_cases (
 id TEXT PRIMARY KEY,
 suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 weight REAL NOT NULL CHECK(weight > 0),
 rule TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position >= 1),
 created INTEGER NOT NULL,
 UNIQUE(suite_id, name));
CREATE INDEX IF NOT EXISTS eval_case_suite ON eval_cases(suite_id, position);
CREATE TABLE IF NOT EXISTS eval_runs (
 id TEXT PRIMARY KEY,
 suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL,
 total REAL NOT NULL,
 total_weight REAL NOT NULL,
 passed INTEGER NOT NULL CHECK(passed >= 0),
 failed INTEGER NOT NULL CHECK(failed >= 0),
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS eval_run_suite ON eval_runs(suite_id, created, id);
CREATE TABLE IF NOT EXISTS eval_run_cases (
 run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
 case_id TEXT NOT NULL,
 name TEXT NOT NULL,
 weight REAL NOT NULL,
 passed INTEGER NOT NULL CHECK(passed IN (0,1)),
 detail TEXT NOT NULL,
 position INTEGER NOT NULL,
 PRIMARY KEY(run_id, case_id));
`]

// Printable text, no C0 controls (newlines only where the field allows them),
// no DEL and no lone surrogates. Length is counted in UTF-16 units.
function validText(value, maximum, { empty = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && value.length === 0)) return false
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code >= 0xd800 && code <= 0xdfff) return false
    if (code < 32 && !(multiline && (character === '\n' || character === '\r' || character === '\t'))) return false
    if (code === 127 || (code >= 0x80 && code <= 0x9f)) return false
  }
  return true
}

function boundedName(value, label) {
  if (!validText(value, NAME_MAX)) invalid(`${label} must be bounded printable text`)
  const text = value.trim()
  if (!text) invalid(`${label} must not be blank`)
  return text
}

const suiteName = (value) => boundedName(value, 'suite name')
const caseName = (value) => boundedName(value, 'case name')

function weightOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_WEIGHT) {
    invalid('weight must be a positive number within the limit')
  }
  return value
}

function expectedRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('expected rule object required')
  if (Object.keys(raw).some((key) => !['kind', 'value'].includes(key))) invalid('unknown expected rule field')
  if (typeof raw.kind !== 'string' || !RULES.includes(raw.kind)) invalid('unknown expected rule kind')
  const limit = raw.kind === 'regex' ? 500 : VALUE_MAX
  if (!validText(raw.value, limit)) invalid('expected rule value must be bounded text')
  if (raw.kind === 'regex') {
    try { new RegExp(raw.value) } catch { invalid('expected regex is not valid') }
  }
  return { kind: raw.kind, value: raw.value }
}

function readCase(store, suiteId, caseId) {
  const row = store.get('SELECT * FROM eval_cases WHERE suite_id=? AND id=?', suiteId, caseId)
  if (!row) notFound('case not found')
  return {
    id: row.id, suite_id: row.suite_id, name: row.name, weight: row.weight,
    expected: JSON.parse(row.rule), position: row.position, created: row.created,
  }
}

function ownSuite(store, owner, id) {
  if (typeof id !== 'string' || !ID.test(id)) invalid('suite id required')
  const row = store.get('SELECT id, name, created, updated FROM eval_suites WHERE id=? AND owner_id=?', id, owner)
  if (!row) notFound('suite not found')
  return row
}

function suiteView(store, row) {
  const cases = store.get('SELECT COUNT(*) AS n FROM eval_cases WHERE suite_id=?', row.id).n
  return { id: row.id, name: row.name, cases, created: row.created, updated: row.updated }
}

function readRun(store, owner, id) {
  if (typeof id !== 'string' || !ID.test(id)) invalid('run id required')
  const row = store.get('SELECT * FROM eval_runs WHERE id=? AND owner_id=?', id, owner)
  if (!row) notFound('run not found')
  const results = store.all('SELECT case_id, name, weight, passed, detail FROM eval_run_cases WHERE run_id=? ORDER BY position', id)
    .map((item) => ({
      case_id: item.case_id, name: item.name, weight: item.weight,
      passed: item.passed === 1, detail: item.detail,
    }))
  return {
    id: row.id, suite_id: row.suite_id, total: row.total, total_weight: row.total_weight,
    passed: row.passed, failed: row.failed, created: row.created, results,
  }
}

function evaluate(rule, output) {
  if (rule.kind === 'equals') return output === rule.value
  if (rule.kind === 'contains') return output.includes(rule.value)
  return new RegExp(rule.value).test(output)
}

const round4 = (value) => Math.round(value * 10000) / 10000

// A run needs exactly one observed output per case: either
// {case_id: output} or [{case_id, output}]. Anything else is refused before
// scoring so a typo cannot silently turn into a failed case.
function normalizeOutputs(raw, cases) {
  const known = new Set(cases.map((row) => row.id))
  const outputs = new Map()
  const add = (caseId, output) => {
    if (typeof caseId !== 'string' || !ID.test(caseId) || !known.has(caseId)) invalid('outputs reference an unknown case')
    if (outputs.has(caseId)) invalid('outputs repeat a case')
    if (!validText(output, OUTPUT_MAX, { empty: true, multiline: true })) invalid('each output must be bounded text')
    outputs.set(caseId, output)
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('output list items must be {case_id, output}')
      if (Object.keys(item).sort().join(',') !== 'case_id,output') invalid('output list items must be {case_id, output}')
      add(item.case_id, item.output)
    }
  } else if (raw && typeof raw === 'object') {
    for (const [caseId, output] of Object.entries(raw)) add(caseId, output)
  } else {
    invalid('outputs object or list required')
  }
  if (outputs.size !== cases.length) invalid('a run needs one output per case')
  return outputs
}

export default defineFeature({
  name: 'evals',
  migrations: MIGRATIONS,
  endpoints: ({ store, owner }) => ({
    async 'create-suite'(payload) {
      const name = suiteName(payload?.name)
      return store.transaction(() => {
        if (store.get('SELECT COUNT(*) AS n FROM eval_suites WHERE owner_id=?', owner).n >= MAX_SUITES) {
          invalid('suite limit reached')
        }
        const hash = digest(name)
        if (store.get('SELECT id FROM eval_suites WHERE owner_id=? AND name_hash=?', owner, hash)) {
          conflict('a suite with this name already exists')
        }
        const id = newId(), now = nowSeconds()
        store.run('INSERT INTO eval_suites VALUES(?,?,?,?,?,?)', id, owner, name, hash, now, now)
        return { suite: suiteView(store, { id, name, created: now, updated: now }) }
      })
    },
    async 'get-suite'(payload) {
      return { suite: suiteView(store, ownSuite(store, owner, payload?.id)) }
    },
    async 'list-suites'() {
      const rows = store.all('SELECT id, name, created, updated FROM eval_suites WHERE owner_id=? ORDER BY created DESC, id', owner)
      return { items: rows.map((row) => suiteView(store, row)) }
    },
    async 'delete-suite'(payload) {
      const suite = ownSuite(store, owner, payload?.id)
      store.run('DELETE FROM eval_suites WHERE id=? AND owner_id=?', suite.id, owner)
      return { deleted: true }
    },
    async 'add-case'(payload) {
      const suite = ownSuite(store, owner, payload?.suite_id)
      const name = caseName(payload?.name)
      const weight = weightOf(payload?.weight)
      const expected = expectedRule(payload?.expected)
      return store.transaction(() => {
        const count = store.get('SELECT COUNT(*) AS n FROM eval_cases WHERE suite_id=?', suite.id).n
        if (count >= MAX_CASES) invalid('case limit reached for this suite')
        const total = store.get('SELECT COALESCE(SUM(weight),0) AS total FROM eval_cases WHERE suite_id=?', suite.id).total
        if (total + weight > MAX_TOTAL_WEIGHT + 1e-9) invalid('total weight exceeds the limit')
        if (store.get('SELECT id FROM eval_cases WHERE suite_id=? AND name=?', suite.id, name)) {
          conflict('a case with this name already exists')
        }
        const id = newId(), now = nowSeconds()
        store.run('INSERT INTO eval_cases VALUES(?,?,?,?,?,?,?,?)',
          id, suite.id, owner, name, weight, JSON.stringify(expected), count + 1, now)
        store.run('UPDATE eval_suites SET updated=? WHERE id=?', now, suite.id)
        return { case: readCase(store, suite.id, id) }
      })
    },
    async 'list-cases'(payload) {
      const suite = ownSuite(store, owner, payload?.suite_id)
      const rows = store.all('SELECT id FROM eval_cases WHERE suite_id=? ORDER BY position, id', suite.id)
      return { items: rows.map((row) => readCase(store, suite.id, row.id)) }
    },
    async 'delete-case'(payload) {
      const suite = ownSuite(store, owner, payload?.suite_id)
      if (typeof payload?.case_id !== 'string' || !ID.test(payload.case_id)) invalid('case id required')
      const removed = store.run('DELETE FROM eval_cases WHERE suite_id=? AND id=?', suite.id, payload.case_id)
      if (!removed.changes) notFound('case not found')
      return { deleted: true }
    },
    async run(payload) {
      const suite = ownSuite(store, owner, payload?.suite_id)
      const cases = store.all('SELECT * FROM eval_cases WHERE suite_id=? ORDER BY position, id', suite.id)
      if (!cases.length) invalid('add at least one case before running this suite')
      const outputs = normalizeOutputs(payload?.outputs, cases)
      return store.transaction(() => {
        if (store.get('SELECT COUNT(*) AS n FROM eval_runs WHERE suite_id=?', suite.id).n >= MAX_RUNS_PER_SUITE) {
          invalid('run limit reached for this suite')
        }
        let points = 0, totalWeight = 0
        const results = cases.map((row) => {
          const rule = JSON.parse(row.rule)
          const passed = evaluate(rule, outputs.get(row.id))
          totalWeight += row.weight
          if (passed) points += row.weight
          return {
            case_id: row.id, name: row.name, weight: row.weight, passed,
            detail: `${rule.kind} ${passed ? 'matched' : 'missed'}`,
          }
        })
        const passed = results.filter((item) => item.passed).length
        const id = newId(), now = nowSeconds()
        store.run('INSERT INTO eval_runs VALUES(?,?,?,?,?,?,?,?)',
          id, suite.id, owner, round4(points / totalWeight), round4(totalWeight), passed, results.length - passed, now)
        for (const [index, result] of results.entries()) {
          store.run('INSERT INTO eval_run_cases VALUES(?,?,?,?,?,?,?)',
            id, result.case_id, result.name, result.weight, result.passed ? 1 : 0, result.detail, index)
        }
        return { run: readRun(store, owner, id) }
      })
    },
    async 'get-run'(payload) {
      return { run: readRun(store, owner, payload?.run_id) }
    },
    async compare(payload) {
      const base = readRun(store, owner, payload?.base_run_id)
      const head = readRun(store, owner, payload?.head_run_id)
      if (base.suite_id !== head.suite_id) suiteMismatch('runs belong to different suites')
      const headByCase = new Map(head.results.map((item) => [item.case_id, item]))
      const baseIds = new Set(base.results.map((item) => item.case_id))
      const cases = base.results.map((item) => {
        const other = headByCase.get(item.case_id)
        const headPassed = other ? other.passed : null
        return {
          case_id: item.case_id, name: item.name, weight: item.weight,
          base: item.passed, head: headPassed,
          delta: headPassed === null ? null : Number(headPassed) - Number(item.passed),
        }
      })
      for (const item of head.results) {
        if (baseIds.has(item.case_id)) continue
        cases.push({ case_id: item.case_id, name: item.name, weight: item.weight, base: null, head: item.passed, delta: null })
      }
      return {
        comparison: {
          suite_id: base.suite_id,
          base_run_id: base.id,
          head_run_id: head.id,
          total: { base: base.total, head: head.total, delta: round4(head.total - base.total) },
          cases,
          improved: cases.filter((item) => item.delta > 0).length,
          regressed: cases.filter((item) => item.delta < 0).length,
        },
      }
    },
  }),
})
