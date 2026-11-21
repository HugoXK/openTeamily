import assert from 'node:assert/strict'
import test from 'node:test'
import { boot, key, WS } from './helpers.js'

const base = (rest = '') => `/v1/workspaces/${WS}/memory${rest}`

test('memory actions run in DS-Bot: create linked to a page, filter, update, conflict, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const page = (await call('POST', base(), { title: '项目甲', body: '要点' }, key())).body.page
  const k = key()
  const created = await call('POST', base('/actions'), { title: '发周报', notes: '周五', due_at: 1800000000, memory_page_id: page.id }, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.action.memory_page_title, '项目甲')
  assert.equal((await call('POST', base('/actions'), { title: '发周报', notes: '周五', due_at: 1800000000, memory_page_id: page.id }, k)).status, 200)
  assert.equal((await call('POST', base('/actions'), { title: 'x', memory_page_id: 'f'.repeat(32) }, key())).status, 400)
  const action = created.body.action
  assert.equal((await call('GET', base('/actions?status=open'))).body.items.length, 1)
  assert.equal((await call('GET', base('/actions?status=bad'))).status, 400)
  const done = await call('POST', base(`/actions/${action.id}`), { revision: 1, changes: { status: 'done' } })
  assert.equal(done.body.action.status, 'done')
  assert.equal((await call('POST', base(`/actions/${action.id}`), { revision: 1, changes: { status: 'open' } })).status, 409)
  assert.equal((await call('GET', base('/actions?status=open'))).body.items.length, 0)
  assert.equal((await call('POST', base(`/actions/${action.id}/remove`), {})).status, 200)
})

test('links and the graph (topics, [[mentions]], manual links) are computed in DS-Bot', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const a = (await call('POST', base(), { title: '甲', body: '见 [[乙]]', topics: ['客户'] }, key())).body.page
  const b = (await call('POST', base(), { title: '乙', body: '', topics: ['客户'] }, key())).body.page
  const c = (await call('POST', base(), { title: '丙', body: '' }, key())).body.page
  const link = await call('POST', base('/links'), { source: c.id, target: a.id }, key())
  assert.equal(link.status, 201)
  assert.equal((await call('POST', base('/links'), { source: a.id, target: c.id }, key())).status, 409)
  assert.equal((await call('POST', base('/links'), { source: a.id, target: a.id }, key())).status, 400)
  const graph = (await call('GET', base('/graph'))).body
  assert.deepEqual(graph.counts, { nodes: 3, edges: 2, topics: 1 })
  assert.deepEqual(graph.edges.map((edge) => edge.kind).sort(), ['manual', 'mention'])
  assert.equal(graph.topics[0].page_count, 2)
  assert.equal((await call('POST', base(`/links/${link.body.link.id}/remove`), {})).status, 200)
  assert.equal((await call('GET', base('/graph'))).body.counts.edges, 1)
  assert.ok(b.id)
})

test('profile and preferences belong to this DS-Bot owner and feed memory/personal', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  assert.equal((await call('GET', base('/profile'))).body.profile.revision, 0)
  const saved = await call('POST', base('/profile'), { revision: 0, professional: '产品经理', work_style: '早起', communication: '简洁' })
  assert.equal(saved.body.profile.revision, 1)
  assert.equal((await call('POST', base('/profile'), { revision: 0, professional: '', work_style: '', communication: '' })).status, 409)
  const pref = await call('POST', base('/preferences'), { text: '回复用中文' }, key())
  assert.equal(pref.status, 201)
  assert.equal((await call('POST', base('/preferences'), { text: '回复用中文 ' }, key())).status, 200, 'same text is not duplicated')
  assert.equal((await call('GET', base('/preferences'))).body.items.length, 1)
  const otherWorkspace = 'e'.repeat(32)
  const outside = `/v1/workspaces/${otherWorkspace}/memory`
  await call('POST', outside + '/profile', { revision: 0, professional: '另一工作区', work_style: '', communication: '' })
  await call('POST', outside + '/preferences', { text: '回复用德语' }, key())
  const personal = await bot.endpoint('memory/personal', {workspace_id:WS})
  assert.equal(personal.value.workspace_id,WS)
  assert.deepEqual(personal.value.preferences, ['回复用中文'])
  assert.equal(personal.value.profile.professional, '产品经理')
  const firstRevision = {revision:1, professional:'产品经理', communication:'简洁'}
  const raced = await Promise.all(['早会', '晚会'].map(work_style => call('POST', base('/profile'), {...firstRevision, work_style})))
  assert.deepEqual(raced.map(result => result.status).sort(), [200,409])
  assert.equal((await call('GET', base('/profile'))).body.profile.revision,2)
  assert.equal((await call('POST', base(`/preferences/${pref.body.preference.id}/remove`), {})).status, 200)
  assert.deepEqual((await bot.endpoint('memory/personal', {workspace_id:WS})).value.preferences, [])
  assert.deepEqual((await bot.endpoint('memory/personal', {workspace_id:otherWorkspace})).value.preferences, ['回复用德语'])
  assert.equal((await bot.endpoint('memory/personal', {})).ok,false)
  const other = await boot()
  assert.deepEqual((await other.endpoint('memory/personal', {workspace_id:WS})).value.preferences, [])
})
