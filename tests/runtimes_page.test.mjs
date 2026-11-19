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

// --- runtime task list (third slice) -------------------------------------

test('taskStatusText names every runtime task state', () => {
  assert.equal(typeof runtimesApp.taskStatusText, 'function', 'the page exposes taskStatusText as a pure function');
  assert.equal(runtimesApp.taskStatusText({status: 'queued'}), '排队中');
  assert.equal(runtimesApp.taskStatusText({status: 'claimed'}), '已领取');
  assert.equal(runtimesApp.taskStatusText({status: 'succeeded'}), '已完成');
  assert.equal(runtimesApp.taskStatusText({status: 'failed'}), '失败');
  assert.equal(runtimesApp.taskStatusText({status: 'cancelled'}), '已取消');
  assert.equal(runtimesApp.taskStatusText({status: 'timeout'}), '超时');
  assert.equal(runtimesApp.taskStatusText({}), '未知');
  assert.equal(runtimesApp.taskStatusText({status: 'other'}), '未知');
});

test('taskPromptText collapses whitespace and cuts long prompts', () => {
  assert.equal(typeof runtimesApp.taskPromptText, 'function', 'the page exposes taskPromptText as a pure function');
  assert.equal(runtimesApp.taskPromptText({prompt: '  hello\n\tworld  '}), 'hello world');
  assert.equal(runtimesApp.taskPromptText({prompt: 'x'.repeat(120)}), 'x'.repeat(80) + '…');
  assert.equal(runtimesApp.taskPromptText({prompt: 'short'}), 'short');
  assert.equal(runtimesApp.taskPromptText({}), '（无内容）');
});

test('only a queued or claimed task offers the cancel action', () => {
  assert.equal(typeof runtimesApp.taskActions, 'function', 'the page exposes taskActions as a pure function');
  assert.deepEqual(runtimesApp.taskActions({status: 'queued'}), ['cancel']);
  assert.deepEqual(runtimesApp.taskActions({status: 'claimed'}), ['cancel']);
  assert.deepEqual(runtimesApp.taskActions({status: 'succeeded'}), []);
  assert.deepEqual(runtimesApp.taskActions({status: 'failed'}), []);
  assert.deepEqual(runtimesApp.taskActions({status: 'cancelled'}), []);
  assert.deepEqual(runtimesApp.taskActions({}), []);
});

class FakeTaskElement {
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

function fakeTaskDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeTaskElement(id.endsWith('-form') ? 'form' : 'div'));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return new FakeTaskElement(); },
    createElement(tag) { return new FakeTaskElement(tag); },
  };
  return {doc, elements};
}

function textOfTaskNode(node) {
  return [node.textContent || ''].concat(node.children.map(textOfTaskNode)).join(' ');
}

async function mountWithTasks(tasks, tag) {
  const {doc} = fakeTaskDocument();
  const calls = [];
  const state = {tasks: tasks.map((item) => ({...item}))};
  const fetcher = async (path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/runtime-keys') return {status: 200, json: async () => ({device_id: 'desk', items: []})};
    if (path === '/v1/runtime/connections') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/runtime/tasks' && method === 'GET') {
      return {status: 200, json: async () => ({items: state.tasks})};
    }
    const cancel = /^\/v1\/runtime\/tasks\/([0-9a-f]{32})\/cancel$/.exec(path);
    if (cancel && method === 'POST') {
      const task = state.tasks.find((item) => item.id === cancel[1]);
      if (!task) return {status: 404, json: async () => ({error: {code: 'not_found'}})};
      task.status = 'cancelled';
      task.result = {cancelled: true};
      return {status: 200, json: async () => ({task})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  await import('../openteamily/static/runtimes/app.mjs?tasks=' + tag);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return {
    doc,
    calls,
    state,
    restore() {
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
      if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    },
  };
}

test('the page lists recent runtime tasks with status and a cancel control', async () => {
  const queued = {id: 'a'.repeat(32), kind: 'echo', prompt: 'ping the machine', status: 'queued', created: 1, updated: 1};
  const done = {id: 'b'.repeat(32), kind: 'infer', prompt: 'summarize the notes', status: 'succeeded', created: 2, updated: 3};
  const {doc, restore} = await mountWithTasks([queued, done], 'list-' + Math.random());
  try {
    const rows = doc.getElementById('task-list').children;
    assert.equal(rows.length, 2, 'both tasks are listed');
    assert.match(textOfTaskNode(rows[0]), /ping the machine[\s\S]*测试 · 排队中/, 'a queued echo task shows its prompt and 排队中');
    assert.match(textOfTaskNode(rows[1]), /summarize the notes[\s\S]*推理 · 已完成/, 'a finished infer task shows its prompt and 已完成');
    const cancelButton = rows[0].children.find((child) => child.tagName === 'button');
    assert.equal(Boolean(cancelButton), true, 'a queued task carries a cancel button');
    assert.equal(cancelButton.textContent, '取消');
    const doneButton = rows[1].children.find((child) => child.tagName === 'button');
    assert.equal(Boolean(doneButton), false, 'a finished task carries no cancel button');
    assert.equal(doc.getElementById('tasks-empty').hidden, true, 'the empty sentence is hidden when tasks exist');
  } finally {
    restore();
  }
});

test('cancelling a queued task sends one request and reloads the list', async () => {
  const queued = {id: 'c'.repeat(32), kind: 'echo', prompt: 'cancel me', status: 'queued', created: 1, updated: 1};
  const {doc, calls, restore} = await mountWithTasks([queued], 'cancel-' + Math.random());
  try {
    const row = doc.getElementById('task-list').children[0];
    const cancelButton = row.children.find((child) => child.tagName === 'button');
    const getsBefore = calls.filter((call) => call === 'GET /v1/runtime/tasks').length;
    await cancelButton.handlers.click[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call === `POST /v1/runtime/tasks/${'c'.repeat(32)}/cancel`).length, 1,
      'confirming sends exactly one cancel request');
    assert.ok(calls.filter((call) => call === 'GET /v1/runtime/tasks').length > getsBefore, 'the list is reloaded after cancelling');
    const rows = doc.getElementById('task-list').children;
    assert.match(textOfTaskNode(rows[0]), /cancel me[\s\S]*测试 · 已取消/, 'the cancelled task shows its new state');
  } finally {
    restore();
  }
});

test('the empty task list says what to do next', async () => {
  const {doc, restore} = await mountWithTasks([], 'empty-' + Math.random());
  try {
    assert.equal(doc.getElementById('task-list').children.length, 0, 'no task rows');
    const empty = doc.getElementById('tasks-empty');
    assert.equal(empty.hidden, false, 'the empty sentence is shown');
    assert.equal(empty.textContent, '还没有发到运行时的任务。发一个测试任务后会出现在这里。');
  } finally {
    restore();
  }
});
