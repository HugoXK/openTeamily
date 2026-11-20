import assert from 'node:assert/strict';
import test from 'node:test';
import { envelope, install, movedTarget, servedByDsBot, toResponse } from '../openteamily/static/shell/dsbot-api.mjs';

const ORIGIN = 'https://openteamily.example';
const WS = 'a'.repeat(32);
const ID = 'b'.repeat(32);

test('moved meeting routes go to the meetings feature of the user\'s own DS-Bot', () => {
  assert.deepEqual(movedTarget(`/v1/workspaces/${WS}/meetings?limit=20`, ORIGIN),
    { feature: 'meetings', path: `/v1/workspaces/${WS}/meetings?limit=20` });
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/export`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory?q=x`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/versions/3/restore`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/dream/${ID}`, ORIGIN).feature, 'memory');
  for (const rest of ['actions', `actions/${ID}/remove`, 'links', 'graph', 'profile', `preferences/${ID}/remove`]) {
    assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${rest}`, ORIGIN).feature, 'memory', rest);
  }
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/bogus`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/messages?q=x`, ORIGIN).feature, 'search');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/resources?kind=links`, ORIGIN).feature, 'search');
  assert.equal(movedTarget('/v1/auth/session', ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations`, ORIGIN), null);
  assert.equal(movedTarget(`https://evil.example/v1/workspaces/${WS}/meetings`, ORIGIN), null);
});

test('the envelope carries method, path, body and idempotency key only', () => {
  const env = envelope({ feature: 'meetings', path: '/v1/x' }, 'post', { 'Idempotency-Key': 'k'.repeat(20), 'X-CSRF-Token': 't' }, '{"title":"周会"}');
  assert.deepEqual(env, { endpoint: 'meetings/v1', payload: { method: 'POST', path: '/v1/x', idempotency_key: 'k'.repeat(20), body: { title: '周会' } } });
});

test('answers become ordinary responses, downloads keep their name', async () => {
  const json = toResponse({ status: 409, body: { error: { code: 'conflict' } } });
  assert.equal(json.status, 409);
  assert.equal((await json.json()).error.code, 'conflict');
  const file = toResponse({ status: 200, download: { content_type: 'text/markdown', filename: 'm.md', data: Buffer.from('# hi').toString('base64') } });
  assert.equal(await file.text(), '# hi');
  assert.match(file.headers.get('Content-Disposition'), /m\.md/);
});

test('does nothing on pages served by the legacy platform', () => {
  const doc = { querySelector: () => null, addEventListener() { throw new Error('must not install'); } };
  assert.equal(servedByDsBot(doc), false);
  assert.equal(install({ document: doc, location: { origin: ORIGIN }, fetch() { throw new Error('no'); } }), null);
});
