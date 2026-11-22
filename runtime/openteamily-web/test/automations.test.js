import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dueAt, nextScheduledSlot, validSchedule, zonedEpoch } from '../features/automations/schedule.js'
import { createAutomations, dsBotTurn } from '../features/automations/automations.js'
import { TEMPLATES } from '../features/automations/templates.js'
import { featureHost, loadFeatures, registerFeature } from '../src/features.js'
import artifactsFeature from '../features/artifacts/index.js'
import { attachRuntime, detachRuntime } from '../src/host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const flush = () => new Promise((r) => setImmediate(r))

function fixture(turn, at = 1_800_000_000, saveArtifact, readMeetingAction, readMemoryAction) {
  const clock = { now: at }
  const calls = []
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ot-auto-')), 'a.sqlite3')
  const feature = createAutomations({
    personalBinding: async () => ({workspace_id: W}),
    saveArtifact,
    readMeetingAction,
    readMemoryAction,
    db: new DatabaseSync(dbPath), clock: () => clock.now, log: () => {},
    turn: turn ?? (async (args) => { calls.push(args); return { text: 'DS-Bot did it', model: 'm', session_id: 's1', turn_id: 't1', bot_id: 'bot1', model_calls: 1 } }),
  })
  return { feature, clock, calls, dbPath, e: feature.endpoints }
}

test('meeting follow-up verifies exact source, coalesces concurrent saves, and retains its original action', async () => {
  const MEETING = 'b'.repeat(32)
  const reference = { meeting_id: MEETING, revision: 2, action_index: 0 }
  const snapshot = Promise.withResolvers()
  const { e, calls } = fixture(undefined, undefined, undefined, async (workspace, ref) => {
    assert.deepEqual(ref, reference)
    if (workspace !== W) return {status: 404}
    return snapshot.promise
  })
  const payload = {workspace_id: W, title: '跟进验收记录', participants: ['alice'], template_id: 'custom',
    schedule: {kind:'now', time_zone:'UTC'}, enabled: true, source_meeting: {...reference, text:'伪造的来源内容'},
    idempotency_key: 'save-meeting-followup-001'}
  const create = options => e['automations/create']({...payload, ...options})
  const first = create()
  const duplicate = create({title:'另一份草稿', idempotency_key:'save-meeting-followup-002'})
  snapshot.resolve({status: 200, body: {
    meeting: {id: MEETING, workspace_id: W, revision: 2, title:'交付例会', transcript:'逐字稿不用于跟进'},
    action: {text:'核对回执', owner:'Alice', done:false},
  }})
  const [saved, replay] = await Promise.all([first, duplicate])
  assert.equal(saved.status, 201)
  assert.equal(replay.status, 200)
  assert.equal(replay.automation.id, saved.automation.id)
  assert.equal(replay.automation.title, payload.title)
  assert.equal(saved.automation.enabled, false)
  assert.deepEqual(saved.automation.source_meeting, {...reference, title:'交付例会', text:'核对回执', owner:'Alice'})
  assert.deepEqual(e['automations/list']({workspace_id:W}).items, [saved.automation])
  const item = e['automations/update']({workspace_id:W, id:saved.automation.id, revision:1, changes:{title:'处理验收回执'}}).automation
  assert.deepEqual(e['automations/meetingFollowup']({workspace_id:W, ...reference}), {automation:item})
  assert.deepEqual(e['automations/meetingFollowup']({workspace_id:'c'.repeat(32), ...reference}), {automation:null})
  await assert.rejects(create({workspace_id:'c'.repeat(32)}), {status:404, code:'automations/meeting_source_unavailable'})
  assert.equal(calls.length, 0)
})

