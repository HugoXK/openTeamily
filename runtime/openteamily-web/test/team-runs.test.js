import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgents } from '../features/agents/index.js'
import { createTeamRuns, stages } from '../features/team-runs/index.js'
import artifacts from '../features/artifacts/index.js'
import { featureHost, loadFeatures, registerFeature } from '../src/features.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const TEAM = 'b'.repeat(32)
const settle = async (feature) => { for (let i = 0; i < 20 && feature.inflight.size; i += 1) await Promise.all(feature.inflight.values()) }

async function fixture(reply, {runWorkspace = W, database = ':memory:'} = {}) {
  const turns = []
  const bots = { main: { id: 'main', name: 'Main', capabilities: [] } }
  let sessionCount = 0
  const rt = {
    state: {bots}, chatOwners: new Map(), botOf: id => bots[id],
    async createBot(fields) {
      const id = 'bot-' + Object.keys(bots).length
      return bots[id] = {...fields, id}
    },
    createSession: async () => 'session-' + ++sessionCount,
    workDirOf: () => '/fixture',
    updateBot: async (id, change) => Object.assign(bots[id], change),
    setFlags: async (id, flags) => Object.assign(bots[id], flags),
    save: async () => {},
  }
  const services = {rt, ctx: {}, mainBot: async () => 'main', chatTurn: async () => assert.fail('Expected native Bot execution'),
    async nativeTurn(bot, session, text, rid) {
      const [key] = Object.entries(bots[bot].openteamily.sessionKeys).find(([,id]) => id === session)
      turns.push({key, text, rid, bot, session})
      const out = reply ? await reply(key, text) : {text: `out:${key.split(':')[4]}`}
      return {...out, sessionId:session, turnId:'turn-' + turns.length}
    },
  }
  const table = {}
  const identity = {instanceId: 'f'.repeat(32)}
  const state = {teams: runWorkspace === W ? [] : [{id:runWorkspace}]}
  const host = { identity, runtime: async () => services, call: async (name, payload) => {
    if (name === 'agents/personal-binding') return {workspace_id: W}
    if (name === 'teams/activeWorkspaces') return state.teams
    if (name === 'skills/materialForScope') return {items: []}
    if (!table[name]) throw Object.assign(new Error('x'), { code: 'openteamily/not-found' })
    return table[name](payload, {internal:true})
  } }
  const agents = createAgents({ db: new DatabaseSync(':memory:'), host }).endpoints
  for (const [k, v] of Object.entries(agents)) table[`agents/${k}`] = v
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-tr-works-'))
  registerFeature(table, 'artifacts', artifacts(featureHost({name:'artifacts', identity, dataDir, table})))
  const a = (await agents.create({ workspace_id: runWorkspace, name: '研究', idempotency_key: 'a'.repeat(16) })).agent
  const b = (await agents.create({ workspace_id: runWorkspace, name: '写作', idempotency_key: 'b'.repeat(16) })).agent
  const db = new DatabaseSync(database)
  db.exec('PRAGMA foreign_keys=ON')
  const feature = createTeamRuns({ db, host })
  return { feature, e: feature.endpoints, a, b, agents, turns, host, state, db }
}

const body = (a, b, extra = {}) => ({ workspace_id: W, title: '调研报告', goal: '写一份行业调研', idempotency_key: 'r'.repeat(16),
  steps: [{ agent_id: a.id, instruction: '收集资料', depends_on: [] }, { agent_id: a.id, instruction: '找数据', depends_on: [] },
    { agent_id: b.id, instruction: '成文', depends_on: [0, 1] }], ...extra })

