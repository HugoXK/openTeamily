import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
