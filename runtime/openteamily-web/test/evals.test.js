// Agent evaluation suites inside the user's own DS-Bot: weighted cases, a
// deterministic rule-scored run, and comparison of two runs of the same suite.
//
// The scoring never calls a model: each case carries an expected rule
// (equals / contains / regex) and a run supplies the observed output per case.
// The same inputs therefore score the same total twice, which is what makes a
// prompt change judgeable instead of a transcript-reading exercise.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'

const call = (bot, op, payload) => bot.endpoint(`evals/${op}`, payload)
const ok = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, `${op} failed: ${JSON.stringify(result.error)}`)
  return result.value
}
const fails = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `${op} was expected to fail but returned ${JSON.stringify(result.value)}`)
  assert.equal(result.error.code, code, `${op} error code: ${JSON.stringify(result.error)}`)
  return result.error
}

const dbFile = (vol) => join(vol.data, 'openteamily', 'features', 'evals', 'evals.sqlite3')

const suiteOf = async (bot, name = '回答质量') => (await ok(bot, 'create-suite', { name })).suite
const caseOf = async (bot, suite, name, weight, kind, value) =>
  (await ok(bot, 'add-case', { suite_id: suite.id, name, weight, expected: { kind, value } })).case

test('weighted cases score a run deterministically and the run reads back after a reboot', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const suite = await suiteOf(bot)
  const exact = await caseOf(bot, suite, '精确命中', 2, 'equals', 'good')
  const contains = await caseOf(bot, suite, '包含世界', 1, 'contains', 'world')
  const shape = await caseOf(bot, suite, '以 ok 开头', 1, 'regex', '^ok')
  assert.deepEqual((await ok(bot, 'list-cases', { suite_id: suite.id })).items.map((item) => item.name),
    ['精确命中', '包含世界', '以 ok 开头'])

  const outputs = { [exact.id]: 'good', [contains.id]: 'hello world', [shape.id]: 'not ok' }
  const run1 = (await ok(bot, 'run', { suite_id: suite.id, outputs })).run
  assert.equal(run1.total, 0.75)
  assert.equal(run1.passed, 2)
  assert.equal(run1.failed, 1)
  assert.deepEqual(run1.results.map((item) => [item.name, item.weight, item.passed]),
    [['精确命中', 2, true], ['包含世界', 1, true], ['以 ok 开头', 1, false]])

  const run2 = (await ok(bot, 'run', { suite_id: suite.id, outputs })).run
  assert.notEqual(run1.id, run2.id)
  assert.equal(run2.total, run1.total, 'the same observed outputs must score the same total')
  assert.deepEqual(run2.results.map((item) => [item.case_id, item.weight, item.passed]),
    run1.results.map((item) => [item.case_id, item.weight, item.passed]))

  assert.deepEqual((await ok(bot, 'get-run', { run_id: run1.id })).run, run1)
  const again = await boot(vol)
  assert.deepEqual((await ok(again, 'get-run', { run_id: run1.id })).run, run1)
})

test('comparing two runs of one suite reports per-case and total deltas and refuses another suite', async () => {
  const bot = await boot()
  const suite = await suiteOf(bot, '对比基线')
  const first = await caseOf(bot, suite, '甲', 1, 'equals', 'x')
  const second = await caseOf(bot, suite, '乙', 1, 'equals', 'y')
  const good = (await ok(bot, 'run', { suite_id: suite.id, outputs: [{ case_id: first.id, output: 'x' }, { case_id: second.id, output: 'y' }] })).run
  assert.equal(good.total, 1)
  const worse = (await ok(bot, 'run', { suite_id: suite.id, outputs: [{ case_id: first.id, output: 'x' }, { case_id: second.id, output: 'nope' }] })).run
  assert.equal(worse.total, 0.5)

  const comparison = (await ok(bot, 'compare', { base_run_id: good.id, head_run_id: worse.id })).comparison
  assert.equal(comparison.suite_id, suite.id)
  assert.deepEqual(comparison.total, { base: 1, head: 0.5, delta: -0.5 })
  const byCase = new Map(comparison.cases.map((item) => [item.case_id, item]))
  assert.deepEqual([byCase.get(first.id).base, byCase.get(first.id).head, byCase.get(first.id).delta], [true, true, 0])
  assert.deepEqual([byCase.get(second.id).base, byCase.get(second.id).head, byCase.get(second.id).delta], [true, false, -1])
  assert.equal(comparison.regressed, 1)
  assert.equal(comparison.improved, 0)

  const other = await suiteOf(bot, '另一个套件')
  const otherCase = await caseOf(bot, other, '丙', 1, 'equals', 'z')
  const foreignRun = (await ok(bot, 'run', { suite_id: other.id, outputs: { [otherCase.id]: 'z' } })).run
  await fails(bot, 'compare', { base_run_id: good.id, head_run_id: foreignRun.id }, 'evals/suite_mismatch')
  await fails(bot, 'compare', { base_run_id: good.id, head_run_id: 'f'.repeat(32) }, 'evals/not-found')
})