test('a scoped memory action prepares one durable follow-up for its reviewed revision and runs only on request', async () => {
  const actionId = 'b'.repeat(32)
  const otherWorkspace = 'c'.repeat(32)
  const memoryCalls = []
  const firstAction = {id: actionId, workspace_id: W, revision: 2, status: 'open',
    title: '核对简报', notes: '核对发布日期和来源。', due_at: 1_800_001_000}
  let action = firstAction
  let concurrentRead = null
  const {calls, e, feature} = fixture(undefined, undefined, undefined, undefined, async (workspace, id) => {
    memoryCalls.push({workspace, id})
    assert.equal(workspace, W)
    assert.equal(id, actionId)
    return concurrentRead ? concurrentRead.promise : {status: 200, body: {action}}
  })
  const context = username => ({request: new Request('https://example.test', {headers: {'x-ot-owner-username': username}})})
  const collection = workspace => `/v1/workspaces/${workspace}/automations`
  const lookup = (revision, workspace = W, username = 'alice') => e['automations/v1']({
    method: 'GET', path: collection(workspace) + `?memory_action=${actionId}&revision=${revision}`,
  }, context(username))
  const post = (revision, {workspace = W, key = 'save-memory-followup-001', changes = {}, username = 'alice'} = {}) =>
    e['automations/v1']({
      method: 'POST', path: collection(workspace), idempotency_key: key,
      body: {title: '准备已检查的简报', prompt: '只输出两条检查建议。', template_id: 'custom',
        participants: ['alice'], enabled: true, schedule: {kind: 'now', time_zone: 'UTC'},
        source_memory_action: {action_id: actionId, revision}, ...changes},
    }, context(username))

  assert.equal((await lookup(2, W, '')).status, 403)
  assert.equal((await lookup(2, otherWorkspace)).status, 403)
  assert.equal((await post(2, {workspace: otherWorkspace})).status, 403)
  assert.equal((await post(2, {username: ''})).status, 403)
  assert.equal((await post(2, {changes: {run_sample: true}})).body.error.code, 'invalid_sample')
  assert.equal((await post(2, {changes: {source_memory_action: {action_id: actionId, revision: 2, notes: 'forged'}}})).status, 400)
  assert.equal(memoryCalls.length, 0)
  assert.deepEqual((await lookup(2)).body, {automation: null, action: firstAction, viewer_username: 'alice'})
  action = {...firstAction, revision: 3, notes: '本次更新的原始内容。'}
  const stale = await post(2)
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'memory_source_unavailable')

  concurrentRead = Promise.withResolvers()
  const first = post(3)
  const second = post(3, {key: 'save-memory-followup-tab-2', changes: {title: '另一标签页的标题'}})
  await flush()
  assert.equal(memoryCalls.length, 4)
  concurrentRead.resolve({status: 200, body: {action}})
  const completed = await Promise.all([first, second])
  concurrentRead = null
  assert.deepEqual(completed.map(result => result.status).sort(), [200, 201])
  const saved = completed.find(result => result.status === 201).body.automation
  assert.equal(completed.find(result => result.status === 200).body.automation.id, saved.id)
  assert.deepEqual(saved.source_memory_action, {
    action_id: actionId, revision: 3, title: action.title, notes: action.notes, due_at: action.due_at,
  })
  assert.equal(saved.enabled, false)
  assert.deepEqual(feature.tick(W), [])
  assert.equal(calls.length, 0)

  action = {...action, revision: 4, status: 'done', notes: 'New private notes'}
  const receipt = await lookup(3)
  assert.deepEqual(receipt.body, {automation: saved, action: null, viewer_username: 'alice'})
  assert.equal((await lookup(4)).status, 409)
  assert.equal((await post(4)).status, 409)
  assert.equal((await post(3)).body.automation.id, saved.id)
  assert.equal(calls.length, 0)
  const items = (await e['automations/v1']({method: 'GET', path: collection(W)}, context('alice'))).body.items
  assert.deepEqual(items.map(item => item.source_memory_action), [saved.source_memory_action])

  const manual = await e['automations/v1']({
    method: 'POST', path: collection(W) + '/' + saved.id + '/run', idempotency_key: 'run-memory-followup-001',
  }, context('alice'))
  assert.equal(manual.status, 202)
  await flush()
  assert.deepEqual(calls.map(call => call.prompt), [`[OpenTeamily 自动化 · ${saved.title}]\n${saved.prompt}`])
  assert.deepEqual(e['automations/run']({workspace_id: W, id: saved.id, run_id: manual.body.run.id}).run.result,
    {text: 'DS-Bot did it', model: 'm'})
})

test('next recurring slot follows local weekdays, month lengths and DST', () => {
  const seconds = iso => Date.parse(iso) / 1000
  const weekly = {kind:'weekly', weekday:1, time:'09:00', time_zone:'America/New_York'}
  assert.equal(nextScheduledSlot(weekly, seconds('2027-03-13T16:00:00Z')), seconds('2027-03-15T13:00:00Z'))
  const weekdays = {kind:'weekdays', time:'09:00', time_zone:'UTC'}
  assert.equal(nextScheduledSlot(weekdays, seconds('2027-02-26T09:00:00Z')), seconds('2027-03-01T09:00:00Z'))
  const monthly = {kind:'monthly', day:31, time:'09:00', time_zone:'Asia/Shanghai'}
  assert.equal(nextScheduledSlot(monthly, seconds('2027-03-31T01:00:00Z')), seconds('2027-05-31T01:00:00Z'))
})

test('scheduler projections distinguish one-time trigger, pause, and the next slot after execution', async () => {
  const at = Date.parse('2027-02-26T09:00:00Z') / 1000
  const {e, feature, clock} = fixture(undefined, at)
  const daily = {kind:'weekdays', time:'09:00', time_zone:'UTC'}
  const once = {kind:'now', time_zone:'UTC'}
  const create = (title, schedule, enabled) => e['automations/create']({workspace_id:W, title, schedule, enabled,
    prompt:'Record a result', template_id:'custom', participants:['alice'], idempotency_key:`fixture-key-for-${title}`}).automation
  const recurring = create('Recurring',daily,true)
  const single = create('Single',once,true)
  const paused = create('Paused',daily,false)
  assert.deepEqual(recurring.schedule_status, {state:'due'})
  assert.deepEqual(single.schedule_status, {state:'due'})
  assert.deepEqual(paused.schedule_status, {state:'paused'})
  const fired = feature.tick(W)
  assert.equal(fired.length,2)
  await Promise.all(feature.inflight.values())
  const status = id => e['automations/get']({workspace_id:W,id}).automation.schedule_status
  assert.deepEqual(status(single.id), {state:'once_triggered'})
  const next = {state:'scheduled', at:Date.parse('2027-03-01T09:00:00Z') / 1000}
  assert.deepEqual(status(recurring.id),next)
  assert.deepEqual(e['automations/runs']({workspace_id:W,id:recurring.id}).schedule_status,next)
  const {items} = e['automations/list']({workspace_id:W,category:'mine',username:'alice'})
  assert.deepEqual(items.find(item => item.id === recurring.id).schedule_status,next)
  clock.now = next.at
  assert.deepEqual(status(recurring.id), {state:'due'})
})

test('a successful native run saves a durable, idempotent document from its own output', async () => {
  const table = {}
  const host = featureHost({name: 'artifacts', identity: {instanceId: W},
    dataDir: mkdtempSync(join(tmpdir(), 'ot-auto-artifacts-')), table})
  const artifacts = artifactsFeature(host)
  registerFeature(table, 'artifacts', artifacts)
  const {e, feature} = fixture(undefined, undefined, payload => host.call('artifacts/saveAutomationRun', payload))
  const {automation} = e['automations/create']({workspace_id: W, title: '保存工作简报', participants: ['alice'],
    template_id: 'custom', schedule: {kind: 'now', time_zone: 'UTC'},
    prompt: 'Summarize the day.', idempotency_key: 'create-save-run-001'})
  const {run} = e['automations/runNow']({workspace_id: W, id: automation.id, idempotency_key: 'start-save-run-001'})
  await feature.inflight.get(run.id)
  const path = `/v1/workspaces/${W}/automations/${automation.id}/runs/${run.id}/artifact`
  const save = () => e['automations/v1']({method: 'POST', path, body: {body: 'caller cannot override output'}})
  const first = await save()
  assert.equal(first.status, 201)
  const {artifact} = first.body
  assert.equal(artifact.body, 'DS-Bot did it')
  assert.equal(artifact.source.kind, 'automation_run')
  assert.equal(artifact.source.id, run.id)
  assert.equal(artifact.source.automation_id, automation.id)
  const repeat = await save()
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.artifact.id, artifact.id)
  assert.equal((await e['automations/v1']({method: 'GET', path})).status, 405)
  assert.equal((await e['automations/v1']({method: 'POST', path: path.replace(W, 'b'.repeat(32))})).status, 404)
  await assert.rejects(() => artifacts.endpoints.saveAutomationRun({}, {internal: false}), /Save results/)
})

