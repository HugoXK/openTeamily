// Agent evaluation suites: rule scoring, per-check parts, run comparison.
// The feature is a port of #493's openteamily/agent_evaluations.py; these tests
// pin the four judgement points: determinism, auditable parts, workspace
// isolation, and no model or network call.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEvals } from '../features/evals/index.js'
import { loadFeatures } from '../src/features.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W1 = 'a'.repeat(32)
const W2 = 'b'.repeat(32)
const MINE = '1'.repeat(32)
const THEIRS = '2'.repeat(32)
const round6 = (n) => Math.round(n * 1e6) / 1e6

// The feature only ever asks the roster one question: does this agent exist in
// this workspace? The stub answers that contract; agents/get itself is covered by
// test/agents.test.js.
async function fixture() {
  const calls = []
  const table = {
    'agents/get': async ({ workspace_id, id }) => {
      if (workspace_id !== W1 || id !== MINE) throw Object.assign(new Error('Agent not found'), { code: 'agents/not-found', status: 404 })
      return { agent: { id: MINE, workspace_id: W1, name: '研究', archived: 0 } }
    },
  }
  const host = {
    identity: { instanceId: 'f'.repeat(32) },
    log: () => {},
    runtime: async () => ({ rt: {}, ctx: {} }),
    currentRuntime: () => null,
    call: async (name, payload) => {
      calls.push([name, payload])
      const handler = table[name]
      if (!handler) throw Object.assign(new Error(`Unknown OpenTeamily endpoint ${name}`), { code: 'openteamily/not-found' })
      return handler(payload)
    },
  }
  let t = 1800000000
  const feature = createEvals({ db: new DatabaseSync(':memory:'), host, clock: () => t })
  return { e: feature.endpoints, calls, setClock: (value) => { t = value } }
}

const rejected = async (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))

test('weighted case scores, per-check parts, and a total that recomputes from the parts', async () => {
  const { e } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'Answer quality' })
  const heavy = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'Heavy', input: 'q1', expected: 'alpha beta', weight: 3,
    checks: [{ kind: 'contains', value: 'alpha' }, { kind: 'equals' }] })).case
  const light = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'Light', input: 'q2', expected: 'gamma', weight: 1,
    checks: [{ kind: 'contains', value: 'gamma' }] })).case
  const half = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'Half', input: 'q3', expected: 'one', weight: 2,
    checks: [{ kind: 'contains', value: 'one' }, { kind: 'contains', value: 'two' }] })).case

  const { run } = await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [
    { case_id: heavy.id, output: 'alpha beta' },
    { case_id: light.id, output: 'delta' },
    { case_id: half.id, output: 'one only' },
  ] })
  // (3*1.0 + 1*0.0 + 2*0.5) / (3+1+2) = 4/6
  assert.equal(run.score, round6(4 / 6), 'the total is the weight-weighted mean of the case scores')
  assert.equal(run.passed, true)
  const byCase = Object.fromEntries(run.results.map((row) => [row.case_id, row]))
  assert.equal(byCase[heavy.id].score, 1)
  assert.equal(byCase[half.id].score, 0.5, 'a case with one of two checks passing scores 0.5')
  assert.equal(byCase[half.id].passed, true, '0.5 meets the case threshold')
  assert.deepEqual(byCase[heavy.id].parts.map((part) => [part.kind, part.ok]), [['contains', true], ['equals', true]],
    'every check is reported as its own part')
  assert.deepEqual(byCase[half.id].parts.map((part) => part.ok), [true, false])
  const recomputed = round6(run.results.reduce((sum, row) => sum + row.weight * row.score, 0)
    / run.results.reduce((sum, row) => sum + row.weight, 0))
  assert.equal(recomputed, run.score, 'the stored per-case parts reproduce the total')
})

test('the same fixture scores bit for bit the same twice, whatever the clock or output order', async () => {
  const { e, setClock } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'Stable' })
  const cases = []
  for (const name of ['one', 'two', 'three']) {
    cases.push((await e['add-case']({ workspace_id: W1, suite_id: suite.id, name, input: name, expected: name, weight: 1,
      checks: [{ kind: 'equals' }, { kind: 'max-length', value: 20 }] })).case)
  }
  const outputs = [
    { case_id: cases[0].id, output: 'one' },
    { case_id: cases[1].id, output: 'nope' },
    { case_id: cases[2].id, output: 'three' },
  ]
  const first = (await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs })).run
  setClock(1900000000)
  const second = (await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [...outputs].reverse() })).run
  const shape = (run) => ({ score: run.score, passed: run.passed, threshold: run.threshold,
    results: [...run.results].map((row) => ({ case_id: row.case_id, score: row.score, passed: row.passed, parts: row.parts }))
      .sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0)) })
  assert.deepEqual(shape(second), shape(first), 'two evaluations of the same inputs are identical')
  assert.notEqual(second.id, first.id, 'they are still two distinct runs')
})

test('comparing two runs breaks ties by case name, not by insertion order', async () => {
  const { e } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'Compare' })
  const gamma = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'gamma', input: 'g', expected: 'g' })).case
  const beta = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'beta', input: 'b', expected: 'b' })).case
  const alpha = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'alpha', input: 'a', expected: 'a' })).case
  const runA = (await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [
    { case_id: gamma.id, output: 'g' }, { case_id: beta.id, output: 'b' }, { case_id: alpha.id, output: 'a' },
  ] })).run
  const runB = (await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [
    { case_id: gamma.id, output: 'wrong' }, { case_id: beta.id, output: 'b' }, { case_id: alpha.id, output: 'a' },
  ] })).run
  const { comparison } = await e.compare({ workspace_id: W1, run_a: runA.id, run_b: runB.id })
  assert.deepEqual(comparison.ranking.map((row) => row.case_name), ['alpha', 'beta', 'gamma'],
    'equal deltas are ordered by case name')
  assert.equal(comparison.aggregate_delta, round6(runB.score - runA.score))
  const byCase = Object.fromEntries(comparison.cases.map((row) => [row.case_name, row]))
  assert.equal(byCase.gamma.delta, -1)
  assert.equal(byCase.alpha.delta, 0)
})