test('suites and runs are owner-scoped and another owner id is refused', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const suite = await suiteOf(bot, '归属检查')
  const single = await caseOf(bot, suite, '唯一', 1, 'equals', 'yes')
  const run = (await ok(bot, 'run', { suite_id: suite.id, outputs: { [single.id]: 'yes' } })).run

  const db = new DatabaseSync(dbFile(vol))
  db.exec('PRAGMA busy_timeout=5000')
  db.prepare('UPDATE eval_suites SET owner_id=? WHERE id=?').run('f'.repeat(32), suite.id)
  db.prepare('UPDATE eval_runs SET owner_id=? WHERE id=?').run('f'.repeat(32), run.id)
  db.close()

  await fails(bot, 'get-suite', { id: suite.id }, 'evals/not-found')
  await fails(bot, 'list-cases', { suite_id: suite.id }, 'evals/not-found')
  await fails(bot, 'add-case', { suite_id: suite.id, name: '越权', weight: 1, expected: { kind: 'equals', value: 'x' } }, 'evals/not-found')
  await fails(bot, 'run', { suite_id: suite.id, outputs: { [single.id]: 'yes' } }, 'evals/not-found')
  await fails(bot, 'get-run', { run_id: run.id }, 'evals/not-found')
  await fails(bot, 'compare', { base_run_id: run.id, head_run_id: run.id }, 'evals/not-found')
  assert.deepEqual((await ok(bot, 'list-suites')).items, [])
})

test('bounded input is refused instead of being recorded as a failed case', async () => {
  const bot = await boot()
  await fails(bot, 'create-suite', { name: 'x'.repeat(201) }, 'evals/invalid')
  const suite = await suiteOf(bot, '边界检查')
  for (const weight of [0, -1, '2', Number.POSITIVE_INFINITY, Number.NaN]) {
    await fails(bot, 'add-case', { suite_id: suite.id, name: '坏权重', weight, expected: { kind: 'equals', value: 'x' } }, 'evals/invalid')
  }
  const heavy = await caseOf(bot, suite, '重的一例', 600, 'equals', 'x')
  await fails(bot, 'add-case', { suite_id: suite.id, name: '超总和', weight: 500, expected: { kind: 'equals', value: 'x' } }, 'evals/invalid')
  await fails(bot, 'add-case', { suite_id: suite.id, name: 'y'.repeat(201), weight: 1, expected: { kind: 'equals', value: 'x' } }, 'evals/invalid')
  await fails(bot, 'add-case', { suite_id: suite.id, name: '未知规则', weight: 1, expected: { kind: 'model_graded', value: 'x' } }, 'evals/invalid')
  await fails(bot, 'add-case', { suite_id: suite.id, name: '坏正则', weight: 1, expected: { kind: 'regex', value: '(' } }, 'evals/invalid')
  assert.deepEqual((await ok(bot, 'list-cases', { suite_id: suite.id })).items.map((item) => item.name), ['重的一例'])

  for (let index = 0; index < 99; index += 1) {
    await caseOf(bot, suite, `填充${index}`, 1, 'equals', 'x')
  }
  await fails(bot, 'add-case', { suite_id: suite.id, name: '第一百零一例', weight: 1, expected: { kind: 'equals', value: 'x' } }, 'evals/invalid')

  await fails(bot, 'run', { suite_id: suite.id, outputs: { [heavy.id]: 'x' } }, 'evals/invalid')
  await fails(bot, 'run', { suite_id: suite.id, outputs: { [heavy.id]: 'x', [ 'f'.repeat(32) ]: 'x' } }, 'evals/invalid')
})
