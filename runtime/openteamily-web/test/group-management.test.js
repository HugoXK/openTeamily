import assert from 'node:assert/strict'
import test from 'node:test'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { messengerV1 } from '../lib/c/legacy-v1.js'
import { nativeGroupClient } from '../lib/c/native-groups.js'

const personal = 'a'.repeat(32)
const teamWorkspace = 'b'.repeat(32)
const room = 'otc_group'
const group = (title, revision) => ({
  id:room,kind:'group',title,account_group:true,activity_version:`1.${revision}.0.0`,
  members:[{owner_id:'social_member',platform_user_id:'c'.repeat(32),handle:'sample.home'}],
  group_management:{revision,owner_id:'social_member',can_rename:true},
})

test('the browser group bridge derives its scope and preserves stable member identities and leave receipts', async t => {
  t.after(() => setSharedBotSocial(undefined))
  const writes = []
  setSharedBotSocial({
    async request(method,path,payload) {
      if (path === '/v1/ot/me') return {owner_id:'social_member'}
      assert.equal(method,'POST')
      assert.equal(path,`/v1/ot/conversations/${room}/management`)
      writes.push(payload)
      if (payload.revision === 0) throw Object.assign(new Error('Changed elsewhere'), {status:409,code:'social/group_management_conflict'})
      if (payload.action === 'leave') return {left:true,conversation_id:room}
      return {conversation:group(payload.title, payload.revision + 1)}
    },
  })
  const call = messengerV1({async call(name) {
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }})
  const endpoint = (workspace,body) => call({method:'POST',path:`/v1/workspaces/${workspace}/social/conversations/${room}/management`,body})
  const renamed = await endpoint(personal,{action:'rename',title:'Release notes',revision:1})
  assert.equal(renamed.status,200)
  assert.equal(renamed.body.conversation.workspace_id,personal)
  assert.equal(renamed.body.conversation.members[0].user_id,'c'.repeat(32))
  assert.equal(renamed.body.conversation.members[0].group_member_id,'social_member')
  assert.equal(renamed.body.conversation.group_management.owner_id,'social_member')
  assert.deepEqual(writes[0],{action:'rename',title:'Release notes',revision:1,direct:true})
  assert.equal((await endpoint(teamWorkspace,{action:'leave',revision:1,direct:true})).status,400)
  assert.deepEqual((await endpoint(teamWorkspace,{action:'leave',revision:1})).body,{left:true,conversation_id:room})
  assert.deepEqual(writes[1],{action:'leave',revision:1,workspace:teamWorkspace})
  assert.equal((await endpoint(personal,{action:'leave',revision:0})).body.error.code,'group_management_conflict')
})

test('the native room reuses its existing projection and a stale read cannot restore an exited group', async () => {
  let conversation = group('Initial title',1)
  let saves = 0, sessions = 0, announcements = 0
  const removed = []
  const rt = {
    state:{rooms:{}},roomOf(id) { return this.state.rooms[id] },
    createSession:async () => `native-${++sessions}`,
    save:async () => { saves++ },
    mobileEndpoint() {}, sendUser() {}, updateRoom() {},
    async deleteRoom(id) { delete this.state.rooms[id]; removed.push(id) },
  }
  const raw = {
    async get(path) {
      assert.equal(path,`/v1/ot/conversations/${room}/announcement`)
      announcements++
      return {announcement:{body:'Existing announcement'}}
    },
    async request(_method,path) {
      if (path.endsWith('/management')) return {left:true,conversation_id:room}
      return conversation
    },
  }
  const client = nativeGroupClient({currentRuntime:() => ({rt})},raw)
  const path = `/v1/ot/conversations/${room}`
  assert.equal((await client.get(path)).native_room_id,'native-1')
  assert.equal((await client.get(path)).native_room_id,'native-1')
  assert.deepEqual([sessions,saves,announcements],[1,1,1])
  const initial = conversation
  conversation = group('Changed title',2)
  await client.get(path)
  assert.equal(rt.roomOf('native-1').name,'Changed title')
  conversation = initial
  await client.get(path)
  assert.equal(rt.roomOf('native-1').name,'Changed title')
  await client.post(`${path}/management`,{action:'leave',revision:2})
  assert.equal((await client.get(path)).native_room_id,undefined)
  assert.deepEqual(removed,['native-1'])
  assert.equal(sessions,1)
})

