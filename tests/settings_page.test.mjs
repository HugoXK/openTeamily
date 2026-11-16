import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, diff, readForm } from '../openteamily/static/settings/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('diff emits only changed settings keys', () => {
  const current = {appearance: 'system', appearance_schedule: 'sunset_sunrise',
                   appearance_start: '18:00', appearance_end: '07:00',
                   language: 'zh-CN', chat_language: 'auto', auto_translate: false,
                   send_shortcut: 'enter', message_folding: 'standard', document_cards: false,
                   link_previews: true, task_completion_reminders: true,
                   likes_visibility: 'everyone', favorites_visibility: 'everyone'};
  assert.deepEqual(diff(current, current), {});
  assert.deepEqual(diff(current, {...current, appearance: 'dark', document_cards: true}),
                   {appearance: 'dark', document_cards: true});
});

test('readForm maps radios, select and checkboxes', () => {
  const form = {
    appearance: 'light', appearance_schedule: 'custom', appearance_start: '21:00',
    appearance_end: '06:00', language: 'en', chat_language: 'ja',
    send_shortcut: 'mod_enter', message_folding: 'compact',
    likes_visibility: 'private', favorites_visibility: 'everyone',
  };
  const fake = {
    get(name) { return form[name]; },
    has(name) { return name === 'document_cards' || name === 'link_previews'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readForm({}), {
      appearance: 'light', appearance_schedule: 'custom', appearance_start: '21:00',
      appearance_end: '06:00', language: 'en', chat_language: 'ja', auto_translate: false,
      send_shortcut: 'mod_enter', message_folding: 'compact', document_cards: true,
      link_previews: true, task_completion_reminders: false,
      likes_visibility: 'private', favorites_visibility: 'everyone',
    });
  } finally {
    globalThis.FormData = original;
  }
});