test('team publication reviews only the stored output and recovers a lost share without a duplicate', async () => {
  const collection = `/v1/workspaces/${W}/studio/documents`
  const documents = new Map()
  const writes = []
  let denied = false, loseResponse = true, turns = 0
  const {endpoints: e, inflight} = createAutomations({
    db: new DatabaseSync(':memory:'),
    turn: async () => { turns++; return {text:'完成验收，下一步核对资料。', model:'private-model', session_id:'private-session'} },
    studioRequest: async ({method,path,body}) => {
      if (denied) return {status:404, body:{}}
      if (method === 'GET' && path === collection) return {status:200, body:{items:[]}}
      if (method === 'GET') return {status:[...documents.values()].some(id => path === collection+'/'+id) ? 200 : 404,body:{}}
      assert.equal(path,collection)
      writes.push(body)
      const id = documents.get(body.client_key) || String(documents.size+1).padStart(32,'0')
      documents.set(body.client_key,id)
      if (loseResponse) { loseResponse=false; return {status:503,body:{}} }
      return {status:200,body:{document:{id}}}
    },
  })
  const {automation} = e['automations/create']({
    workspace_id:W,title:'结果验收',prompt:'Private prompt',template_id:'custom',
    participants:['alice'],schedule:{kind:'now',time_zone:'UTC'},idempotency_key:'studio-create-automation',
  })
  const {run} = e['automations/runNow']({workspace_id:W,id:automation.id,idempotency_key:'studio-automation-first-run'})
  await inflight.get(run.id)
  const path = `/v1/workspaces/${W}/automations/${automation.id}/runs/${run.id}/studio`
  const get = () => e['automations/v1']({method:'GET',path})
  const save = body => e['automations/v1']({method:'POST',path,body})
  assert.equal((await e['automations/v1']({method:'GET',path:path.replace(W,'b'.repeat(32))})).status,404)
  assert.equal((await save({review:'0'.repeat(64),body:'should never be published'})).status,400)
  assert.equal((await save({review:'0'.repeat(64)})).body.error.code,'review_changed')
  const preview = (await get()).body
  assert.equal(preview.body,'完成验收，下一步核对资料。')
  assert.match(preview.title,/^结果验收/)
  assert.equal(writes.length,0)
  assert.equal((await save({review:preview.review})).status,503)
  e['automations/update']({workspace_id:W,id:automation.id,revision:1,changes:{title:'私下改名'}})
  assert.deepEqual((await get()).body,preview)
  const retry = await save({review:preview.review})
  assert.equal(retry.status,200)
  assert.equal(documents.size,1)
  assert.deepEqual(writes,[0,1].map(() => ({title:preview.title,body:preview.body,client_key:preview.review})))
  assert.deepEqual((await get()).body,retry.body)
  assert.deepEqual((await save({review:preview.review})).body,retry.body)
  denied = true
  assert.equal((await get()).status,403)
  assert.equal(turns,1)
})

test('schedule slots match the server rules across time zones', () => {
  const zone = 'Asia/Shanghai'
  const nine = zonedEpoch(zone, 2027, 1, 4, 9, 0) // Monday
  assert.equal(nine, Date.UTC(2027, 0, 4, 1, 0) / 1000)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine - 1), null)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine + 60), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 1, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 2, time: '09:00', time_zone: zone }, nine + 5), null)
  assert.equal(dueAt({ kind: 'weekdays', time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'monthly', day: 4, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'once', date: '2027-01-04', time: '09:00', time_zone: zone }, nine), nine)
  assert.equal(dueAt({ kind: 'now', time_zone: zone }, nine), 0)
  assert.equal(validSchedule({ kind: 'daily', time: '25:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'once', date: '2027-02-30', time: '09:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'daily', time: '09:00', time_zone: 'Nowhere/City' }), false)
  assert.equal(validSchedule({ kind: 'later', date: '2027-02-03', time: '09:00', time_zone: 'UTC' }), true)
})

test('templates stay in step with the Python source', () => {
  const py = readFileSync(join(HERE, '../../../openteamily/automations.py'), 'utf8')
  const ids = [...py.matchAll(/^ {4}'([a-z_]+)': \{/gm)].map((m) => m[1])
  assert.deepEqual(Object.keys(TEMPLATES), ids)
})

test('create is idempotent, titles are unique, updates check revision', async () => {
  const { e } = fixture()
  const body = { workspace_id: W, title: '每日简报', template_id: 'daily_brief', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'], idempotency_key: 'k'.repeat(16) }
  const made = e['automations/create'](body)
  assert.equal(made.status, 201)
  assert.equal(made.automation.enabled, false)
  assert.equal(made.automation.compiled, true)
  assert.match(made.automation.prompt, /每天 09:00/)
  assert.equal(e['automations/create'](body).status, 200)
  assert.throws(() => e['automations/create']({ ...body, title: '别的' }), /different request/)
  assert.throws(() => e['automations/create']({ ...body, idempotency_key: 'j'.repeat(16) }), /already exists/)
  const id = made.automation.id
  const up = e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: true, scope: 'ongoing' } })
  assert.equal(up.automation.revision, 2)
  assert.match(up.automation.prompt, /长期运行/)
  assert.throws(() => e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: false } }), (err) => err.status === 409)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'work' }).items.length, 1)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'life' }).items.length, 0)
  assert.equal(e['automations/list']({ workspace_id: 'b'.repeat(32) }).items.length, 0)
})