test('a saved group stays visible in the plugin while the native room projection retries', async () => {
  const conversation = group('New group', 1)
  const other = {...group('Existing group', 1), id: 'otc_other'}
  let sessions = 0
  let writes = 0
  let projectionAvailable = false
  const rt = {
    state:{rooms:{}},roomOf(id) { return this.state.rooms[id] },
    createSession:async () => `native-${++sessions}`,
    async save() {}, mobileEndpoint() {}, sendUser() {}, updateRoom() {}, deleteRoom() {},
  }
  const raw = {
    async get(path) {
      if (path.includes(room) && !projectionAvailable) throw new Error('Announcement unavailable')
      return {announcement:{body:''}}
    },
    async request(method,path) {
      if (method === 'POST') { writes++; return conversation }
      if (path === '/v1/ot/conversations') return {conversations:[conversation, other]}
      return conversation
    },
  }
  const client = nativeGroupClient({currentRuntime:() => ({rt})}, raw)
  const path = '/v1/ot/conversations'
  assert.deepEqual(await client.post(path,{kind:'group',title:conversation.title}), conversation)
  const {conversations} = await client.get(path)
  assert.deepEqual(conversations[0], conversation)
  assert.equal(conversations[1].native_room_id, 'native-1')
  assert.deepEqual(await client.get(`${path}/${room}`), conversation)
  projectionAvailable = true
  assert.equal((await client.get(`${path}/${room}`)).native_room_id, 'native-2')
  assert.equal((await client.get(`${path}/${room}`)).native_room_id, 'native-2')
  assert.deepEqual([writes, sessions], [1, 2])
})

test('sending plain text from the native room uses the same shared group and reply receipt', async () => {
  const conversation = group('Product team', 1)
  const path = `/v1/ot/conversations/${room}`
  const message = {id:'otm_plain_text', body:'你们好', mine:true, created_at:1, revision:1}
  const receipt = {...message, reply_jobs:[{id:'job-shared', status:'queued'}]}
  const rt = {
    state:{rooms:{}}, roomOf(id) { return this.state.rooms[id] },
    async createSession() { return 'native-group-id' },
    async save() {}, mobileEndpoint() {}, updateRoom() {}, deleteRoom() {},
    sendUser() { assert.fail('the projected room should send through its shared conversation') },
  }
  const calls = []
  const raw = {
    async get(target) {
      if (target === path) return conversation
      if (target === path + '/announcement') return {announcement:{body:''}}
      assert.equal(target, path + '/messages?limit=100')
      return {messages:[message]}
    },
    async request(method,target) {
      assert.deepEqual([method,target], ['GET',path])
      return conversation
    },
    async post(target,payload) {
      calls.push({target,payload})
      return receipt
    },
  }
  const host = {
    currentRuntime:() => ({rt}),
    async call(operation,payload) {
      assert.deepEqual([operation,payload], ['agents/groupActivity',{conversation_id:room}])
      return {running:[], speaking:[]}
    },
  }
  const client = nativeGroupClient(host, raw)
  const opened = await client.get(path)
  assert.equal(opened.native_room_id, 'native-group-id')
  assert.equal(await rt.sendUser({sessionId:opened.native_room_id, content:[{type:'text',text:message.body}], requestId:'native-plain-key'}), receipt)
  assert.deepEqual(calls, [{target:path + '/messages', payload:{body:message.body, client_key:'native-plain-key'}}])
  const live = await rt.mobileEndpoint('room-chat',{roomId:opened.native_room_id})
  assert.deepEqual(live.items.map(item => ({id:item.source_message_id,text:item.text})), [{id:message.id,text:message.body}])
})
