import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, diff, readForm } from '../openteamily/static/settings/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('diff emits only changed settings keys', () => {
  const current = {appearance: 'system', language: 'zh-CN', send_shortcut: 'enter',
                   fold_long_messages: true, document_cards: true};
  assert.deepEqual(diff(current, current), {});
  assert.deepEqual(diff(current, {...current, appearance: 'dark', document_cards: false}),
                   {appearance: 'dark', document_cards: false});
});

test('readForm maps radios, select and checkboxes', () => {
  const form = {
    appearance: 'light',
    language: 'en',
    send_shortcut: 'mod_enter',
  };
  const fake = {
    get(name) { return form[name]; },
    has(name) { return name === 'document_cards'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readForm({}), {
      appearance: 'light', language: 'en', send_shortcut: 'mod_enter',
      fold_long_messages: false, document_cards: true,
    });
  } finally {
    globalThis.FormData = original;
  }
});