test('the mine tab lists saved automations for the signed-in runtime owner', async () => {
  const { e } = fixture()
  const draft = { workspace_id: W, template_id: 'custom', prompt: 'Respond once',
    schedule: { kind: 'now', time_zone: 'UTC' } }
  const { automation } = e['automations/create']({
    ...draft, title: '我的任务', participants: ['alice'], idempotency_key: 'a'.repeat(16),
  })
  e['automations/create']({
    ...draft, title: '其他人的任务', participants: ['bobby'], idempotency_key: 'b'.repeat(16),
  })
  const path = `/v1/workspaces/${W}/automations?category=mine`
  const request = new Request('https://example.test', { headers: { 'x-ot-owner-username': 'Alice' } })
  const result = await e['automations/v1']({ path }, { request })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.items.map(item => item.id), [automation.id])
})

test('creating a scheduled automation can save it enabled in the same request', async () => {
  const { e } = fixture()
  const request = {
    method: 'POST', path: `/v1/workspaces/${W}/automations`, idempotency_key: 'e'.repeat(16),
    body: { title: '每周检查', template_id: 'custom', prompt: 'Check the report', participants: ['alice'],
      schedule: { kind: 'weekly', weekday: 1, time: '09:00', time_zone: 'UTC' }, enabled: true },
  }
  const created = await e['automations/v1'](request)
  assert.equal(created.status, 201)
  assert.equal(created.body.automation.enabled, true)
  assert.equal(created.body.automation.revision, 1)
  const retried = await e['automations/v1'](request)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.automation.id, created.body.automation.id)
  assert.equal((await e['automations/v1']({...request, body: {...request.body, enabled: false}})).status, 409)
})

test('saving a recurring routine atomically starts one sample and keeps its recurring slot independent', async () => {
  const now = Date.parse('2027-02-26T08:30:00Z') / 1000
  const { e, feature, clock, calls } = fixture(undefined, now)
  const collection = `/v1/workspaces/${W}/automations`
  const payload = {title:'Daily sample', template_id:'daily_brief', participants:['alice'], scope:'ongoing', enabled:true,
    schedule:{kind:'daily', time:'09:00', time_zone:'UTC'}, run_sample:true}
  const save = (body, idempotency_key = 'routine-sample-exact-001') =>
    e['automations/v1']({method:'POST', path:collection, body, idempotency_key})
  const first = await save(payload)
  assert.equal(first.status, 201)
  const {automation, sample_run} = first.body
  assert.equal(sample_run.automation_id, automation.id)
  assert.equal(sample_run.workspace_id, W)
  assert.equal(automation.schedule_status.at, now + 1800)
  const replay = await save(payload)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.sample_run.id, sample_run.id)
  assert.equal((await save({...payload, run_sample:false})).status, 409)
  await flush()
  const exact = e['automations/run']({workspace_id:W, id:automation.id, run_id:sample_run.id}).run
  assert.equal(exact.status, 'succeeded')
  assert.equal(exact.result.text, 'DS-Bot did it')
  assert.equal(calls.length, 1)

  const invalid = await save({...payload, title:'Unscheduled sample', schedule:{kind:'now', time_zone:'UTC'}}, 'routine-sample-invalid-001')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'invalid_sample')
  const paused = await save({...payload, title:'Paused sample', enabled:false}, 'routine-sample-paused-001')
  assert.equal(paused.status, 201)
  assert.deepEqual(paused.body.automation.schedule_status, {state:'paused'})
  assert.equal(paused.body.sample_run.automation_id, paused.body.automation.id)
  await flush()
  clock.now += 1800
  const [scheduled] = feature.tick(W)
  assert.equal(scheduled.trigger, 'scheduled')
  assert.equal(scheduled.automation_id, automation.id)
  assert.notEqual(scheduled.id, sample_run.id)
  assert.equal(feature.tick(W).length, 0)
  await flush()
  assert.equal(calls.length, 3)
})

