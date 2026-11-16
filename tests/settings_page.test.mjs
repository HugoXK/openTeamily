import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, describeAppearance, diff, readForm } from '../openteamily/static/settings/app.mjs';

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
                   likes_visible: true, favorites_visible: true};
  assert.deepEqual(diff(current, current), {});
  assert.deepEqual(diff(current, {...current, appearance: 'dark', document_cards: true}),
                   {appearance: 'dark', document_cards: true});
});

test('readForm maps radios, select and checkboxes', () => {
  const form = {
    appearance: 'light', appearance_schedule: 'custom', appearance_start: '21:00',
    appearance_end: '06:00', language: 'en', chat_language: 'ja',
    send_shortcut: 'mod_enter', message_folding: 'compact',
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
      likes_visible: false, favorites_visible: false,
    });
  } finally {
    globalThis.FormData = original;
  }
});

test('describeAppearance states the resolved look without inventing sunrise times', () => {
  assert.equal(describeAppearance({appearance: 'light'}), '当前为浅色。');
  assert.equal(describeAppearance({appearance: 'dark'}), '当前为深色。');
  assert.match(describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}),
               /按系统浅色或深色偏好估算/);
  assert.doesNotMatch(describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}),
                      /直到|\d{1,2}:\d{2}/);
  assert.match(describeAppearance({appearance: 'system'}), /跟随系统/);
});
