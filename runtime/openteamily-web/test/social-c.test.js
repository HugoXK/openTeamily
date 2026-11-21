// Stream C plugin features talk to Bot Social with this DS-Bot's own connector token.
// Fake Bot Social (fetch stub) and fixture credentials only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial, seg } from '../lib/c/bot-social.js'
import social from '../features/social/index.js'
import teams from '../features/teams/index.js'
import members from '../features/members/index.js'
import invites from '../features/invites/index.js'

const TOKEN = 'ot-fake-connector-token-for-tests'
const SERVER = 'https://social.example.test'

function creds(server = SERVER) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c-'))
  mkdirSync(join(dir, 'bot'))
  const path = join(dir, 'bot', 'flybot-social.json')
  writeFileSync(path, JSON.stringify({ token: TOKEN, server, home: { id: 'bot_1', handle: 'ann.home' } }), { mode: 0o600 })
  return path
}

function fakeFetch(answer = () => ({ ok: true })) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answer(url, init)
    const [status, body] = Array.isArray(a) ? a : [200, a]
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

test('personal workspace can include its native catalog and never reads a linked team catalog', async t => {
  const workspace = 'a'.repeat(32)
  const owner = 'c'.repeat(32)
  const previousOwner = process.env.OPENTEAMILY_OWNER_USER_ID
  process.env.OPENTEAMILY_OWNER_USER_ID = owner
  t.after(() => {
    if (previousOwner === undefined) delete process.env.OPENTEAMILY_OWNER_USER_ID
    else process.env.OPENTEAMILY_OWNER_USER_ID = previousOwner
  })
  const catalog = { items: [{ id: 'd'.repeat(32) }], cursor: null, activity_version: 'version' }
  const reads = []
  let available = true
  const endpoint = teams({ call: async (endpoint, payload) => {
    if (endpoint === 'agents/personal-binding') return { workspace_id: workspace, agent_id: 'b'.repeat(32) }
    assert.equal(endpoint, 'artifacts/v1')
    reads.push(payload)
    if (!available) throw new Error('unavailable')
    return { status: 200, body: catalog }
  } }).endpoints.v1
  const get = (query, call) => endpoint({ method: 'GET', path: '/v1/workspaces?scope=personal' + query }, call)
  const normal = await get('')
  assert.equal(normal.status, 200)
  assert.equal(normal.body.items[0].owner_id, owner)
  assert.equal(normal.body.catalog, undefined)
  assert.deepEqual((await get('&include=artifacts&workspace=' + 'e'.repeat(32))).body, normal.body)
  assert.equal(reads.length, 0)
  for (const query of ['&include=artifacts', '&include=artifacts&workspace=' + workspace]) {
    const result = await get(query)
    assert.deepEqual(result.body, { ...normal.body, catalog })
  }
  assert.deepEqual(reads, Array(2).fill({ method: 'GET', path: '/v1/workspaces/' + workspace + '/artifacts' }))
  assert.deepEqual((await get('&include=artifacts&order=recent')).body.catalog, catalog)
  assert.equal(reads.at(-1).path, '/v1/workspaces/' + workspace + '/artifacts?order=recent')
  available = false
  assert.deepEqual((await get('&include=artifacts')).body, normal.body)
  available = true
  delete process.env.OPENTEAMILY_OWNER_USER_ID
  assert.equal((await get('&include=artifacts')).body.catalog, undefined)
  const request = { headers: new Headers({ 'x-ot-owner-username': 'personal-test' }) }
  const gateway = await get('&include=artifacts', { request })
  assert.equal(gateway.body.viewer_username, 'personal-test')
  assert.equal(gateway.body.items[0].owner_id, null)
  assert.deepEqual(gateway.body.catalog, catalog)
})