test('a due schedule fires inside DS-Bot once per slot and records the DS-Bot reply', async () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 0)
  const { e, calls, feature, clock } = fixture(null, at)
  const { automation } = e['automations/create']({ workspace_id: W, title: '提醒', template_id: 'reminder', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'r'.repeat(16) })
  assert.equal(automation.enabled, true)
  const fired = feature.tick()
  assert.equal(fired.length, 1)
  assert.equal(feature.tick().length, 0, 'same slot never fires twice')
  await Promise.all(feature.inflight.values())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${automation.id}`)
  assert.match(calls[0].prompt, /到点提醒我/)
  const { items } = e['automations/runs']({ workspace_id: W, id: automation.id })
  assert.equal(items[0].status, 'succeeded')
  assert.equal(items[0].trigger, 'scheduled')
  assert.equal(items[0].result.text, 'DS-Bot did it')
  assert.equal(items[0].dispatch.backend, 'ds-bot')
  assert.equal(items[0].dispatch.ds_bot.session_id, 's1')
  clock.now += 86400
  assert.equal(feature.tick().length, 1, 'next day fires again')
})

test('recurring plans use the current activation and skip times elapsed before create, resume or rule change', async () => {
  const at = zonedEpoch('Europe/Paris', 2027, 2, 25, 12, 0)
  const nextSlot = zonedEpoch('Europe/Paris', 2027, 2, 27, 10, 0)
  const {e, feature, clock, dbPath} = fixture(undefined, at)
  const schedule = {kind:'daily', time:'09:00', time_zone:'Europe/Paris'}
  const {automation} = e['automations/create']({
    workspace_id:W, title:'定期简报', template_id:'custom', schedule, participants:['alice'],
    idempotency_key:'new-recurring-brief-001', enabled:true,
  })
  const where = {workspace_id:W, id:automation.id}
  let saved = automation
  const update = changes => {
    saved = e['automations/update']({...where, revision:saved.revision, changes}).automation
  }
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:zonedEpoch('Europe/Paris', 2027, 2, 26, 9, 0)})
  assert.deepEqual(feature.tick(W), [])
  update({enabled:false})
  clock.now += 86400
  assert.deepEqual(feature.tick(W), [])
  update({enabled:true})
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:zonedEpoch('Europe/Paris', 2027, 2, 27, 9, 0)})
  update({schedule:{...schedule, time:'10:00'}})
  assert.deepEqual(saved.schedule_status, {state:'scheduled', at:nextSlot})
  assert.deepEqual(feature.tick(W), [])
  assert.deepEqual(e['automations/list']({workspace_id:W}).items[0].schedule_status, saved.schedule_status)
  assert.deepEqual(e['automations/runs'](where).schedule_status, saved.schedule_status)

  clock.now = nextSlot + 60
  update({prompt:'Include the project plan.', enabled:true, schedule:{...schedule, time:'10:00'}})
  assert.deepEqual(saved.schedule_status, {state:'due'})
  feature.db.close()
  const calls = []
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async ({prompt}) => { calls.push(prompt); return {text:'saved result'} }})
  try {
    restored.start()
    await Promise.all(restored.inflight.values())
    assert.deepEqual(restored.tick(W), [])
    const {items} = restored.endpoints['automations/runs'](where)
    assert.equal(items.length, 1)
    assert.equal(items[0].due_at, nextSlot)
    assert.equal(items[0].status, 'succeeded')
    assert.match(calls[0], /Include the project plan/)
  } finally {
    restored.stop()
    restored.db.close()
  }
})

test('upgrading an existing automation volume keeps enabled definitions and applies the cutoff when a paused plan resumes', async () => {
  const morning = zonedEpoch('UTC', 2027, 2, 25, 8, 0)
  const scheduled = zonedEpoch('UTC', 2027, 2, 25, 9, 0)
  const {e, feature, clock, dbPath} = fixture(undefined, morning)
  const create = (title, enabled) => e['automations/create']({
    workspace_id:W, title, template_id:'custom', schedule:{kind:'daily', time:'09:00', time_zone:'UTC'},
    participants:['alice'], idempotency_key:`volume-migration-${title}`, enabled,
  }).automation
  const enabled = create('existing-enabled', true)
  const paused = create('existing-paused', false)
  feature.db.exec('ALTER TABLE ot_automations DROP COLUMN schedule_active_at')
  feature.db.close()
  clock.now = scheduled + 120
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async () => ({text:'migration result'})})
  try {
    const result = restored.endpoints['automations/update']({workspace_id:W, id:paused.id,
      revision:paused.revision, changes:{enabled:true}})
    assert.deepEqual(result.automation.schedule_status, {state:'scheduled', at:scheduled + 86400})
    const fired = restored.tick(W)
    assert.deepEqual(fired.map(item => item.automation_id), [enabled.id])
    await Promise.all(restored.inflight.values())
    assert.deepEqual(restored.tick(W), [])
    assert.deepEqual(restored.endpoints['automations/get']({workspace_id:W,id:enabled.id}).automation.schedule_status,
      {state:'scheduled', at:scheduled + 86400})
  } finally {
    restored.db.close()
  }
})

test('automations keep running after 200 historical runs and preserve keyset history and artifact sources', async () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 0)
  const {e, feature} = fixture(null, at, async source => ({status: 201, artifact: {source}}))
  const {automation} = e['automations/create']({workspace_id: W, title: '长期运行', template_id: 'reminder',
    schedule: {kind: 'daily', time: '09:00', time_zone: 'UTC'}, participants: ['alice'], idempotency_key: 'g'.repeat(16)})
  const context = {workspace_id: W, id: automation.id}
  const insert = feature.db.prepare(`INSERT INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,finished,status,error_code,dispatch)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const prior = []
  feature.db.exec('BEGIN')
  for (let i = 1; i <= 240; i++) {
    const id = i.toString(16).padStart(32, '0')
    const start = at - 1000 + Math.floor(i / 4)
    const status = i % 3 === 0 ? 'failed' : 'succeeded'
    const due = i % 2 === 0 ? -i : at - 86400 - i
    const resultText = 'Historical output ' + i
    prior.push({id, started: start, status, resultText})
    const dispatch = JSON.stringify({backend: 'ds-bot', result: {text: resultText}})
    insert.run(id, automation.id, W, due, start, start + 1, status, status === 'failed' ? 'runtime_failed' : null, dispatch)
  }
  feature.db.exec('COMMIT')

  const [scheduled] = feature.tick()
  assert.equal(scheduled?.trigger, 'scheduled')
  await feature.inflight.get(scheduled.id)
  assert.equal(feature.tick().length, 0)

  const manualRequest = {...context, idempotency_key: 'm'.repeat(16)}
  const manual = e['automations/runNow'](manualRequest)
  assert.equal(manual.status, 202)
  await feature.inflight.get(manual.run.id)
  assert.equal(e['automations/runNow'](manualRequest).run.id, manual.run.id)

  const retryRequest = {...context, run_id: prior[2].id, idempotency_key: 'r'.repeat(16)}
  const retry = e['automations/retry'](retryRequest)
  assert.equal(retry.status, 201)
  await feature.inflight.get(retry.run.id)
  assert.equal(e['automations/retry'](retryRequest).run.id, retry.run.id)

  const [oldest] = prior
  const archived = await e['automations/saveRun']({...context, run_id: oldest.id})
  assert.deepEqual(archived.artifact.source, {
    workspace_id: W, automation_id: automation.id, automation_title: automation.title, run_id: oldest.id, body: oldest.resultText,
  })
  const newest = [scheduled.id, manual.run.id, retry.run.id].map(run_id => e['automations/run']({...context, run_id}).run)
  assert.deepEqual(newest.map(row => row.status), ['succeeded', 'succeeded', 'succeeded'])
  const readAll = status => {
    const items = []
    let cursor
    do {
      const page = e['automations/runs']({...context, limit: 19, status, cursor})
      items.push(...page.items.map(run => run.id))
      cursor = page.cursor
    } while (cursor)
    return items
  }
  const ordered = [...prior, ...newest].sort((a, b) => b.started - a.started || b.id.localeCompare(a.id))
  assert.deepEqual(readAll(), ordered.map(run => run.id))
  assert.deepEqual(readAll('failed'), ordered.filter(run => run.status === 'failed').map(run => run.id))
})

