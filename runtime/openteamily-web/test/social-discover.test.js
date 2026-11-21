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

test('catalog publication is explicit and remix copies the previewed release in the destination runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-remix-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const workspaceId = 'a'.repeat(32)
  const agentId = 'b'.repeat(32)
  const agent = {
    id: agentId, name: 'Writer', summary: 'Draft assistance', category: 'design',
    instructions: 'Released writing instructions', revision: 5, memory: 'PRIVATE MEMORY',
    quick_starts: ['Preview this plan'],
  }
  let row
  const created = []
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    if (path === '/v1/ot/listings' && init.method === 'PUT') {
      row = { id: 'listing-1', listed: true, ...JSON.parse(init.body) }
      return Response.json(row)
    }
    if (path === '/v1/ot/discover/writer') return Response.json(row)
    if (path === '/v1/ot/listings/mine') return Response.json({listings:[row]})
    if (path === '/v1/ot/discover/writer/start') {
      assert.deepEqual(JSON.parse(init.body), {quick_start:0, quick_start_version:'a'.repeat(64)})
      return Response.json({conversation_id:'test-thread', draft_text:'Preview this plan'})
    }
    if (path === '/v1/ot/discover?kind=agent&q=Draft&creator=alice.home&category=design') {
      return Response.json({ items: [{ ...row, creator: {handle: 'alice.home', display_name: 'Alice'} }] })
    }
    throw new Error('Unexpected request: ' + path)
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath, fetch }))
  const E = discover({
    dataDir: dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/get') {
        assert.deepEqual(payload, { id: agentId, workspace_id: workspaceId })
        return { agent }
      }
      if (endpoint === 'agents/personal-binding') return { workspace_id: workspaceId }
      assert.equal(endpoint, 'agents/create')
      created.push(payload)
      return { status: 201, agent: { id: 'c'.repeat(32), name: payload.name } }
    },
  }).endpoints
  const publish = '/v1/workspaces/' + workspaceId + '/agents/' + agentId + '/discover'
  const remix = '/v1/discover/agents/writer/remix'
  const call = (method, path, body) => E.v1({ method, path, body, idempotency_key: 'a-valid-remix-key' })
  assert.equal((await call('POST', publish, { slug: 'writer' })).status, 200)
  assert.equal(row.snapshot, undefined)
  assert.equal((await call('GET', remix)).body.template.instructions, '')
  const publicStart = '/v1/discover/agents/writer/start'
  const quick = {quick_start:0, quick_start_version:'a'.repeat(64)}
  assert.equal((await call('POST', publicStart, {...quick, body:'Forged'})).status, 400)
  assert.deepEqual((await call('POST', publicStart, quick)).body,
    {conversation_id:'test-thread', draft_text:'Preview this plan', workspace_id:workspaceId})
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:'yes'})).status, 400)
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:true})).body.discover.publish_quick_starts,true)
  assert.deepEqual(JSON.parse(row.snapshot), {version:1, quick_starts:agent.quick_starts})
  assert.equal((await call('GET', publish)).body.discover.publish_quick_starts,true)

  assert.equal((await call('POST', publish, { slug: 'writer', revision: 5, copy_instructions: true })).status, 200)
  assert.equal(row.category, 'design')
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE MEMORY/)
  const feed = await call('GET', '/v1/discover/agents?q=Draft&category=design&creator=alice.home')
  assert.deepEqual(feed.body.items[0].creator, { handle: 'alice.home', name: 'Alice' })
  assert.equal('snapshot' in feed.body.items[0], false)
  const {template} = (await call('GET', remix)).body
  assert.equal(template.instructions, agent.instructions)
  assert.equal((await call('POST', remix, {
    revision: template.revision, workspace_id: workspaceId, name: 'My writer', instructions: 'Override ignored',
  })).status, 201)
  assert.deepEqual(created, [{
    workspace_id: workspaceId, idempotency_key: 'a-valid-remix-key', name: 'My writer',
    summary: agent.summary, category: agent.category, instructions: agent.instructions,
  }])
  assert.equal((await call('POST', publish, { slug: 'writer', revision: 4, copy_instructions: true })).status, 409)
  assert.equal((await call('POST', publish, { slug: 'writer', copy_instructions: false })).status, 200)
  assert.equal((await call('POST', remix, { revision: template.revision, workspace_id: workspaceId })).status, 409)
  row.listed = false
  assert.equal((await call('GET', remix)).status, 404)
  assert.equal(created.length, 1)
})

