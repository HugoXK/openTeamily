import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyConnectorSearch, applySettingsView, CONNECTOR_CATALOG, csrfCookie, describeAppearance, diff, filterConnectorCatalog, newlineBinding, privacyChanges, readForm, settingsViewFromLocation, syncAppearanceExtras, syncMcpDialog, syncPrivacySaveButton, syncShortcutRows } from '../openteamily/static/settings/app.mjs';

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

test('describeAppearance names the current look and next switch without inventing sunrise times', () => {
  assert.equal(describeAppearance({appearance: 'light'}), '当前为浅色。');
  assert.equal(describeAppearance({appearance: 'dark'}), '当前为深色。');
  const afternoon = new Date(2026, 10, 18, 15, 0, 0);
  const night = new Date(2026, 10, 18, 23, 0, 0);
  assert.equal(
    describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, afternoon),
    '当前为浅色，直到 22:00。',
  );
  assert.equal(
    describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, night),
    '当前为深色，直到 06:00。',
  );
  assert.equal(
    describeAppearance({
      appearance: 'auto', appearance_schedule: 'custom',
      appearance_start: '18:00', appearance_end: '07:00',
    }, afternoon),
    '当前为浅色，直到 18:00。',
  );
  assert.equal(
    describeAppearance({
      appearance: 'auto', appearance_schedule: 'custom',
      appearance_start: '18:00', appearance_end: '07:00',
    }, new Date(2026, 10, 18, 20, 0, 0)),
    '当前为深色，直到 07:00。',
  );
  const auto = describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, afternoon);
  assert.doesNotMatch(auto, /日落|日出/);
  assert.doesNotMatch(auto, /按系统浅色或深色偏好估算/);
  assert.doesNotMatch(auto, /拿不到你所在的位置/);
  assert.match(describeAppearance({appearance: 'system'}, afternoon, {matches: false}), /当前为浅色（跟随系统）。/);
  assert.match(describeAppearance({appearance: 'system'}, afternoon, {matches: true}), /当前为深色（跟随系统）。/);
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


const SETTINGS_FRONTEND = [
  new URL('../openteamily/static/settings/index.html', import.meta.url),
  new URL('../openteamily/static/settings/app.mjs', import.meta.url),
  new URL('../openteamily/static/settings/app.css', import.meta.url),
  new URL('../docs/SETTINGS.md', import.meta.url),
];

const SECRET_MARKERS = [
  'Ov23liin4waZGLSJJgn5',
  'DS_BOT_GITHUB_OAUTH_CLIENT_ID',
  'githubcopilot.com',
  'mcp.notion.com',
  'mcp.linear.app',
  'mcp.atlassian.com',
  'mcp.sentry.dev',
  'mcp.stripe.com',
  'mcp.paypal.com',
  'mcp.squareup.com',
  'bindings.mcp.cloudflare.com',
  'mcp.vercel.com',
  'mcp.supabase.com',
  'mcp.neon.tech',
  'mcp.figma.com',
  'mcp.canva.com',
  'mcp.intercom.com',
  'mcp.monday.com',
  'mcp.webflow.com',
  'mcp.wix.com',
  'netlify-mcp.netlify.app',
  'mcp.airtable.com',
  'mcp.dropbox.com',
  'mcp.zapier.com',
  'mcp.clickup.com',
  'ai.todoist.net',
  'mcp.miro.com',
  'mcp.attio.com',
  'mcp.postman.com',
  'mcp.asana.com',
  'mcp.box.com',
  'mcp.hubspot.com',
  'mcp.slack.com',
  'huggingface.co/mcp',
  'mcp.exa.ai',
  'mcp.deepwiki.com',
  'mcp.context7.com',
  'learn.microsoft.com/api/mcp',
  'docs.mcp.cloudflare.com',
  'mcp.amap.com',
  'api.github.com/user',
  'X-MCP-Toolsets',
  'lbs.amap.com',
  'GITHUB_TOKEN',
];

