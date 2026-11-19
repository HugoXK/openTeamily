import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { archivedDirectoryQuery, canSeeArchived } from '../openteamily/static/agents/app.mjs';

test('canSeeArchived limits the archived view to owners and admins', () => {
  assert.equal(canSeeArchived('owner'), true);
  assert.equal(canSeeArchived('admin'), true);
  assert.equal(canSeeArchived('member'), false);
  assert.equal(canSeeArchived(''), false);
});

test('archivedDirectoryQuery asks the server for archived rows only when asked', () => {
  assert.equal(archivedDirectoryQuery(false), '/agents?limit=100');
  assert.equal(archivedDirectoryQuery(true), '/agents?limit=100&include_archived=1');
});

test('the directory offers a show-archived switch next to the filters', () => {
  const html = readFileSync(new URL('../openteamily/static/agents/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="show-archived"/, 'the directory has no way to show archived agents');
  assert.match(html, /for="show-archived"/, 'the switch needs a label');
});
