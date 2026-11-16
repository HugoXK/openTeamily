import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, listQuery } from '../openteamily/static/artifacts/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
});