test('another workspace sees nothing and is told nothing: 404, same message for absent and foreign ids', async () => {
  const { e } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'Private' })
  const only = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'Only', input: 'i', expected: 'i' })).case
  const { run } = await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [{ case_id: only.id, output: 'i' }] })

  const absentSuite = await rejected(e['get-suite']({ workspace_id: W1, id: 'c'.repeat(32) }))
  const absentRun = await rejected(e['get-run']({ workspace_id: W1, id: 'd'.repeat(32) }))
  const foreignSuite = await rejected(e['get-suite']({ workspace_id: W2, id: suite.id }))
  const foreignRun = await rejected(e['get-run']({ workspace_id: W2, id: run.id }))
  assert.equal(absentSuite.ok, false)
  assert.equal(foreignSuite.error.status, 404)
  assert.equal(foreignSuite.error.code, 'evals/not-found')
  assert.equal(foreignSuite.error.message, absentSuite.error.message, 'a foreign suite must not look different from an absent one')
  assert.equal(foreignRun.error.message, absentRun.error.message, 'a foreign run must not look different from an absent one')

  for (const [call, absent] of [
    [() => e['list-cases']({ workspace_id: W2, suite_id: suite.id }), absentSuite],
    [() => e['add-case']({ workspace_id: W2, suite_id: suite.id, name: 'Stolen', input: 'i', expected: 'i' }), absentSuite],
    [() => e.evaluate({ workspace_id: W2, suite_id: suite.id, outputs: [{ case_id: only.id, output: 'i' }] }), absentSuite],
    [() => e['get-run']({ workspace_id: W2, id: run.id }), absentRun],
    [() => e.compare({ workspace_id: W2, run_a: run.id, run_b: run.id }), absentRun],
  ]) {
    const outcome = await rejected(call())
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.status, 404)
    assert.equal(outcome.error.code, 'evals/not-found')
    assert.equal(outcome.error.message, absent.error.message)
  }
  const crossed = await rejected(e['create-suite']({ workspace_id: W1, agent_id: THEIRS, name: 'Cross' }))
  assert.equal(crossed.error.status, 404, "a suite cannot be opened on another workspace's agent")
  assert.equal(crossed.error.message, 'Agent not found')
  assert.deepEqual((await e['list-suites']({ workspace_id: W2 })).items, [])
})

test('scoring is rule based and makes no model or network call', async () => {
  const { e, calls } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'Offline' })
  const only = (await e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'Only', input: 'i', expected: 'i' })).case
  await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [{ case_id: only.id, output: 'i' }] })
  const touched = calls.filter(([name]) => name === 'agents/turn' || /model|chat|provider|fetch/i.test(name))
  assert.deepEqual(touched, [], 'an evaluation turn or model call would show up here')
  const source = readFileSync(join(HERE, '../features/evals/index.js'), 'utf8')
  assert.match(source, /纯规则评分、不调模型/, 'the module states that it scores by rule and calls no model')
})

test('suite and case names are unique per scope, paging is stable, removal cascades', async () => {
  const { e } = await fixture()
  const { suite } = await e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'CRUD' })
  assert.equal((await rejected(e['create-suite']({ workspace_id: W1, agent_id: MINE, name: 'CRUD' }))).error.status, 409)
  const cases = []
  for (const name of ['c1', 'c2', 'c3']) cases.push((await e['add-case']({ workspace_id: W1, suite_id: suite.id, name, input: name, expected: name })).case)
  assert.equal((await rejected(e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'c1', input: 'x', expected: 'x' }))).error.status, 409)
  const page = await e['list-cases']({ workspace_id: W1, suite_id: suite.id, limit: 2 })
  assert.equal(page.items.length, 2)
  const rest = await e['list-cases']({ workspace_id: W1, suite_id: suite.id, limit: 2, cursor: page.cursor })
  assert.equal(rest.items.length, 1)
  assert.equal(rest.cursor, null)
  assert.deepEqual([...page.items, ...rest.items].map((row) => row.name).sort(), ['c1', 'c2', 'c3'])
  assert.equal((await rejected(e['add-case']({ workspace_id: W1, suite_id: suite.id, name: 'bad', input: 'i', expected: 'i', weight: 0 }))).error.status, 400)
  const { run } = await e.evaluate({ workspace_id: W1, suite_id: suite.id, outputs: [{ case_id: cases[0].id, output: 'c1' }] })
  assert.equal(run.result_count, 1, 'cases without an output still count in the suite')
  await e['remove-suite']({ workspace_id: W1, id: suite.id })
  assert.equal((await rejected(e['get-suite']({ workspace_id: W1, id: suite.id }))).error.status, 404)
  assert.equal((await rejected(e['get-run']({ workspace_id: W1, id: run.id }))).error.status, 404, 'runs go with the suite')
})

test('evals loads through the extension point', async () => {
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) },
    dataDir: mkdtempSync(join(tmpdir(), 'ot-evals-load-')), log: () => {} })
  assert.ok(loaded.includes('evals'))
  assert.ok(table['evals/evaluate'] && table['evals/compare'])
})
