import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHandle, parseTags } from '../openteamily/static/profile/app.mjs';

test('sanitizeHandle derives a lowercase dotted handle', () => {
  assert.equal(sanitizeHandle('Alice'), 'alice');
  assert.equal(sanitizeHandle('Alice Smith'), 'alice.smith');
  assert.equal(sanitizeHandle('a'), 'auser');
  assert.equal(sanitizeHandle('...'), 'user');
  assert.equal(sanitizeHandle('A..B'), 'a.b');
  assert.equal(sanitizeHandle('x'.repeat(40)).length, 30);
  assert.equal(sanitizeHandle(''), 'user');
});

test('parseTags splits, dedupes and bounds tags', () => {
  assert.deepEqual(parseTags('产品, 旅行，产品'), ['产品', '旅行']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags('t1,t2,t3,t4,t5,t6,t7,t8,t9').length, 8);
  assert.equal(parseTags('x'.repeat(30))[0].length, 20);
});