test('manual execution queues only the named automation and leaves its scheduled slot free', async () => {
  let finishTurn
  const calls = []
  const { e, feature } = fixture(args => new Promise(resolve => { calls.push(args); finishTurn = resolve }))
  const draft = {workspace_id: W, template_id: 'custom', prompt: 'Respond once', participants: ['alice'],
    schedule: {kind: 'now', time_zone: 'UTC'}}
  const {automation: target} = e['automations/create']({...draft, title: '手动', idempotency_key: 'm'.repeat(16)})
  const {automation: other} = e['automations/create']({...draft, title: '其他', idempotency_key: 'o'.repeat(16)})
  const req = {method: 'POST', path: `/v1/workspaces/${W}/automations/${target.id}/run`,
    body: {}, idempotency_key: 'q'.repeat(16)}
  const receipt = {...req, method: 'GET', body: undefined}
  assert.deepEqual((await e['automations/v1'](receipt)).body, {run: null})
  assert.equal(calls.length, 0, 'checking the receipt cannot queue a run')
  const accepted = await e['automations/v1'](req)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.run.trigger, 'manual')
  assert.equal(accepted.body.run.status, 'running')
  assert.deepEqual((await e['automations/v1'](receipt)).body.run, accepted.body.run)
  assert.deepEqual((await e['automations/v1']({...receipt, path: receipt.path.replace(target.id, other.id)})).body, {run: null})
  assert.equal((await e['automations/v1']({...receipt, path: receipt.path.replace(W, 'b'.repeat(32))})).status, 404)
  const runsPath = `/v1/workspaces/${W}/automations/${target.id}/runs`
  const detail = await e['automations/v1']({method: 'GET', path: runsPath + '/' + accepted.body.run.id})
  assert.equal(detail.body.run.status, 'running')
  assert.equal((await e['automations/v1']({method: 'GET', path: runsPath + '?status=running'})).body.items[0].id, accepted.body.run.id)
  const activeRun = {id:accepted.body.run.id, automation_id:target.id, workspace_id:W, status:'running'}
  assert.deepEqual((await e['automations/v1']({method: 'GET', path: runsPath + '?status=queued'})).body,
    {items: [], cursor: null, has_pending: true, active_run:activeRun, schedule_status: {state:'paused'}, schedule_revision: 1})
  assert.deepEqual(e['automations/get']({workspace_id:W,id:target.id}).automation.active_run, activeRun)
  assert.deepEqual(e['automations/list']({workspace_id:W}).items.find(item => item.id === target.id).active_run, activeRun)
  assert.equal(e['automations/get']({workspace_id:W,id:other.id}).automation.active_run, undefined)
  assert.equal((await e['automations/v1'](req)).body.run.id, accepted.body.run.id)
  assert.equal((await e['automations/v1']({...req, idempotency_key: 'x'.repeat(16)})).status, 409)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${target.id}`)
  assert.equal(e['automations/runs']({workspace_id: W, id: other.id}).items.length, 0)
  assert.equal(e['automations/get']({workspace_id: W, id: target.id}).automation.enabled, false)
  e['automations/update']({workspace_id: W, id: target.id, revision: 1, changes: {enabled: true}})
  assert.equal(feature.tick().length, 0, 'the pending manual run holds the automation until it finishes')
  finishTurn({text: '完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(feature.tick().length, 1)
  await flush()
  finishTurn({text: '定时完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/runs']({workspace_id: W, id: target.id}).items.length, 2)
})

test('retry is idempotent and a running turn cannot be cancelled or duplicated', async () => {
  let fail = true
  let release
  const { e, feature } = fixture(async () => {
    if (fail) throw Object.assign(new Error('x'), { code: 'openteamily/runtime-unavailable' })
    await new Promise((r) => { release = r })
    return { text: 'ok' }
  })
  const { automation } = e['automations/create']({ workspace_id: W, title: '现在', template_id: 'custom', prompt: 'do it', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'n'.repeat(16) })
  e['automations/update']({ workspace_id: W, id: automation.id, revision: 1, changes: { enabled: true } })
  feature.tick()
  await Promise.all(feature.inflight.values())
  const [failed] = e['automations/runs']({ workspace_id: W, id: automation.id }).items
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'runtime_unavailable')
  fail = false
  const retry = {workspace_id: W, id: automation.id, run_id: failed.id, idempotency_key: 'x'.repeat(16)}
  const receipt = {method: 'GET', path: `/v1/workspaces/${W}/automations/${automation.id}/runs/${failed.id}/retry`,
    idempotency_key: retry.idempotency_key}
  assert.deepEqual((await e['automations/v1'](receipt)).body, {run: null})
  const retried = e['automations/retry'](retry)
  assert.equal(retried.status, 201)
  assert.equal(retried.run.status, 'running')
  assert.equal(retried.run.trigger, 'retry')
  assert.equal((await e['automations/v1'](receipt)).body.run.id, retried.run.id)
  assert.equal(e['automations/retry'](retry).run.id, retried.run.id)
  const anotherRetry = {...retry, idempotency_key: 'y'.repeat(16)}
  assert.throws(() => e['automations/retry'](anotherRetry), error => error.code === 'automations/already_running')
  const manual = {workspace_id: W, id: automation.id, idempotency_key: 'm'.repeat(16)}
  assert.throws(() => e['automations/runNow'](manual), error => error.code === 'automations/already_running')
  await flush()
  const running = {workspace_id: W, id: automation.id, run_id: retried.run.id}
  assert.equal(e['automations/run'](running).run.status, 'running')
  assert.equal(e['automations/retry'](retry).run.id, retried.run.id)
  assert.throws(() => e['automations/cancel'](running), error => error.status === 409)
  release()
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/run'](running).run.status, 'succeeded')
  assert.equal((await e['automations/v1'](receipt)).body.run.status, 'succeeded')
  assert.equal(e['automations/runs'](running).has_pending, false)
})

test('startup interrupts claimed turns and resumes only previously unclaimed runs', async t => {
  const {e, feature, dbPath, clock} = fixture()
  const draft = {workspace_id: W, template_id: 'custom', prompt: 'Respond once', participants: ['alice'],
    schedule: {kind: 'now', time_zone: 'UTC'}}
  const {automation: first} = e['automations/create']({...draft, title: 'Interrupted', idempotency_key: 'i'.repeat(16)})
  const {automation: second} = e['automations/create']({...draft, title: 'Waiting', idempotency_key: 'w'.repeat(16)})
  const {automation: third} = e['automations/create']({...draft, title: 'Cancelled', idempotency_key: 'c'.repeat(16)})
  const claimedId = 'c'.repeat(32), queuedId = 'd'.repeat(32), cancelledId = 'e'.repeat(32)
  const insert = feature.db.prepare(`INSERT INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,status,dispatch,claimed_at)
    VALUES(?,?,?,0,?,'queued','{"backend":"ds-bot"}',?)`)
  insert.run(claimedId, first.id, W, clock.now, clock.now)
  insert.run(queuedId, second.id, W, clock.now, null)
  insert.run(cancelledId, third.id, W, clock.now, null)
  feature.db.close()

  clock.now += 20
  const calls = []
  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: async args => { calls.push(args); return {text: 'Recovered queued run'} }})
  t.after(() => { restored.stop(); restored.db.close() })
  const interrupted = restored.ops.run({workspace_id: W, id: first.id, run_id: claimedId}).run
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.error_code, 'interrupted')
  assert.equal(interrupted.finished, clock.now)
  assert.equal(restored.ops.runs({workspace_id: W, id: first.id}).has_pending, false)
  assert.equal(restored.ops.runs({workspace_id: W, id: second.id, status: 'queued'}).items[0].id, queuedId)
  assert.equal(restored.ops.cancel({workspace_id: W, id: third.id, run_id: cancelledId}).run.status, 'cancelled')
  restored.start()
  restored.start()
  await Promise.all(restored.inflight.values())
  assert.deepEqual(calls.map(item => item.requestId), [`ot-automation:${queuedId}`])
  assert.equal(restored.ops.run({workspace_id: W, id: second.id, run_id: queuedId}).run.status, 'succeeded')
  assert.deepEqual(restored.db.prepare('SELECT run_id,status FROM ot_automation_run_notices ORDER BY run_id').all()
    .map(row => [row.run_id, row.status]), [[claimedId, 'interrupted'], [queuedId, 'succeeded']])
})

test('older pending native rows have unknown delivery and become interrupted after migration', t => {
  const {e, feature, dbPath, clock} = fixture()
  const {automation} = e['automations/create']({workspace_id: W, title: 'Previous owner runtime', template_id: 'custom',
    prompt: 'Check once', participants: ['alice'], schedule: {kind: 'now', time_zone: 'UTC'}, idempotency_key: 'r'.repeat(16)})
  const id = 'f'.repeat(32)
  feature.db.exec('DROP TRIGGER ot_automation_notice_on_finish; ALTER TABLE ot_automation_runs DROP COLUMN claimed_at')
  feature.db.prepare("INSERT INTO ot_automation_runs VALUES(?,?,?,0,?,NULL,'queued',NULL,'{}',NULL)")
    .run(id, automation.id, W, clock.now)
  feature.db.close()

  const restored = createAutomations({db: new DatabaseSync(dbPath), clock: () => clock.now,
    turn: () => assert.fail('old pending work must not be dispatched')})
  t.after(() => { restored.stop(); restored.db.close() })
  assert.equal(restored.ops.run({workspace_id: W, id: automation.id, run_id: id}).run.error_code, 'interrupted')
  assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM ot_automation_run_notices').get().n, 0)
  restored.start()
  assert.equal(restored.inflight.size, 0)
})

test('legacy import is idempotent and never re-fires the already-run slot', () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature, calls } = fixture(null, at)
  const row = { id: 'c'.repeat(32), workspace_id: W, title: '迁移', prompt: 'p', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: true, revision: 3 }
  assert.equal(e['automations/import']({ automations: [row] }).imported, 1)
  assert.equal(e['automations/import']({ automations: [row] }).imported, 0)
  assert.equal(feature.tick().length, 0)
  assert.equal(calls.length, 0)
  assert.equal(e['automations/get']({ workspace_id: W, id: row.id }).automation.revision, 3)
})

test('the feature loads through the extension point and runs turns via the DS-Bot chatTurn service', async () => {
  process.env.OPENTEAMILY_AUTOMATIONS_CLOCK = '0'
  const data = mkdtempSync(join(tmpdir(), 'ot-auto-load-'))
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: data, log: () => {} })
  assert.ok(loaded.includes('automations'))
  const made = await table['automations/create']({ workspace_id: W, title: 'X', template_id: 'custom', prompt: 'p', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'l'.repeat(16) })
  assert.equal(made.status, 201)
  assert.equal((await table['automations/templates']()).items.length, Object.keys(TEMPLATES).length)
  const seen = []
  attachRuntime({ rt: {}, ctx: {}, chatTurn: async (key, text, rid) => { seen.push([key, rid]); return { text: 'hi', sessionId: 's', turnId: 't' } } })
  const turn = dsBotTurn({ runtime: async () => (await import('../src/host.js')).runtime() })
  const reply = await turn({ conversation: 'automation:1', prompt: 'p', requestId: 'r' })
  assert.deepEqual(seen, [['automation:1', 'r']])
  assert.equal(reply.session_id, 's')
  detachRuntime()
  attachRuntime({ rt: {}, ctx: {} })
  await assert.rejects(turn({ conversation: 'c', prompt: 'p' }), (err) => err.code === 'automations/runtime-unavailable')
  detachRuntime()
})



test('v1 lists templates and automations in the legacy /v1 shape', async () => {
  const { e } = fixture()
  const templates = await e['automations/v1']({ method: 'GET', path: '/v1/automation-templates' })
  assert.equal(templates.status, 200)
  assert.ok(templates.body.items.some((item) => item.id === 'custom'))
  const created = await e['automations/v1']({
    method: 'POST', path: `/v1/workspaces/${W}/automations`,
    idempotency_key: 'a'.repeat(20),
    body: { title: '晨报', prompt: '汇总。', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'] },
  })
  assert.equal(created.status, 201, created.body)
  const id = created.body.automation.id
  const listed = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations` })
  assert.equal(listed.body.items[0].id, id)
  const got = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations/${id}` })
  assert.equal(got.body.automation.title, '晨报')
  const updated = await e['automations/v1']({ method: 'POST', path: `/v1/workspaces/${W}/automations/${id}`, body: { revision: 1, changes: { enabled: true } } })
  assert.equal(updated.body.automation.enabled, true)
  const unknown = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/meetings` })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not_moved')
})