test('the Chat snapshot reads only the local owner’s workspace and directory', async t => {
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const owner = 'c'.repeat(32)
  const previousOwner = process.env.OPENTEAMILY_OWNER_USER_ID
  process.env.OPENTEAMILY_OWNER_USER_ID = owner
  t.after(() => {
    if (previousOwner === undefined) delete process.env.OPENTEAMILY_OWNER_USER_ID
    else process.env.OPENTEAMILY_OWNER_USER_ID = previousOwner
  })
  const directory = { items: [{id: agent}], conversations: [{id: 'd'.repeat(32), agent_id: agent}], cursor: null }
  const entry = {agent: {id: agent, workspace_id: workspace},
    conversation: {id: 'd'.repeat(32), agent_id: agent, workspace_id: workspace}, items: [], cursor: null, has_newer: false}
  const reads = []
  const entries = []
  let available = true
  let hasEntry = true
  const endpoint = teams({ call: async (endpoint, payload) => {
    if (endpoint === 'agents/personal-binding') return { workspace_id: workspace, agent_id: agent }
    if (endpoint === 'agents/startupEntry') {
      entries.push(payload)
      return hasEntry ? entry : null
    }
    assert.equal(endpoint, 'agents/v1')
    reads.push(payload)
    if (!available) throw new Error('unavailable')
    return {status: 200, body: directory}
  } }).endpoints.v1
  const get = (where = '', call) => endpoint({method: 'GET', path: '/v1/workspaces?scope=personal&include=chat' + where}, call)
  const result = await get('&workspace=' + workspace)
  assert.equal(result.status, 200)
  assert.equal(result.body.items[0].owner_id, owner)
  assert.equal(result.body.personal_agent_id, agent)
  assert.deepEqual(result.body.chat, directory)
  assert.deepEqual(reads, [{method: 'GET', path: `/v1/workspaces/${workspace}/agents?limit=100&include=conversations`}])
  const other = await get('&workspace=' + 'e'.repeat(32))
  assert.equal(other.body.personal_agent_id, agent)
  assert.equal(other.body.chat, undefined)
  assert.equal(reads.length, 1)
  const hint = '&entry_agent=' + agent
  const exact = hint + '&entry_conversation=' + entry.conversation.id + '&directory=0'
  assert.deepEqual((await get('&workspace=' + workspace + exact)).body, {
    items: result.body.items, cursor: null, personal_agent_id: agent, entry,
  })
  assert.deepEqual(entries, [{workspace_id: workspace, agent_id: agent, conversation_id: entry.conversation.id}])
  assert.equal(reads.length, 1, 'an exact transcript does not need the directory')
  assert.equal((await get('&workspace=' + 'e'.repeat(32) + exact)).body.entry, undefined)
  assert.equal((await get(exact)).body.entry, undefined)
  assert.equal((await get('&workspace=' + workspace + exact + hint)).body.entry, undefined)
  assert.equal(entries.length, 1, 'unscoped and ambiguous hints cannot read a transcript')
  hasEntry = false
  assert.equal((await get('&workspace=' + workspace + exact)).body.chat, undefined)
  const newAgent = await get('&workspace=' + workspace + hint + '&directory=0')
  assert.equal(newAgent.body.entry, null)
  assert.deepEqual(newAgent.body.chat, directory, 'an agent without a snapshot can still open an empty draft')
  const bindingOnly = await get('&workspace=' + workspace + '&directory=0')
  assert.equal(bindingOnly.body.personal_agent_id, agent)
  assert.equal(bindingOnly.body.chat, undefined)
  available = false
  assert.equal((await get()).body.personal_agent_id, agent)
  assert.equal((await get()).body.chat, undefined)
  available = true
  delete process.env.OPENTEAMILY_OWNER_USER_ID
  assert.equal((await get()).body.personal_agent_id, undefined)
  assert.equal((await get()).body.chat, undefined)
  assert.equal((await get('&workspace=' + workspace + exact)).body.entry, undefined)
  const request = {headers: new Headers({'x-ot-owner-username': 'personal-test'})}
  const fromGateway = await get('', {request})
  assert.equal(fromGateway.body.viewer_username, 'personal-test')
  assert.deepEqual(fromGateway.body.chat, directory)
})

test('requests carry the saved connector token to exactly the configured server', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home', display_name: 'Ann' }))
  const bs = createBotSocial({ server: SERVER + '/', credentialsPath: creds(), fetch: f.fetch })
  const status = await bs.status()
  assert.equal(status.connected, true)
  assert.equal(status.handle, 'ann.home')
  assert.equal(f.calls[0].url, `${SERVER}/v1/ot/me`)
  assert.equal(f.calls[0].auth, `Bearer ${TOKEN}`)
  assert.ok(!JSON.stringify(status).includes(TOKEN), 'token never returned')
})