test('CONNECTOR_CATALOG is the 39 public DS-Bot entries', () => {
  assert.equal(CONNECTOR_CATALOG.length, 39);
  assert.deepEqual(CONNECTOR_CATALOG.map((item) => item.id), [
    'github', 'notion', 'linear', 'atlassian', 'sentry', 'stripe', 'paypal', 'square',
    'cloudflare', 'vercel', 'supabase', 'neon', 'figma', 'canva', 'intercom', 'monday',
    'webflow', 'wix', 'netlify', 'airtable', 'dropbox', 'zapier', 'clickup', 'todoist',
    'miro', 'attio', 'postman', 'asana', 'box', 'hubspot', 'slack', 'huggingface', 'exa',
    'deepwiki', 'context7', 'mslearn', 'cloudflare-docs', 'amap', 'mail',
  ]);
  for (const item of CONNECTOR_CATALOG) {
    assert.deepEqual(Object.keys(item).sort(), ['about', 'category', 'id', 'name']);
    assert.equal(typeof item.about, 'string');
    assert.ok(item.about.length > 0);
  }
});

test('filterConnectorCatalog matches name, about, or id and is empty when nothing matches', () => {
  assert.equal(filterConnectorCatalog('').length, 39);
  assert.equal(filterConnectorCatalog('   ').length, 39);
  const github = filterConnectorCatalog('GitHub');
  assert.deepEqual(github.map((item) => item.id), ['github']);
  const byAbout = filterConnectorCatalog('pull requests');
  assert.deepEqual(byAbout.map((item) => item.id), ['github']);
  const byId = filterConnectorCatalog('cloudflare-docs');
  assert.deepEqual(byId.map((item) => item.id), ['cloudflare-docs']);
  const payments = filterConnectorCatalog('payments');
  assert.deepEqual(payments.map((item) => item.id), ['stripe', 'paypal', 'square']);
  assert.deepEqual(filterConnectorCatalog('no-such-connector-xyz'), []);
});

test('applyConnectorSearch hides unmatched rows and shows the empty state', () => {
  const rows = CONNECTOR_CATALOG.map((item) => ({
    id: item.id,
    hidden: false,
    getAttribute(name) { return name === 'data-connector-id' ? this.id : null; },
  }));
  const empty = {hidden: true};
  const document = {
    getElementById(id) {
      if (id === 'connectors-catalog') {
        return {querySelectorAll() { return rows; }};
      }
      if (id === 'connectors-empty') return empty;
      return null;
    },
  };
  const visible = applyConnectorSearch(document, 'mailbox');
  assert.deepEqual(visible.map((item) => item.id), ['mail']);
  assert.equal(rows.find((row) => row.id === 'mail').hidden, false);
  assert.equal(rows.filter((row) => !row.hidden).length, 1);
  assert.equal(empty.hidden, true);
  applyConnectorSearch(document, 'no-such-connector-xyz');
  assert.equal(rows.every((row) => row.hidden), true);
  assert.equal(empty.hidden, false);
  applyConnectorSearch(document, '');
  assert.equal(rows.every((row) => !row.hidden), true);
  assert.equal(empty.hidden, true);
});

test('settings connectors markup lists the catalog as disconnected without leaking secrets', () => {
  const html = readFileSync(fileURLToPath(new URL('../openteamily/static/settings/index.html', import.meta.url)), 'utf8');
  const ids = [...html.matchAll(/data-connector-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, CONNECTOR_CATALOG.map((item) => item.id));
  assert.equal((html.match(/class="connector-row"/g) || []).length, 39);
  assert.equal((html.match(/<span class="connector-status">未连接<\/span>/g) || []).length, 39);
  assert.equal((html.match(/不会真连。">\+ 连接<\/button>/g) || []).length, 39);
  assert.equal((html.match(/disabled title="未实现：还没有连接器后端或账号授权接口，不会真连。"/g) || []).length, 39);
  assert.match(html, /class="connector-search-icon"/);
  assert.match(html, /id="connectors-empty"[^>]*hidden[^>]*>没有匹配的应用。/);
  assert.doesNotMatch(html, /还没有可连接的应用目录/);
  assert.doesNotMatch(html, /已连接/);
  for (const item of CONNECTOR_CATALOG) {
    assert.ok(html.includes(`>${item.name}<`), item.name);
    assert.ok(html.includes(item.about), item.id);
  }
  const sources = SETTINGS_FRONTEND.map((url) => readFileSync(fileURLToPath(url), 'utf8')).join('\n');
  for (const marker of SECRET_MARKERS) {
    assert.equal(sources.includes(marker), false, marker);
  }
});
