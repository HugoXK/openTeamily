// Stream C discover feature maps to the shared catalog routes (fake Bot Social).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import discover from '../features/discover/index.js'

const SERVER = 'https://social.example.test'

test('discover endpoints publish only the whitelisted projection and browse the shared feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const calls = []
  const fetch = async (url, init) => { calls.push({ method: init.method, path: url.slice(SERVER.length), body: init.body ? JSON.parse(init.body) : undefined }); return new Response('{}') }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  const E = discover({ dataDir: dir }).endpoints
  await E.publish({ kind: 'agent', ref: 'bot_1', slug: 'writer', title: 'Writer', instructions: 'SECRET PROMPT', memory: 'private' })
  await E.feed({ tab: 'following', q: 'deck' })
  await E.like({ listing_id: 'otl_1' })
  await E.collect({ listing_id: 'otl_1', on: false })
  await E.follow({ handle: 'ann.home' })
  await E.get({ slug: 'writer' })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'PUT /v1/ot/listings', 'GET /v1/ot/discover?tab=following&q=deck', 'POST /v1/ot/listings/otl_1/like',
    'POST /v1/ot/listings/otl_1/collect', 'POST /v1/ot/follows', 'GET /v1/ot/discover/writer',
  ])
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'), 'instructions are never published')
  assert.ok(!('memory' in calls[0].body))
  assert.equal(calls[3].body.on, false)
})
