import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
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
    this.elements = {};
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent || '').join('');
  }
  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelector() { return null; }
  focus() {}
  reset() {}
}

function fakeDocument() {
  const elements = new Map();
  return {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.endsWith('-form') ? 'form' : id === 'industry' ? 'select' : 'div';
        elements.set(id, new FakeElement(tag, id));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await flush();
}

function json(status, body) {
  return {status, json: async () => body};
}

function fetcherFor(state) {
  const calls = [];
  return {
    calls,
    fetch: async (path) => {
      calls.push(path);
      if (path === '/v1/auth/session') return json(200, {user: {username: 'alice'}});
      if (path === '/v1/onboarding') return json(200, {industries: [], onboarding: null});
      if (path === '/v1/workspaces?limit=100') {
        if (state.workspaces === 'error') return json(500, {error: {message: 'workspace listing failed'}});
        return json(200, {items: state.workspaces || []});
      }
      const members = /^\/v1\/workspaces\/([^/]+)\/members$/.exec(path);
      if (members) {
        if (state.members === 'error') return json(500, {error: {message: 'member listing failed'}});
        return json(200, {items: (state.members || []).map((name) => ({username: name}))});
      }
      const agents = /^\/v1\/workspaces\/([^/]+)\/agents\?limit=100$/.exec(path);
      if (agents) return json(200, {items: state.agents || []});
      const conversations = /^\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)\/conversations\?limit=1$/.exec(path);
      if (conversations) return json(200, {items: state.conversations || []});
      if (/^\/v1\/workspaces\/([^/]+)\/social\/conversations\?limit=1$/.test(path)) {
        return json(200, {items: state.social || []});
      }
      throw new Error('unexpected ' + path);
    },
  };
}

async function mountOnboarding(state) {
  const doc = fakeDocument();
  const fake = fetcherFor(state);
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fake.fetch;
  try {
    await import('../openteamily/static/onboarding/app.mjs?checklist=' + Math.random());
    await settle();
  } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
  }
  return {doc, calls: fake.calls};
}

function steps(doc) {
  const list = doc.getElementById('onboarding-checklist');
  return list.children.map((row) => ({
    text: row.textContent,
    done: row.dataset.state === 'done',
  }));
}

test('a fresh account sees three steps, none of them faked as done', async () => {
  const {doc} = await mountOnboarding({workspaces: [], members: [], agents: [], conversations: []});
  const rows = steps(doc);
  assert.equal(rows.length, 3, 'expected 3 onboarding steps, got ' + rows.length);
  assert.deepEqual(rows.map((row) => row.done), [false, false, false],
    'an empty account claims a step is already done');
  assert.match(rows[0].text, /创建工作区/);
  assert.match(rows[1].text, /邀请一位同事/);
  assert.match(rows[2].text, /发出第一条消息/);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true,
    'the ready banner shows before the checklist is complete');
});

test('a workspace with a second member and one message completes every step', async () => {
  const {doc, calls} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}],
    members: ['alice', 'bob'],
    agents: [{id: 'ag-1'}],
    conversations: [{id: 'c-1'}],
    social: [],
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, true, true],
    'real state (workspace, second member, one message) did not complete the steps');
  for (const row of rows) assert.match(row.text, /✓/, 'a completed step is not ticked: ' + row.text);
  const ready = doc.getElementById('onboarding-ready');
  assert.equal(ready.hidden, false, 'all steps are done but the ready banner is hidden');
  assert.match(ready.textContent, /可以开始了/);
  const link = ready.children.find((child) => child.tagName === 'A');
  assert.ok(link, 'the ready banner has no link to /chat');
  assert.equal(link.getAttribute('href'), '/chat');
  assert.ok(calls.includes('/v1/workspaces?limit=100'), 'the checklist did not read the workspaces API');
  assert.ok(calls.some((path) => /\/members$/.test(path)), 'the checklist did not read members');
});

test('with only a workspace, the remaining steps say what is missing instead of pretending', async () => {
  const {doc} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}],
    members: ['alice'],
    agents: [],
    conversations: [],
    social: [],
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, false, false]);
  assert.match(rows[1].text, /还差|邀请|需要/);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true);
});

test('a failing workspace request leaves every step unproven and says so', async () => {
  const {doc} = await mountOnboarding({workspaces: 'error', members: [], agents: [], conversations: []});
  const rows = steps(doc);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.done), [false, false, false],
    'a failed workspace request was reported as completed');
});
