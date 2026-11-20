import assert from 'node:assert/strict';
import test from 'node:test';
import { dsbotRoute, dsbotRequest, dsbotServed, PLUGIN_API } from '../openteamily/static/chat/dsbot.mjs';

const agent = 'a'.repeat(32);
const base = `/v1/workspaces/${'w'.repeat(32)}/agents/${agent}`;

test('only the personal agent private chat is routed to the DS-Bot plugin', () => {
  assert.deepEqual(dsbotRoute('GET', `${base}/conversations?limit=100`, undefined, agent).endpoint, 'chat/conversations');
  assert.equal(dsbotRoute('POST', `${base}/conversations`, {title: 't'}, agent).endpoint, 'chat/create');
  assert.deepEqual(dsbotRoute('POST', `${base}/conversations/c1/messages`, {body: 'hi'}, agent).payload, {conversation_id: 'c1', text: 'hi'});
  assert.equal(dsbotRoute('GET', `${base}/conversations/c1`, undefined, agent).endpoint, 'chat/messages');
  assert.equal(dsbotRoute('POST', `${base}/conversations/c1/read`, {}, agent).shape, 'read');
  assert.equal(dsbotRoute('GET', `${base}/conversations`, undefined, 'b'.repeat(32)), null);
  assert.equal(dsbotRoute('GET', `${base}/conversations`, undefined, ''), null);
  assert.equal(dsbotRoute('POST', `${base}/conversations/c1/messages/m1/artifact`, {}, agent), null);
  assert.equal(dsbotServed({querySelector: () => null}), false);
  assert.equal(dsbotServed({querySelector: () => ({})}), true);
});

test('plugin responses are shaped like the legacy API', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    const {endpoint} = JSON.parse(init.body);
    const value = endpoint === 'chat/conversations' ? {items: [{id: 'c1', title: 'T', created: 1, updated: 2}]}
      : endpoint === 'chat/messages' ? {items: [{id: 'm1', role: 'assistant', text: 'hello', created: 3, meta: {memory_refs: [{id: 'p'}]}}]}
      : {reply: {id: 'r1'}};
    return {status: 200, json: async () => ({ok: true, value})};
  };
  const open = await dsbotRequest(fetcher, dsbotRoute('GET', `${base}/conversations/c1`, undefined, agent), agent, {});
  assert.equal(open.status, 200);
  assert.equal(open.body.conversation.id, 'c1');
  assert.deepEqual(open.body.items[0].body, 'hello');
  assert.equal(open.body.items[0].status, 'succeeded');
  const sent = await dsbotRequest(fetcher, dsbotRoute('POST', `${base}/conversations/c1/messages`, {body: 'x'}, agent), agent, {});
  assert.equal(sent.status, 201);
  assert.equal(calls[0][0], PLUGIN_API);
  const failing = async () => ({status: 200, json: async () => ({ok: false, error: {code: 'chat/runtime-unavailable', message: 'no'}})});
  const failed = await dsbotRequest(failing, dsbotRoute('GET', `${base}/conversations`, undefined, agent), agent, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'chat/runtime-unavailable');
});

test('first list imports the user\'s own legacy history into their DS-Bot once', async () => {
  const c1 = 'c'.repeat(32);
  const plugin = [];
  let done = false;
  const legacy = [];
  const fetcher = async (url, init) => {
    if (url === PLUGIN_API) {
      const {endpoint, payload} = JSON.parse(init.body);
      plugin.push(endpoint);
      if (endpoint === 'chat/importStatus') return {status: 200, json: async () => ({ok: true, value: {done}})};
      if (endpoint === 'chat/import') {
        if (payload.finish) done = true;
        else assert.deepEqual(payload.conversations[0].messages.map(m => m.id), ['m1', 'm2']);
        return {status: 200, json: async () => ({ok: true, value: {conversations: payload.conversations.length, messages: 2}})};
      }
      return {status: 200, json: async () => ({ok: true, value: {items: []}})};
    }
    legacy.push(url);
    if (url.includes('/messages')) {
      return {status: 200, json: async () => ({items: [
        {id: 'm1', role: 'user', body: 'hi', status: 'succeeded', created: 1},
        {id: 'm2', role: 'assistant', body: 'hello', status: 'succeeded', created: 2},
        {id: 'm3', role: 'assistant', body: '', status: 'failed', created: 3}], cursor: null})};
    }
    return {status: 200, json: async () => ({items: [{id: c1, title: 'Old'}], cursor: null})};
  };
  const route = dsbotRoute('GET', `${base}/conversations?limit=100`, undefined, agent);
  await dsbotRequest(fetcher, route, agent, {});
  assert.deepEqual(legacy, [`${base}/conversations?limit=100`, `${base}/conversations/${c1}/messages?limit=200`]);
  assert.deepEqual(plugin, ['chat/importStatus', 'chat/import', 'chat/import', 'chat/conversations']);
  legacy.length = 0;
  await dsbotRequest(fetcher, route, agent, {});
  assert.deepEqual(legacy, [], 'no second import');
});
