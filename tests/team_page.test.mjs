import assert from 'node:assert/strict';
import test from 'node:test';
import { readWizard, step1Ready, validName, validSlug } from '../openteamily/static/team/app.mjs';

test('validName and validSlug match the contrast rules', () => {
  assert.equal(validName('团队'), true);
  assert.equal(validName('x' * 61), false);
  assert.equal(validSlug('desk-team'), true);
  assert.equal(validSlug('ab'), false);
  assert.equal(validSlug('-desk'), false);
  assert.equal(validSlug('desk-'), false);
});

test('readWizard omits workspace_id unless converting', () => {
  const values = {name: ' Desk ', slug: 'desk-team', mode: 'new', workspace_id: 'abc'};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readWizard({}), {name: 'Desk', slug: 'desk-team', mode: 'new', workspace_id: undefined});
    values.mode = 'convert';
    assert.deepEqual(readWizard({}), {name: 'Desk', slug: 'desk-team', mode: 'convert', workspace_id: 'abc'});
  } finally {
    globalThis.FormData = original;
  }
});

test('step1Ready requires both a valid name and a valid Team ID', () => {
  assert.equal(step1Ready({name: '', slug: ''}), false);
  assert.equal(step1Ready({name: 'Desk', slug: ''}), false);
  assert.equal(step1Ready({name: '', slug: 'desk-team'}), false);
  assert.equal(step1Ready({name: 'Desk', slug: 'ab'}), false);
  assert.equal(step1Ready({name: 'Desk', slug: 'desk-team'}), true);
});
