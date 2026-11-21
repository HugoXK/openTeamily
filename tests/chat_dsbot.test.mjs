import assert from 'node:assert/strict';
import test from 'node:test';
import { dsbotServed } from '../openteamily/static/chat/dsbot.mjs';
import { envelope, movedTarget } from '../openteamily/static/shell/dsbot-api.mjs';

test('private chat identifies the account DS-Bot and shares the agents transport', () => {
  assert.equal(dsbotServed({querySelector: () => null}), false);
  assert.equal(dsbotServed({querySelector: () => ({})}), true);
  const origin = 'https://openteamily.example';
  const base = `/v1/workspaces/${'a'.repeat(32)}/agents/${'b'.repeat(32)}/conversations`;
  const privateChat = `${base}/${'c'.repeat(32)}`;
  for (const path of [base, privateChat, `${privateChat}/messages`]) {
    assert.deepEqual(movedTarget(path, origin), {feature: 'agents', path});
  }
  const path = `${privateChat}/messages`;
  const body = {body: 'hello'};
  const wrapped = envelope(movedTarget(path, origin), 'POST', {'Idempotency-Key':'retry-one-message'}, body);
  assert.deepEqual(wrapped, {
    endpoint: 'agents/v1',
    payload: {method:'POST', path, idempotency_key:'retry-one-message', body},
  });
});

test('native Chat starts scoped reads without the browser transport or optional modules', async () => {
  const original = globalThis.window;
  const calls = [];
  const document = {querySelector: selector => selector === 'meta[name="openteamily-instance"]' ? {} : null};
  const workspace = 'a'.repeat(32), agent = 'b'.repeat(32), conversation = 'c'.repeat(32);
  const hash = `#workspace=${workspace}&agent=${agent}&conversation=${conversation}`;
  const location = {hash, href: 'https://openteamily.example/chat' + hash};
  globalThis.window = {document, location, fetch: async (path, init) => {
    calls.push({path, init});
    return Response.json({items: []});
  }};
  document.defaultView = globalThis.window;
  try {
    const {takeChatReads} = await import('../openteamily/static/chat/startup.mjs?test-direct-early-read');
    assert.equal(calls[0].path, '/v1/auth/session');
    const [first, second] = calls;
    assert.equal(calls.length, 2);
    assert.equal(first.init.credentials, 'same-origin');
    const {pathname, searchParams} = new URL(second.path, location.href);
    assert.equal(pathname, '/v1/workspaces');
    assert.deepEqual(Object.fromEntries(searchParams), {
      scope: 'personal', include: 'chat', workspace, entry_agent: agent, entry_conversation: conversation, directory: '0',
    });
    assert.equal(second.init.credentials, 'same-origin');
    assert.ok(second.init.signal instanceof AbortSignal);
    const early = takeChatReads(document);
    assert.equal((await early.localRequest).status, 200);
    assert.equal(takeChatReads(document), null);

    calls.length = 0;
    location.hash = '#public-agent=fixture-agent';
    location.href = 'https://openteamily.example/chat' + location.hash;
    const publicPage = await import('../openteamily/static/chat/startup.mjs?test-public-early-read');
    assert.deepEqual(calls.map(entry => entry.path), ['/v1/auth/session']);
    assert.equal(publicPage.takeChatReads(document).localRequest, null);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
