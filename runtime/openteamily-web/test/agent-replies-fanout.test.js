import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentReplier } from '../lib/c/agent-replies.js'

test('distinct agents answer the same message concurrently with an owner limit and ordered follow-up', {timeout: 4000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openteamily-agent-fanout-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const job = (agent, message) => ({
    job_id: agent + '-' + message,
    attempt: 1,
    conversation_id: 'product-group',
    mode: 'mention',
    agent_ref: agent,
    agent_name: agent,
    message: {id: message, revision: 1, body: '请回复'},
  })
  const jobs = [
    job('product', 'first'), job('engineering', 'first'), job('qa', 'first'),
    job('support', 'first'), job('product', 'second'),
  ]
  const turns = new Map(jobs.map(item => [item.job_id, {started:Promise.withResolvers(), reply:Promise.withResolvers()}]))
  const invoked = []
  const delivered = []
  const bs = {
    async get() { return {cursor:5, jobs} },
    async post(path, data) {
      if (path.endsWith('/agent-messages')) delivered.push([data.agent_ref, data.reply_to, data.body])
      return {}
    },
  }
  const replier = createAgentReplier({
    bs, stateFile:join(root, 'inbox.json'),
    host: {
      currentRuntime: () => ({chatTurn() {}}),
      async call(endpoint, request) {
        assert.equal(endpoint, 'agents/groupTurn')
        const id = request.request_id.split(':')[1]
        const turn = turns.get(id)
        invoked.push(id)
        turn.started.resolve()
        return turn.reply.promise
      },
    },
  })

  const working = replier.once()
  try {
    await Promise.all(jobs.slice(0, 3).map(item => turns.get(item.job_id).started.promise))
    assert.deepEqual(invoked, ['product-first', 'engineering-first', 'qa-first'])
    turns.get('engineering-first').reply.resolve({text: 'Engineering finished first'})
    turns.get('qa-first').reply.resolve({text: 'QA finished second'})
    turns.get('product-first').reply.resolve({text: 'Product finished third'})
    await turns.get('support-first').started.promise
    assert.deepEqual(invoked, ['product-first', 'engineering-first', 'qa-first', 'support-first'])
    turns.get('support-first').reply.resolve({text:'Support first message'})
    await turns.get('product-second').started.promise
    turns.get('product-second').reply.resolve({text:'Product follow-up'})
    assert.deepEqual(await working, {replied:5, cursor:5})
    assert.equal(delivered.length, 5)
    assert.deepEqual(delivered.at(-1), ['product', 'second', 'Product follow-up'])
  } finally {
    for (const turn of turns.values()) turn.reply.resolve({text:'Fixture cleanup'})
    await working
  }
})

test('native DS-Bot agents decide whether to join an ordinary conversation in order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openteamily-discretionary-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const source = {id: 'original', revision: 1, body: 'Any feedback on this plan?'}
  const inbox = {
    cursor: 1,
    jobs: ['product', 'engineering'].map(agent => ({
      job_id: agent, attempt: 1, conversation_id: 'room', mode: 'mention', discretionary: true,
      agent_ref: agent, agent_name: agent, message: source, context: [source],
    })),
  }
  const events = []
  const posted = []
  const bs = {
    async get() { return inbox },
    async post(path, value) {
      if (path.endsWith('/progress')) {
        assert.fail('A native pass token must never appear in progress')
      }
      if (value.action === 'start') {
        assert.equal(value.accept_discretionary_reply, true)
        assert.equal(value.source_revision, source.revision)
        events.push(path)
        return {discretionary:true, prior_replies:posted.map(text => ({name:'product',text}))}
      }
      if (value.action === 'pass') {
        events.push('pass')
        assert.match(value.claim_id,/^[a-f0-9-]{36}$/)
      } else if (path.endsWith('/agent-messages')) {
        events.push('delivered')
        posted.push(value.body)
      } else assert.fail('Unexpected job action')
      return {ok:true}
    },
  }
  const r = createAgentReplier({bs, stateFile:join(root, 'inbox.json'), host:{
    currentRuntime:() => ({chatTurn() {}}),
    async call(endpoint, request) {
      assert.equal(endpoint, 'agents/groupTurn')
      assert.match(request.text, /Reply exactly \[PASS\]/)
      if (request.agent_id === 'product') return {text:'I suggest validating the timeline with the customer.'}
      assert.ok(posted.length, 'Only start the next discretionary turn after the first has settled')
      assert.ok(request.text.includes(posted[0]), 'The next agent sees previously delivered replies in this round')
      request.onProgress(' [P')
      await delay(300)
      request.onProgress(' [PASS]')
      await delay(300)
      return {text:'[PASS]'}
    },
  }})

  assert.deepEqual(await r.once(), {replied:1, cursor:1})
  assert.deepEqual(events, ['/v1/ot/agent-reply-jobs/product','delivered','/v1/ot/agent-reply-jobs/engineering','pass'])
  assert.deepEqual(posted,['I suggest validating the timeline with the customer.'])
})