test('a DAG runs every step as a DS-Bot turn of its agent, in dependency order', async () => {
  const { feature, e, a, b, turns } = await fixture()
  const made = await e.create(body(a, b))
  assert.equal(made.status, 201)
  assert.deepEqual(made.run.steps.map((s) => s.stage), [1, 1, 2])
  await settle(feature)
  const { run } = await e.get({ workspace_id: W, id: made.run.id })
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(run.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded'])
  assert.equal(run.steps[2].ds_bot.engine, 'ds-bot')
  assert.equal(turns.length, 3)
  assert.ok(turns[2].key.startsWith(`agent:${b.id}:team-run:${made.run.id}:2`))
  assert.equal(turns[2].bot, b.native_bot_id)
  assert.deepEqual(turns.slice(0, 2).map(turn => turn.bot), [a.native_bot_id, a.native_bot_id])
  assert.match(turns[2].text, /团队任务目标：写一份行业调研/)
  assert.match(turns[2].text, /\[第 1 步 · 研究\] out:0/)
  assert.match(turns[2].text, /\[第 2 步 · 研究\] out:1/)
  assert.equal((await e.create(body(a, b))).status, 200)
  await assert.rejects(e.create(body(a, b, { goal: '别的' })), (err) => err.status === 409)
  assert.equal((await e.list({ workspace_id: W })).items[0].progress.succeeded, 3)
})

test('a failed step blocks dependants; retry resets them and finishes the run', async () => {
  let failFirst = true
  const { feature, e, a, b } = await fixture((key) => {
    if (key.split(':')[4] === '0' && failFirst) { failFirst = false; throw new Error('DS-Bot turn timed out') }
    return { text: 'ok' }
  })
  const { run } = await e.create(body(a, b))
  await settle(feature)
  let now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'failed')
  assert.deepEqual(now.steps.map((s) => [s.status, s.error_code]), [['failed', 'timeout'], ['succeeded', null], ['blocked', null]])
  await e.retry({ workspace_id: W, id: run.id, position: 0 })
  await settle(feature)
  now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'succeeded')
  assert.equal(now.steps[0].attempts, 2)
  await assert.rejects(e.retry({ workspace_id: W, id: run.id, position: 1 }), (err) => err.status === 409)
})

test('cancel stops pending steps and ignores late replies; validation refuses bad graphs', async () => {
  const pending = []
  const release = () => { for (const r of pending.splice(0)) r({ text: 'late' }) }
  const { feature, e, a, b, agents, turns } = await fixture(() => new Promise((r) => { pending.push(r) }))
  const { run } = await e.create(body(a, b))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(turns.length, 2)
  const cancelled = (await e.cancel({ workspace_id: W, id: run.id })).run
  assert.equal(cancelled.status, 'cancelled')
  await new Promise((r) => setImmediate(r))
  release()
  await settle(feature)
  const after = (await e.get({ workspace_id: W, id: run.id })).run
  assert.ok(after.steps.every((s) => s.status === 'cancelled'))
  assert.equal(turns.length, 2)
  await e.remove({ workspace_id: W, id: run.id })
  await assert.rejects(e.get({ workspace_id: W, id: run.id }), (err) => err.status === 404)
  const k = (n) => n.repeat(16)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('x'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [1] }, { agent_id: a.id, instruction: 'y', depends_on: [] }] })), /earlier steps/)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('y'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [] }] })), /2-8 steps/)
  await agents.archive({ workspace_id: W, id: b.id })
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('z') })), /active workspace agent/)
  await assert.rejects(e['step-artifact']({ workspace_id: W, id: 'd'.repeat(32), position: 0 }), (err) => err.status === 404)
  assert.deepEqual(stages([{ position: 0, depends: '[]' }, { position: 1, depends: '[0]' }, { position: 2, depends: '[0,1]' }]), { 0: 1, 1: 2, 2: 3 })
})

test('browser routes create once, replay after an agent changes, and save the actual step output to Space', async () => {
  const {feature, e, a, b, agents, host} = await fixture()
  const {workspace_id, idempotency_key, ...payload} = body(a, b)
  const path = `/v1/workspaces/${workspace_id}/team-runs`
  const create = () => e.v1({method:'POST', path, body:payload, idempotency_key})
  const both = await Promise.all([create(), create()])
  assert.deepEqual(both.map(result => result.status).sort(), [200, 201])
  const id = both[0].body.run.id
  assert.equal(both[1].body.run.id, id)
  await settle(feature)
  await agents.archive({workspace_id:W, id:b.id})
  assert.equal((await create()).body.run.id, id)
  const changed = await e.v1({method:'POST', path, body:{...payload, goal:'Different'}, idempotency_key})
  assert.equal(changed.status, 409)

  const existing = await host.call('artifacts/v1', {method:'POST', path:`/v1/workspaces/${W}/artifacts`,
    body:{title:'调研报告 · 第 1 步', kind:'document', body:'Unrelated existing work'}, idempotency_key:'existing-work-key'})
  assert.equal(existing.status, 201)
  const save = () => e.v1({method:'POST', path:`${path}/${id}/steps/0/artifact`})
  const kept = await save()
  assert.equal(kept.status, 201)
  const artifact = kept.body.artifact
  assert.equal(artifact.body, 'out:0')
  assert.notEqual(artifact.id, existing.body.artifact.id)
  const replay = await save()
  assert.equal(replay.status, 200)
  assert.equal(replay.body.artifact.id, artifact.id)
  assert.equal((await e.v1({method:'GET', path:`${path}/${id}`})).body.run.status, 'succeeded')
  assert.equal((await e.v1({method:'GET', path})).body.items.length, 1)
  assert.equal((await e.v1({method:'POST', path:`${path}/${id}/steps/8/artifact`})).status, 404)
  assert.equal((await e.v1({method:'POST', path:`${path}/${id}/remove`})).status, 200)
  assert.equal((await e.v1({method:'GET', path:`${path}/${id}`})).status, 404)
})

