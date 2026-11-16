// Onboard helpers against the fake Bot Social server. No DSH harness required.
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { onboard, onboardHome, readCredentials, writeCredentials } from '../../flybot/plugins/social/src/social.js'
import { isFakeToken, startFakeBotSocial } from '../../flybot-image/test/fake-bot-social.mjs'

test('onboardHome writes only an ot-fake- token and retries a taken handle', async (t) => {
  const fake = await startFakeBotSocial({ takeFirstHandle: true })
  t.after(() => fake.close())
  const result = await onboardHome({ server: fake.url, displayName: 'FlyBot' })
  assert.equal(result.token, fake.token)
  assert.equal(isFakeToken(result.token), true)
  assert.equal(result.home.id, 'bot_fake_home')
  assert.equal(fake.stats.onboard, 2)
  const home = mkdtempSync(join(tmpdir(), 'ot-creds-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const path = join(home, 'flybot-social.json')
  writeCredentials(path, { token: result.token, home: result.home, server: fake.url })
  const info = lstatSync(path)
  assert.equal(info.mode & 0o777, 0o600)
  const saved = readCredentials(path)
  assert.equal(saved.token, fake.token)
  const dumped = readFileSync(path, 'utf8')
  assert.match(dumped, /ot-fake-/)
})

test('onboard itself talks to POST /v1/onboard/flybot', async (t) => {
  const fake = await startFakeBotSocial()
  t.after(() => fake.close())
  const result = await onboard({ server: fake.url, displayName: 'OpenTeam' })
  assert.equal(isFakeToken(result.token), true)
  assert.equal(result.ownerId, 'owner_fake')
  assert.equal(fake.stats.onboard, 1)
})