test('official import bundle marks the current slot skipped and does not re-import', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature } = fixture(null, at)
  const automations = [{
    id: 'c'.repeat(32), workspace_id: W, title: '旧报', title_hash: 'x', prompt: '汇总。', template_id: 'custom',
    schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: 1, revision: 1, created: 1, updated: 1,
  }]
  const text = JSON.stringify(automations)
  const history = JSON.stringify([
    {id: 'd'.repeat(32), automation_id: automations[0].id, workspace_id: W,
      due_at: at - 86400, started: at - 86400, status: 'succeeded', finished: at - 86399,
      dispatch: JSON.stringify({backend: 'runtime-connect', result: {text: 'Imported outcome'}})},
    {id: 'e'.repeat(32), automation_id: automations[0].id, workspace_id: W,
      due_at: at - 172800, started: at - 172800, status: 'queued'},
  ])
  const bundle = { format: 'openteamily-dsbot-import', version: 1, feature: 'automations', created: 1,
    tables: { automations: text, automation_runs: history },
    manifest: { automations: { rows: 1, sha256: sha(text) }, automation_runs: { rows: 2, sha256: sha(history) } } }
  const first = await feature.migrate(bundle)
  assert.equal(first.imported, 1)
  assert.equal(e['automations/list']({ workspace_id: W }).items[0].title, '旧报')
  const runs = e['automations/runs']({ workspace_id: W, id: 'c'.repeat(32) })
  assert.ok(runs.items.some((row) => row.status === 'skipped' && row.error_code === 'migrated'))
  const imported = runs.items.find(row => row.id === 'd'.repeat(32))
  assert.equal(imported.dispatch.backend, 'legacy')
  assert.equal(imported.result.text, 'Imported outcome')
  assert.equal(runs.items.find(row => row.id === 'e'.repeat(32)).status, 'skipped')
  assert.equal(runs.has_pending, false)
  assert.equal(feature.tick().length, 0)
  assert.equal((await feature.migrate(bundle)).imported, 0)
})

