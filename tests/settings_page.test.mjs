import assert from 'node:assert/strict';
import test from 'node:test';
import { applySettingsView, csrfCookie, describeAppearance, diff, newlineBinding, privacyChanges, readForm, settingsViewFromLocation, syncAppearanceExtras, syncMcpDialog, syncPrivacySaveButton, syncShortcutRows } from '../openteamily/static/settings/app.mjs';

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

test('settingsViewFromLocation maps recorded paths and leftover hashes', () => {
  assert.equal(settingsViewFromLocation('/settings', ''), 'hub');
  assert.equal(settingsViewFromLocation('/settings/', ''), 'hub');
  assert.equal(settingsViewFromLocation('/settings/appearance', ''), 'appearance');
  assert.equal(settingsViewFromLocation('/settings/language', ''), 'language');
  assert.equal(settingsViewFromLocation('/settings/message-folding', ''), 'message-folding');
  assert.equal(settingsViewFromLocation('/settings/privacy', ''), 'privacy');
  assert.equal(settingsViewFromLocation('/settings/shortcuts', ''), 'shortcuts');
  assert.equal(settingsViewFromLocation('/settings/channels', ''), 'channels');
  assert.equal(settingsViewFromLocation('/settings/agent-access', ''), 'agent-access');
  assert.equal(settingsViewFromLocation('/settings/connectors', ''), 'connectors');
  assert.equal(settingsViewFromLocation('/settings', '#appearance'), 'appearance');
  assert.equal(settingsViewFromLocation('/settings', '#language-section'), 'language');
  assert.equal(settingsViewFromLocation('/settings', '#send-shortcut'), 'shortcuts');
  assert.equal(settingsViewFromLocation('/settings', '#message-display'), 'message-folding');
  assert.equal(settingsViewFromLocation('/settings', '#model-api'), 'model-api');
});

test('applySettingsView shows one recorded page at a time', () => {
  const hub = {hidden: false};
  const appearance = {hidden: true, getAttribute: () => 'appearance'};
  const language = {hidden: true, getAttribute: () => 'language'};
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-settings-hub]') return [hub];
      if (selector === '[data-settings-page]') return [appearance, language];
      return [];
    },
  };
  applySettingsView(document, 'appearance');
  assert.equal(hub.hidden, true);
  assert.equal(appearance.hidden, false);
  assert.equal(language.hidden, true);
  applySettingsView(document, 'hub');
  assert.equal(hub.hidden, false);
  assert.equal(appearance.hidden, true);
  assert.equal(language.hidden, true);
});

test('syncAppearanceExtras hides schedule controls until auto is selected', () => {
  const scheduleCard = {hidden: false};
  const customFields = {hidden: false};
  const zone = {textContent: ''};
  const document = {
    getElementById(id) {
      if (id === 'appearance-schedule-card') return scheduleCard;
      if (id === 'custom-period-fields') return customFields;
      if (id === 'appearance-time-zone') return zone;
      return null;
    },
  };
  syncAppearanceExtras(document, {appearance: 'light', appearance_schedule: 'custom'});
  assert.equal(scheduleCard.hidden, true);
  assert.equal(customFields.hidden, true);
  syncAppearanceExtras(document, {appearance: 'auto', appearance_schedule: 'sunset_sunrise'});
  assert.equal(scheduleCard.hidden, false);
  assert.equal(customFields.hidden, true);
  syncAppearanceExtras(document, {appearance: 'auto', appearance_schedule: 'custom'});
  assert.equal(scheduleCard.hidden, false);
  assert.equal(customFields.hidden, false);
});

test('newlineBinding complements the recorded send shortcut', () => {
  assert.equal(newlineBinding('enter'), 'Shift+Enter');
  assert.equal(newlineBinding('mod_enter'), 'Enter');
  assert.equal(newlineBinding(undefined), 'Shift+Enter');
});

test('syncShortcutRows renders complementary key chips', () => {
  const children = [];
  const keys = {
    replaceChildren() { children.length = 0; },
    appendChild(node) { children.push(node); return node; },
  };
  const document = {
    getElementById(id) { return id === 'newline-keys' ? keys : null; },
    createElement(tag) { return {tagName: tag, className: '', textContent: ''}; },
  };
  syncShortcutRows(document, {send_shortcut: 'enter'});
  assert.deepEqual(children.filter((node) => node.tagName === 'kbd').map((node) => node.textContent), ['Shift', 'Enter']);
  syncShortcutRows(document, {send_shortcut: 'mod_enter'});
  assert.deepEqual(children.filter((node) => node.tagName === 'kbd').map((node) => node.textContent), ['Enter']);
});

test('syncPrivacySaveButton stays disabled until a privacy value changes', () => {
  const button = {disabled: false};
  const document = { getElementById(id) { return id === 'save' ? button : null; } };
  const current = {likes_visible: true, favorites_visible: true};
  syncPrivacySaveButton(document, current, current);
  assert.equal(button.disabled, true);
  syncPrivacySaveButton(document, current, {...current, likes_visible: false});
  assert.equal(button.disabled, false);
  assert.deepEqual(privacyChanges(current, {...current, favorites_visible: false}), {favorites_visible: false});
  assert.deepEqual(privacyChanges(current, current), {});
});

test('syncMcpDialog opens and closes the recorded instruction dialog', () => {
  const dialog = {hidden: true};
  const trigger = {attrs: {'aria-expanded': 'false'}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; }};
  const ack = {focus() { this.focused = true; }};
  const document = {
    getElementById(id) {
      if (id === 'mcp-dialog') return dialog;
      if (id === 'add-mcp-server') return trigger;
      if (id === 'mcp-dialog-ack') return ack;
      return null;
    },
  };
  syncMcpDialog(document, true);
  assert.equal(dialog.hidden, false);
  assert.equal(trigger.attrs['aria-expanded'], 'true');
  assert.equal(ack.focused, true);
  syncMcpDialog(document, false);
  assert.equal(dialog.hidden, true);
  assert.equal(trigger.attrs['aria-expanded'], 'false');
  assert.equal(trigger.focused, true);
});

test('applySettingsView closes the MCP dialog when leaving connectors', () => {
  const dialog = {hidden: false};
  const trigger = {attrs: {'aria-expanded': 'true'}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; }};
  const nodes = [];
  const document = {
    querySelectorAll() { return nodes; },
    getElementById(id) {
      if (id === 'mcp-dialog') return dialog;
      if (id === 'add-mcp-server') return trigger;
      return null;
    },
  };
  applySettingsView(document, 'hub');
  assert.equal(dialog.hidden, true);
  assert.equal(trigger.attrs['aria-expanded'], 'false');
});
