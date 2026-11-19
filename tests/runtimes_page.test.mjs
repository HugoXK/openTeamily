import assert from 'node:assert/strict';
import test from 'node:test';
import { canIssueKey, installCommands, listItemHasSecret, readKeyForm, summarizeConnections } from '../openteamily/static/runtimes/app.mjs';
import * as runtimesApp from '../openteamily/static/runtimes/app.mjs';

test('readKeyForm omits expiry when never is selected', () => {
  const values = {name: ' Laptop ', expires: 'never'};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readKeyForm({}), {name: 'Laptop'});
    values.expires = 'd7';
    assert.deepEqual(readKeyForm({}), {name: 'Laptop', expires_in: 604800});
  } finally {
    globalThis.FormData = original;
  }
});

test('canIssueKey enables generate only when a name is present', () => {
  assert.equal(canIssueKey(''), false);
  assert.equal(canIssueKey('   '), false);
  assert.equal(canIssueKey('MacBook CLI'), true);
});

test('install commands use the current origin and FlyBot names', () => {
  const commands = installCommands('https://management.test/');
  assert.match(commands.unix, /install\/flybot\.pyz/);
  assert.equal(commands.daemon, 'python3 flybot.pyz daemon start --origin https://management.test --key-file ./runtime-key');
  assert.equal(commands.unix.includes('teamily.com'), false);
  assert.equal(commands.unix.includes('curl -fsSL'), false);
  assert.equal(listItemHasSecret({name: 'x', prefix: 'abcd1234'}), false);
  assert.equal(listItemHasSecret({name: 'x', prefix: 'abcd1234', token: 'secret'}), true);
});

test('summarizeConnections reports empty, offline, and online local status', () => {
  assert.deepEqual(summarizeConnections(), {kind: 'empty', label: '尚未连接本机或远程设备', items: [], preview: []});
  const offline = [{hostname: 'desk', status: 'offline'}];
  assert.equal(summarizeConnections(offline).kind, 'offline');
  assert.equal(summarizeConnections(offline).label, '离线');
  const mixed = [{hostname: 'old', status: 'offline'}, {hostname: 'desk', status: 'online'}];
  const summary = summarizeConnections(mixed);
  assert.equal(summary.kind, 'online');
  assert.equal(summary.label, '在线');
  assert.deepEqual(summary.preview, [{hostname: 'desk', status: 'online'}]);
});

test('lastSeenText turns an epoch second into 刚刚, minutes, hours, and days', () => {
  assert.equal(typeof runtimesApp.lastSeenText, 'function', 'the page exposes lastSeenText as a pure function');
  const now = 1763524800;
  assert.equal(runtimesApp.lastSeenText(now - 30, now), '刚刚');
  assert.equal(runtimesApp.lastSeenText(now - 59, now), '刚刚');
  assert.equal(runtimesApp.lastSeenText(now - 45 * 60, now), '45 分钟前');
  assert.equal(runtimesApp.lastSeenText(now - 3 * 3600, now), '3 小时前');
  assert.equal(runtimesApp.lastSeenText(now - 3 * 86400, now), '3 天前');
  assert.equal(runtimesApp.lastSeenText(undefined, now), '未知');
});

test('connectionText says how long ago a machine was last seen, per server status', () => {
  assert.equal(typeof runtimesApp.connectionText, 'function', 'the page exposes connectionText as a pure function');
  const now = 1763524800;
  assert.equal(runtimesApp.connectionText({status: 'offline', last_seen: now - 45 * 60}, now), '最后在线 45 分钟前');
  assert.equal(runtimesApp.connectionText({status: 'online', last_seen: now - 3 * 3600}, now), '已连接（最后活跃 3 小时前）');
  assert.equal(runtimesApp.connectionText({status: 'online', last_seen: now - 30}, now), '已连接（刚刚有活动）');
  assert.equal(runtimesApp.connectionText({status: 'offline', last_seen: now - 30}, now), '刚刚离线');
  assert.equal(runtimesApp.connectionText({status: 'online'}, now), '已连接（最后活跃时间未知）');
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
    this.className = '';
    this.type = '';
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.children.length = 0; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) { this.children.push(child); return child; }
  reset() {}
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id.endsWith('-form') ? 'form' : 'div'));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return new FakeElement(); },
    createElement(tag) { return new FakeElement(tag); },
  };
  return {doc, elements};
}

function textOf(node) {
  return [node.textContent || ''].concat(node.children.map(textOf)).join(' ');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function mountWithConnections(items, tag) {
  const {doc} = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/runtime-keys') return {status: 200, json: async () => ({device_id: 'desk', items: []})};
    if (path === '/v1/runtime/connections') return {status: 200, json: async () => ({items})};
    throw new Error('unexpected ' + path);
  };
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  await import('../openteamily/static/runtimes/app.mjs?last_seen=' + tag);
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
  return {
    doc,
    restore() {
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
      if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    },
  };
}

test('runtime cards show how long ago each machine was last seen', async () => {
  const now = nowSeconds();
  const items = [
    {hostname: 'desk', status: 'offline', last_seen: now - 45 * 60},
    {hostname: 'lap', status: 'online', last_seen: now - 3 * 3600},
  ];
  const {doc, restore} = await mountWithConnections(items, 'cards-' + Math.random());
  try {
    const detect = doc.getElementById('detect-runtimes');
    assert.equal(typeof detect.handlers.click?.[0], 'function', 'the detect button is wired');
    await detect.handlers.click[0]();
    const connectionRows = doc.getElementById('connection-list').children;
    assert.equal(connectionRows.length, 2, 'both machines are listed under 已连接的机器');
    assert.match(textOf(connectionRows[0]), /desk[\s\S]*离线[\s\S]*最后在线 45 分钟前/,
      'an offline machine says how many minutes ago it was last seen');
    assert.match(textOf(connectionRows[1]), /lap[\s\S]*在线[\s\S]*已连接（最后活跃 3 小时前）/,
      'an online machine says it is connected and when it was last active');
    const detectedRows = doc.getElementById('detected-list').children;
    assert.equal(detectedRows.length, 2, 'both machines are listed under 自托管 FlyBot');
    assert.match(textOf(detectedRows[0]), /最后在线 45 分钟前/, 'the detected card carries the same last-seen text');
    assert.match(textOf(detectedRows[1]), /已连接（最后活跃 3 小时前）/, 'the detected card carries the same connected text');
  } finally {
    restore();
  }
});

test('the state badge follows the server flag instead of the browser clock', async () => {
  const now = nowSeconds();
  const items = [
    {hostname: 'stale-but-online', status: 'online', last_seen: now - 30 * 86400},
    {hostname: 'fresh-but-offline', status: 'offline', last_seen: now - 10},
  ];
  const {doc, restore} = await mountWithConnections(items, 'judgement-' + Math.random());
  try {
    await doc.getElementById('detect-runtimes').handlers.click[0]();
    const rows = doc.getElementById('connection-list').children;
    assert.match(textOf(rows[0]), /stale-but-online[\s\S]*在线[\s\S]*已连接（最后活跃 30 天前）/,
      'a machine the server still calls online stays online even with an old last_seen');
    assert.match(textOf(rows[1]), /fresh-but-offline[\s\S]*离线[\s\S]*刚刚离线/,
      'a machine the server calls offline stays offline even with a fresh last_seen');
  } finally {
    restore();
  }
});
