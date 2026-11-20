import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFeatures } from '../src/features.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { tokens, rank } from '../features/chat/recall.js'

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'features')
const identity = { instanceId: 'd'.repeat(32) }

async function load() {
  const data = mkdtempSync(join(tmpdir(), 'ot-chat-'))
  const { table, failed } = await loadFeatures({ dir, identity, dataDir: data, log: () => {} })
  assert.deepEqual(failed, [])
  return table
}

test('recall tokens: Latin words and CJK bigrams', () => {
  assert.deepEqual(tokens('The Roadmap 计划表'), ['roadmap', '计划', '划表'])
  const pages = [{ id: 'p1', title: 'Launch', body: 'roadmap for Q3 launch' }, { id: 'p2', title: '其他', body: '午餐' }]
  assert.deepEqual(rank('what is the launch roadmap', pages).map((h) => h.page.id), ['p1'])
  assert.deepEqual(rank('nothing matches', pages), [])
})

test('chat turns run through the DS-Bot chatTurn service with profile and memory recall', async () => {
  const table = await load()
  table['memory/pages'] = async () => [{ id: 'm1', revision: 2, title: 'Launch plan', body: 'The launch is on Friday in Hangzhou.' }]
  const calls = []
  attachRuntime({ rt: {}, ctx: {}, chatTurn: async (key, text, requestId) => { calls.push({ key, text, requestId }); return { text: 'Friday.', sessionId: 's1', turnId: 't1' } } })
  try {
    await table['personal/set']({ name: 'Ada', instructions: 'Answer briefly.' })
    const convo = await table['chat/create']({ title: 'Plans' })
    const out = await table['chat/send']({ conversation_id: convo.id, text: 'When is the launch?' })
    assert.equal(out.reply.text, 'Friday.')
    assert.equal(out.reply.meta.engine, 'ds-bot')
    assert.deepEqual(out.reply.meta.memory_refs.map((r) => r.id), ['m1'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].key, 'plugin:' + convo.id)
    assert.match(calls[0].text, /Answer briefly\./)
    assert.match(calls[0].text, /\[1\] Launch plan \(memory page m1 r2\)/)
    assert.match(calls[0].text, /When is the launch\?$/)
    const history = await table['chat/messages']({ conversation_id: convo.id })
    assert.deepEqual(history.items.map((m) => m.role), ['user', 'assistant'])
    assert.equal((await table['chat/conversations']()).items.length, 1)
    await table['personal/set']({ recall: 'off' })
    const off = await table['chat/send']({ conversation_id: convo.id, text: 'launch again' })
    assert.deepEqual(off.reply.meta.memory_refs, [])
    await assert.rejects(table['chat/send']({ conversation_id: 'x', text: 'hi' }), { code: 'chat/invalid' })
    await assert.rejects(table['chat/send']({ conversation_id: 'e'.repeat(32), text: 'hi' }), { code: 'chat/not-found' })
    await table['chat/remove']({ conversation_id: convo.id })
    assert.equal((await table['chat/conversations']()).items.length, 0)
  } finally { detachRuntime() }
})

test('chat without the DS-Bot service fails closed', async () => {
  const table = await load()
  attachRuntime({ rt: {}, ctx: {} })
  try {
    const convo = await table['chat/create']({})
    await assert.rejects(table['chat/send']({ conversation_id: convo.id, text: 'hi' }), { code: 'chat/runtime-unavailable' })
  } finally { detachRuntime() }
})

test('skills are native DS-Bot capabilities attached to the Main Bot', async () => {
  const table = await load()
  const bot = { capabilities: ['ot-skill-abc', 'other'] }
  const saved = []
  const rt = {
    botOf: () => bot,
    capabilitySave: async (cap) => { saved.push(cap) },
    changeCapabilityAttachment: async (op, { name }) => { if (op === 'attach') bot.capabilities.push(name); else bot.capabilities = bot.capabilities.filter((n) => n !== name) },
  }
  attachRuntime({ rt, ctx: {}, mainBot: async () => 'bot1' })
  try {
    await table['skills/save']({ name: 'weekly-review', content: 'Do the review.' })
    assert.equal(saved[0].kind, 'skill')
    assert.deepEqual((await table['skills/list']()).items, [
      { name: 'ot-skill-abc', source: 'openteamily' }, { name: 'ot-user-skill-weekly-review', source: 'user' }])
    await assert.rejects(table['skills/save']({ name: 'Bad Name', content: 'x' }), { code: 'skills/invalid' })
    await table['skills/remove']({ name: 'weekly-review' })
    assert.equal(bot.capabilities.includes('ot-user-skill-weekly-review'), false)
  } finally { detachRuntime() }
})

test('legacy history import is idempotent and keeps ids', async () => {
  const table = await load()
  const c = 'a'.repeat(32)
  const payload = { conversations: [{ id: c, title: 'Old chat', created: 1700000000, updated: 1700000100,
    messages: [{ id: 'b'.repeat(32), role: 'user', body: 'hi', created: 1700000000 }, { id: 'c'.repeat(32), role: 'assistant', body: 'hello', created: 1700000001 },
      { id: 'bad', role: 'user', body: 'x' }] }] }
  assert.deepEqual(await table['chat/import'](payload), { conversations: 1, messages: 2, done: false })
  assert.deepEqual(await table['chat/import'](payload), { conversations: 0, messages: 0, done: false })
  assert.equal((await table['chat/importStatus']()).done, false)
  await table['chat/import']({ conversations: [], finish: true })
  assert.equal((await table['chat/importStatus']()).done, true)
  const history = await table['chat/messages']({ conversation_id: c })
  assert.deepEqual(history.items.map((m) => [m.role, m.text, m.created]), [['user', 'hi', 1700000000000], ['assistant', 'hello', 1700000001000]])
  await assert.rejects(table['chat/import']({ conversations: [{ id: 'nope' }] }), { code: 'chat/invalid' })
})

test('skills/sync materializes digest-checked bound skills and detaches stale ones', async () => {
  const { createHash } = await import('node:crypto')
  const table = await load()
  const bot = { capabilities: ['ot-bound-old', 'ot-skill-x'] }
  const rt = { botOf: () => bot, capabilitySave: async () => {},
    changeCapabilityAttachment: async (op, { name }) => { bot.capabilities = op === 'attach' ? [...bot.capabilities, name] : bot.capabilities.filter((n) => n !== name) } }
  attachRuntime({ rt, ctx: {}, mainBot: async () => 'bot1' })
  try {
    const content = '# Weekly review'
    const digest = createHash('sha256').update(content).digest('hex')
    assert.deepEqual(await table['skills/sync']({ items: [{ id: 'weekly-review', version: '1.0.0', name: 'Weekly', digest, content }] }), { attached: ['ot-bound-weekly-review'] })
    assert.deepEqual(bot.capabilities.sort(), ['ot-bound-weekly-review', 'ot-skill-x'])
    await assert.rejects(table['skills/sync']({ items: [{ id: 'weekly-review', digest, content: 'tampered' }] }), { code: 'skills/digest-mismatch' })
  } finally { detachRuntime() }
})