test('the same-site Bot Social sends authenticated requests over its private socket', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-soc-'))
  const socket = join(dir, 'social.sock')
  const requests = []
  const listener = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(req.url === '/v1/ot/redirect' ? 307 : 200, { 'content-type': 'application/json', location: 'https://other.test' })
    res.end(JSON.stringify({ ok: true }))
  })
  listener.listen(socket)
  await once(listener, 'listening')
  t.after(() => {
    listener.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const f = fakeFetch()
  const bs = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await bs.post('/v1/ot/teams', { name: 'Studio' }), { ok: true })
  assert.deepEqual([requests[0].method, requests[0].path, requests[0].headers.host, requests[0].headers.authorization],
    ['POST', '/v1/ot/teams', new URL(SERVER).host, `Bearer ${TOKEN}`])
  assert.deepEqual(JSON.parse(requests[0].body), { name: 'Studio' })
  await assert.rejects(bs.get('/v1/ot/redirect'), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 0)

  const remote = 'https://other.test'
  const other = createBotSocial({
    server: remote, credentialsPath: creds(remote), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await other.get('/v1/ot/teams'), { ok: true })
  assert.equal(f.calls[0].url, remote + '/v1/ot/teams')
  assert.equal(requests.length, 2)
  const unavailable = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: join(dir, 'missing.sock'), localServer: SERVER,
  })
  await assert.rejects(unavailable.post('/v1/ot/teams', { name: 'Studio' }), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 1)
})

test('no server, missing credentials or credentials for another server fail closed', async () => {
  const f = fakeFetch()
  const none = await createBotSocial({ server: async () => undefined, credentialsPath: creds(), fetch: f.fetch }).status()
  assert.deepEqual([none.connected, none.reason], [false, 'social/not-configured'])
  const other = await createBotSocial({ server: SERVER, credentialsPath: creds('https://other.test'), fetch: f.fetch }).status()
  assert.equal(other.reason, 'social/not-connected')
  const missing = await createBotSocial({ server: SERVER, credentialsPath: '/nonexistent/x.json', fetch: f.fetch }).status()
  assert.equal(missing.reason, 'social/not-connected')
  assert.equal(f.calls.length, 0, 'nothing is sent without a matching identity')
})

test('Bot Social errors map to typed codes without leaking the token', async () => {
  const f = fakeFetch(() => [404, { error: { code: 'team_not_found', message: 'no such team' } }])
  const bs = createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch })
  await assert.rejects(bs.get('/v1/ot/teams/x'), (e) => e.code === 'social/team_not_found' && !e.message.includes(TOKEN))
})

test('browser-supplied ids cannot reshape the Bot Social path', () => {
  assert.equal(seg('ott_01ABC'), 'ott_01ABC')
  for (const bad of ['../x', 'a/b', '', 'x?y', 'a b']) assert.throws(() => seg(bad), /invalid/)
})