test('native Discover forwards popularity cursors separately and publishes only the selected saved 3D revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-models-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const workspace = 'a'.repeat(32)
  const artifact = '3'.repeat(32)
  const cursor = 'd'.repeat(32) + '.12'
  const kind = 'model/gltf-binary'
  const published = {id: 'entry', kind: 'work', work_kind: 'model3d', slug: 'vase', title: '陶瓷花瓶', listed: true}
  const modelData = Buffer.from('published GLB fixture').toString('base64')
  let review = false
  const fetch = async (url, init) => {
    const target = new URL(url)
    if (target.pathname === '/v1/ot/discover') {
      if (target.searchParams.has('before')) {
        assert.equal(target.searchParams.get('before'), '123')
        assert.equal(target.searchParams.has('sort'), false)
        return Response.json({items: [], next_before: 100})
      }
      assert.equal(target.searchParams.get('kind'), 'work')
      assert.equal(target.searchParams.get('sort'), 'popular')
      assert.equal(target.searchParams.get('work_kind'), 'model3d')
      assert.equal(target.searchParams.get('cursor'), cursor)
      return review
        ? Response.json({error: {code: 'popularity_expired', message: 'refresh'}}, {status: 409})
        : Response.json({items: [{...published, model_data: modelData}], next_cursor: cursor})
    }
    if (target.pathname === '/v1/ot/listings/mine') return Response.json({listings: []})
    assert.equal(target.pathname, '/v1/ot/listings')
    assert.equal(init.method, 'PUT')
    assert.deepEqual(JSON.parse(init.body), {
      kind: 'work', ref: artifact, slug: 'vase', title: '陶瓷花瓶',
      summary: '', work_kind: 'model3d', snapshot: '', model_data: modelData,
    })
    return Response.json(published)
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = discover({
    dataDir: dir,
    async call(endpoint, input) {
      if (endpoint === 'artifacts/v1') {
        assert.equal(input.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
        return {body: {artifact: {kind: 'media', title: '陶瓷花瓶', revision: 5, media: {mime: kind}}}}
      }
      assert.equal(endpoint, 'artifacts/chatAttachment')
      assert.deepEqual(input, {workspace_id: workspace, artifact_id: artifact, revision: 5})
      return {attachment: {mime: kind, data: modelData}}
    },
  }).endpoints.v1
  const feed = '/v1/discover/me/works?sort=popular&kind=model3d&cursor=' + cursor
  const results = await call({method: 'GET', path: feed})
  assert.equal(results.body.items[0].kind, 'model3d')
  assert.equal(results.body.items[0].model_data, undefined)
  assert.equal(results.body.cursor, cursor)
  assert.equal((await call({method: 'GET', path: '/v1/discover/me/works?cursor=123'})).body.cursor, 100)
  review = true
  const expired = await call({method: 'GET', path: feed})
  assert.equal(expired.status, 409)
  assert.equal(expired.body.error.code, 'popularity_expired')
  const saved = await call({method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`, body: {slug: 'vase'}})
  assert.equal(saved.status, 201)
  assert.equal(saved.body.discover.listed, true)
})

test('native work detail and comment routes forward the personal connector and return public projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-comments-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'commenter-fixture', server: SERVER}), {mode: 0o600})
  const upstream = '/v1/ot/discover/writer-demo'
  const root = '/v1/discover/works/writer-demo'
  const id = 'otwc_' + '0'.repeat(26)
  const key = 'comment-key-2026-11'
  const comment = {
    id, parent_id: null, body: '欢迎交流', created_at: 1_790_000_000_000,
    author: {handle: 'writer.home', name: '作者', platform_user_id: 'private'},
    mine: true, can_remove: true, removed: false, reply_count: 0, likes: 0, liked: false,
    owner_id: 'private',
  }
  let creates = 0
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer commenter-fixture')
    const path = url.slice(SERVER.length)
    if (path === upstream + '/detail?tab=collected&q=design&work_kind=model3d') return Response.json({
      work: {kind: 'work', listed: true, slug: 'writer-demo', title: '参考作品', comment_count: 1, snapshot: 'private instruction'},
      previous: null, next: {slug: 'other-work', title: '另一件作品', owner_id: 'private'},
    })
    if (path === upstream + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12') {
      return Response.json({items: [comment], cursor: null, comment_count: 1})
    }
    if (path === upstream + '/comments') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), {body: '欢迎交流', client_key: key})
      return Response.json({comment, comment_count: 1, replayed: creates++ > 0})
    }
    if (path === upstream + '/comments/' + id + '/like') {
      assert.deepEqual(JSON.parse(init.body), {enabled: true})
      return Response.json({comment: {...comment, liked: true, likes: 1}})
    }
    assert.equal(path, upstream + '/comments/' + id + '/remove')
    return Response.json({comment_count: 0})
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = (method, path, body, idempotency_key) =>
    discover({dataDir: dir}).endpoints.v1({method, path, body, idempotency_key})

  const detail = (await call('GET', root + '?tab=collected&q=design&kind=model3d')).body
  assert.equal(detail.work.comment_count, 1)
  assert.ok(!Object.hasOwn(detail.work, 'snapshot'))
  assert.equal(detail.previous, null)
  assert.deepEqual(detail.next, {slug: 'other-work', title: '另一件作品'})
  assert.equal((await call('GET', root + '?cursor=12')).status, 400)
  assert.equal((await call('GET', root + '?sort=popular&sort=latest')).status, 400)
  const page = await call('GET', root + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12')
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items[0].author, {handle: 'writer.home', name: '作者'})
  assert.ok(!Object.hasOwn(page.body.items[0], 'owner_id'))
  assert.equal((await call('POST', root + '/comments', {body: comment.body})).status, 400)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 201)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 200)
  const update = await call('POST', root + '/comments/' + id + '/like', {enabled: true})
  assert.equal(update.body.comment.liked, true)
  assert.equal((await call('POST', root + '/comments/' + id + '/remove', {})).body.comment_count, 0)
  assert.equal((await call('GET', root + '/comments?limit=1&limit=2')).status, 400)
})