test('onboarding creates a paused automation for the verified owner and returns its exact ID on replay', async () => {
  const {calls, e, feature} = fixture()
  const request = {method: 'POST', path: '/v1/onboarding/automations',
    body: {workspace_id: W, template_ids: ['daily_brief'], username: 'forged-account'}}
  const call = {request: new Request('https://example.test', {headers: {'x-ot-owner-username': 'alice'}})}
  assert.equal((await e['automations/v1'](request, {request: new Request('https://example.test', {headers: {'x-ot-owner-username': ''}})})).status, 403)
  const denied = await e['automations/v1']({...request, body: {...request.body, workspace_id: 'b'.repeat(32)}}, call)
  assert.equal(denied.status, 403)
  const result = await e['automations/v1'](request, call)
  assert.equal(result.status, 201)
  const id = result.body.created[0].id
  const path = `/v1/workspaces/${W}/automations/${id}`
  const current = () => e['automations/get']({workspace_id: W, id}).automation
  assert.equal(current().enabled, false)
  assert.deepEqual(current().participants, [{username: 'alice'}])
  assert.equal(calls.length, 0)
  assert.equal((await e['automations/v1']({method: 'GET', path: path + '/remove'}, call)).status, 405)
  assert.equal((await e['automations/v1']({method: 'GET', path: `/v1/workspaces/${W}/automations/tick`}, call)).status, 405)
  e['automations/update']({workspace_id: W, id, revision: 1, changes: {title: '改名的简报'}})
  const retry = await e['automations/v1'](request, call)
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.body.created, [])
  assert.deepEqual(retry.body.skipped, [{id, template_id: 'daily_brief', title: '改名的简报'}])
  assert.equal(e['automations/list']({workspace_id: W}).items.length, 1)
  const run = await e['automations/v1']({method: 'POST', path: path + '/run', idempotency_key: 'onboarding-manual-1'}, call)
  assert.equal(run.status, 202)
  await feature.inflight.get(run.body.run.id)
  assert.equal(e['automations/run']({workspace_id: W, id, run_id: run.body.run.id}).run.result.text, 'DS-Bot did it')
  assert.equal(calls.length, 1)
  assert.equal(current().enabled, false)
})