test('teams, members, invites and social features map to the shared routes', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home' }))
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch }))
  const host = { dataDir: '/nonexistent' }
  const T = teams(host).endpoints, M = members(host).endpoints, I = invites(host).endpoints, S = social(host).endpoints
  await T.create({ name: 'Studio', slug: 'studio-a', summary: 's', extra: 'dropped' })
  await T.directory({ q: 'guild' })
  await T.setListing({ team_id: 'ott_1', listed: true })
  await M.setRole({ team_id: 'ott_1', handle: 'bea.home', role: 'admin' })
  await M.leave({ team_id: 'ott_1' })
  await I.create({ team_id: 'ott_1', requires_approval: true })
  await I.accept({ code: 'c'.repeat(32) })
  await I.decide({ team_id: 'ott_1', request_id: 'otjr_1', decision: 'approve' })
  await S.notifications({ after: 3 })
  const seen = f.calls.map((c) => `${c.method} ${c.url.slice(SERVER.length)}`)
  assert.deepEqual(seen, [
    'POST /v1/ot/teams',
    'GET /v1/ot/directory?q=guild',
    'PUT /v1/ot/teams/ott_1/listing',
    'PATCH /v1/ot/teams/ott_1/members/bea.home',
    'GET /v1/ot/me',
    'DELETE /v1/ot/teams/ott_1/members/ann.home',
    'POST /v1/ot/teams/ott_1/invites',
    'POST /v1/ot/invites/accept',
    'POST /v1/ot/teams/ott_1/join-requests/otjr_1',
    'GET /v1/ot/notifications?after=3',
  ])
  assert.deepEqual(f.calls[0].body, { name: 'Studio', slug: 'studio-a', summary: 's' })
  assert.equal(f.calls[6].body.requires_approval, true)
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`))
})

test('the native inbox requests recent scoped notices and constructs safe meeting and Discover links', async t => {
  const personal = 'a'.repeat(32)
  const team = 'b'.repeat(32)
  const share = 'c'.repeat(32)
  const item = (kind,data,seq) => ({kind,data,seq,id:`notice-${seq}`,created_at:4000,read:false})
  const f = fakeFetch((url,init) => {
    const scope = new URL(url).searchParams
    if (init.method === 'POST') return {unread:1}
    const scoped = scope.get('workspace_id')
    if (scoped && scoped !== team) return [404,{error:{code:'not_found',message:'workspace not found'}}]
    return {unread:4,notifications:[
      item('meeting.shared',{share_id:share,title:'纪要',organizer:'Alice',...(scoped ? {workspace_id:scoped}:{}),path:'//outside.test'},7),
      item('meeting.shared',{share_id:share,workspace_id:'d'.repeat(32)},6),
      item('discover.published',{slug:'design-log',kind:'work',title:'设计',creator:{display_name:'Bob'},path:'//outside.test'},5),
      item('discover.published',{slug:'helper-1',listing_kind:'agent',creator:{handle:'bob.home'}},4),
      item('discover.published',{slug:'../x',kind:'work',path:'//outside.test'},3),
    ]}
  })
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call(name) {
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }}).endpoints.v1
  const local = await endpoint({method:'GET',path:`/v1/workspaces/${personal}/notifications?filter=unread`})
  assert.equal(f.calls.at(-1).url,SERVER+'/v1/ot/notifications?limit=200&latest=1&personal=1&unread=1')
  assert.equal(local.status,200)
  assert.equal(local.body.unread_count,4)
  assert.deepEqual(local.body.items.map(row=>row.seq),[7,5,4,3])
  assert.equal(local.body.items[0].path,`/meetings#workspace=${personal}&shared=${share}`)
  assert.equal(local.body.items[0].workspace_id,personal)
  assert.equal(local.body.items[1].kind,'discover.published')
  assert.equal(local.body.items[1].listing_kind,'work')
  assert.equal(local.body.items[1].path,'/w/design-log')
  assert.equal(local.body.items[2].path,'/a/helper-1')
  assert.equal(local.body.items[3].path,undefined)
  const scoped = await endpoint({method:'GET',path:`/v1/workspaces/${team}/notifications`})
  assert.equal(f.calls.at(-1).url,SERVER+`/v1/ot/notifications?limit=200&latest=1&workspace_id=${team}`)
  assert.equal(scoped.body.items[0].path,`/meetings#workspace=${team}&shared=${share}`)
  const read = await endpoint({method:'POST',path:`/v1/workspaces/${team}/notifications/read`,body:{notification_id:'notice-7'}})
  assert.deepEqual(read,{status:200,body:{unread_count:1}})
  assert.deepEqual(f.calls.at(-1).body,{notification_id:'notice-7',workspace_id:team})
  assert.equal((await endpoint({method:'GET',path:`/v1/workspaces/${'e'.repeat(32)}/notifications`})).status,404)
  assert.equal(f.calls.length,4)
})

test('Space work notices map account messages to the recipient workspace and scope their read updates', async t => {
  const workspace = 'a'.repeat(32)
  const conversation = 'otc_' + 'B'.repeat(26)
  const message = 'otm_' + 'C'.repeat(26)
  const notice = {id:'fixture-notice',seq:8,kind:'artifact.shared',created_at:9500,read:false,
    data:{conversation_id:conversation,message_id:message,title:'排期表',actor_username:'Alice'}}
  const f = fakeFetch((url, init) => init.method === 'GET' ? {unread:3,notifications:[
    notice, {...notice,id:'malformed',data:{...notice.data,conversation_id:'../profile'}},
  ]} : {unread:0})
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call() { return {workspace_id:workspace} }}).endpoints.v1
  const base = `/v1/workspaces/${workspace}/notifications`
  const list = await endpoint({method:'GET',path:base+'?kind=work&limit=1'})
  assert.deepEqual(list, {status:200,body:{limit:1,unread_count:3,items:[{
    id:'fixture-notice',seq:8,kind:'artifact.shared',created:9,read:false,
    conversation_id:conversation,message_id:message,workspace_id:workspace,title:'排期表',actor_username:'Alice',
    path:`/chat#workspace=${workspace}&social=${conversation}&message=${message}`,
  }]}})
  assert.equal(f.calls[0].url,SERVER+'/v1/ot/notifications?limit=1&latest=1&personal=1&kind=work')
  const read = await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'work'}})
  assert.deepEqual(read,{status:200,body:{unread_count:0}})
  assert.deepEqual(f.calls[1].body,{all:true,personal:true,kind:'work'})
  assert.equal((await endpoint({method:'GET',path:base+'?kind=work&kind=work'})).status,400)
  assert.equal((await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'unknown'}})).status,400)
  assert.equal(f.calls.length,2)
})
