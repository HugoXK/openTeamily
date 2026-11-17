import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, listQuery, visibleArtifacts } from '../openteamily/static/artifacts/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
});

test('visibleArtifacts filters by kind, saved messages and creator', () => {
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice'},
    {title: 'Site', kind: 'website', created_by: 'bob'},
    {title: 'Clip', kind: 'document', created_by: 'alice', source: {kind: 'agent_message', id: 'm1'}},
  ];
  assert.deepEqual(visibleArtifacts(items, {kind: 'website'}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'messages'}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'meetings'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'mine', username: 'alice'}).map((item) => item.title), ['Doc', 'Clip']);
});