test('restart interrupts claimed work and only resumes independent unclaimed steps', async () => {
  const database = join(mkdtempSync(join(tmpdir(), 'ot-tr-restart-')), 'runs.sqlite3')
  const {db, a, b, host, turns} = await fixture(undefined, {database})
  const id = 'd'.repeat(32)
  db.prepare('INSERT INTO team_runs VALUES(?,?,?,?,?,?,?,?,?)').run(id, W, 'Interrupted', 'Goal', 'running', 10, 10, 'key', 'hash')
  const put = db.prepare(`INSERT INTO team_run_steps
    (run_id,position,agent_id,agent_name,instruction,depends,status,attempts,started)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  put.run(id, 0, a.id, a.name, 'Claimed before restart', '[]', 'running', 1, 10)
  put.run(id, 1, a.id, a.name, 'Never claimed', '[]', 'waiting', 0, null)
  put.run(id, 2, b.id, b.name, 'Needs both', '[0,1]', 'waiting', 0, null)
  db.close()
  const restart = new DatabaseSync(database)
  const feature = createTeamRuns({db:restart, host, clock:() => 20})
  const e = feature.endpoints
  const get = async () => (await e.get({workspace_id:W, id})).run
  const initial = await get()
  assert.deepEqual(initial.steps.map(s => s.status), ['failed','waiting','blocked'])
  assert.equal(initial.steps[0].error_code, 'interrupted')
  feature.resume()
  feature.resume()
  await settle(feature)
  assert.deepEqual(turns.map(turn => turn.rid), [`ot-team-run:${id}:1:1`])
  assert.equal((await get()).status, 'failed')
  await e.retry({workspace_id:W, id, position:0})
  await settle(feature)
  assert.deepEqual(turns.slice(1).map(turn => turn.rid), [`ot-team-run:${id}:0:2`, `ot-team-run:${id}:2:1`])
  assert.equal((await get()).status, 'succeeded')
  restart.close()
})

test('workspace membership is checked on reads, writes, and outstanding step dispatch', async () => {
  const launched = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const {feature, e, a, b, state, turns} = await fixture(() => { launched.resolve(); return reply.promise }, {runWorkspace: TEAM})
  const path = `/v1/workspaces/${TEAM}/team-runs`
  const draft = {title:'Team workspace', goal:'One after the other', steps:[
    {agent_id:a.id, instruction:'First', depends_on:[]}, {agent_id:b.id, instruction:'Then', depends_on:[0]},
  ]}
  const foreign = path.replace(TEAM, 'c'.repeat(32))
  assert.equal((await e.v1({method:'POST', path:foreign, body:draft, idempotency_key:'foreign-workspace'})).status, 404)
  assert.equal((await e.v1({method:'POST', path:path.replace(TEAM, W), body:draft, idempotency_key:'foreign-agent-in-personal'})).status, 400)
  const made = await e.v1({method:'POST', path, body:draft, idempotency_key:'shared-workspace'})
  assert.equal(made.status, 201)
  const current = path + '/' + made.body.run.id
  await launched.promise
  state.teams = []
  assert.equal((await e.v1({method:'GET', path})).status, 404)
  assert.equal((await e.v1({method:'GET', path:current})).status, 404)
  assert.equal((await e.v1({method:'POST', path:current + '/cancel'})).status, 404)
  reply.resolve({text:'First turn was already underway'})
  await settle(feature)
  assert.equal(turns.length, 1)
  state.teams = [{id:TEAM}]
  const after = (await e.v1({method:'GET', path:current})).body.run
  assert.equal(after.status, 'failed')
  assert.equal(after.steps[1].error_code, 'workspace_unavailable')
})

test('team-runs loads through the extension point', async () => {
  process.env.OPENTEAMILY_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: mkdtempSync(join(tmpdir(), 'ot-tr-load-')), log: () => {} })
  assert.ok(loaded.includes('team-runs'))
  assert.ok(table['team-runs/create'] && table['team-runs/retry'] && table['team-runs/v1'] && table['team-runs/step-artifact'])
})
