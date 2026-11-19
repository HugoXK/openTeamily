import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, readWizard, step1Ready, validName, validSlug } from '../openteamily/static/team/app.mjs';

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

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._text = '';
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  appendChild(child) { this.children.push(child); return child; }
  async dispatch(type, event = {}) {
    if (!event.preventDefault) event.preventDefault = () => {};
    for (const handler of this.handlers[type] || []) await handler(event);
  }
}

class FakeFormData {
  constructor(form) { this.form = form; }
  get(name) {
    const node = this.form.elements[name];
    return node ? (node.value ?? '') : null;
  }
}

function fakeForm() {
  const form = new FakeNode('form');
  form.elements = {
    name: new FakeNode('input'),
    slug: new FakeNode('input'),
    mode: new FakeNode('input'),
    workspace_id: new FakeNode('select'),
  };
  form.elements.mode.value = 'new';
  form.resetCount = 0;
  form.reset = () => {
    form.resetCount += 1;
    form.elements.name.value = '';
    form.elements.slug.value = '';
  };
  return form;
}

function fakeDocument() {
  const elements = new Map();
  const form = fakeForm();
  elements.set('wizard-form', form);
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode());
      return elements.get(id);
    },
    createElement(tag) { return new FakeNode(tag); },
  };
  return {doc, elements, form};
}

function reply({status = 200, body = {}} = {}) {
  return {status, json: async () => body};
}

const ALICE = {status: 200, body: {user: {id: 'u1', username: 'alice'}}};

async function openTeamPage({workspaces, session = ALICE, login, teams} = {}) {
  const {doc, elements, form} = fakeDocument();
  const calls = [];
  const items = workspaces || [{id: 'w1', name: 'Desk', owner_id: 'u1', kind: 'personal'}];
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({method, path, headers: options.headers || {}, body: options.body});
    if (path === '/v1/auth/session') return reply(session);
    if (path === '/v1/auth/providers') return reply({body: {items: []}});
    if (path === '/v1/workspaces?limit=100') return reply({body: {items}});
    if (path === '/v1/auth/login') return reply(login || {status: 200});
    if (path === '/v1/auth/logout') return reply({status: 200});
    if (path === '/v1/teams') return reply(teams || {status: 201});
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  const savedDocument = globalThis.document;
  const savedFormData = globalThis.FormData;
  globalThis.document = doc;
  globalThis.FormData = FakeFormData;
  let mounted = false;
  try {
    await mount(doc, {fetcher});
    mounted = true;
  } finally {
    if (!mounted) {
      if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
      globalThis.FormData = savedFormData;
    }
  }
  return {
    doc, elements, form, calls,
    close() {
      if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
      globalThis.FormData = savedFormData;
    },
  };
}

async function withTeamPage(options, body) {
  const page = await openTeamPage(options);
  try { await body(page); } finally { page.close(); }
}

test('next refuses to advance while the Team ID is not valid', async () => {
  await withTeamPage({}, async ({elements, form}) => {
    form.elements.name.value = 'Desk';
    form.elements.slug.value = 'ab';
    await elements.get('next').dispatch('click');
    assert.equal(elements.get('status').dataset.kind, 'error');
    assert.equal(elements.get('status').textContent, '请先填好团队名称和 Team ID。');
    assert.equal(elements.get('step-1').hidden, false);
    assert.equal(elements.get('step-later').hidden, true);
  });
});

test('next advances to the review step and swaps the action buttons once step 1 is valid', async () => {
  await withTeamPage({}, async ({elements, form}) => {
    form.elements.name.value = 'Desk';
    form.elements.slug.value = 'desk-team';
    await elements.get('next').dispatch('click');
    assert.equal(elements.get('step-1').hidden, true);
    assert.equal(elements.get('step-later').hidden, false);
    assert.equal(elements.get('back').hidden, false);
    assert.equal(elements.get('next').hidden, true);
    assert.equal(elements.get('submit').hidden, false);
    assert.equal(elements.get('status').textContent, '');
    await elements.get('back').dispatch('click');
    assert.equal(elements.get('step-1').hidden, false);
    assert.equal(elements.get('step-later').hidden, true);
  });
});

test('the workspace picker appears only for an account with more than one convertible workspace', async () => {
  const two = [
    {id: 'w1', name: 'Desk', owner_id: 'u1', kind: 'personal'},
    {id: 'w2', name: 'Studio', owner_id: 'u1', kind: 'personal'},
  ];
  await withTeamPage({workspaces: two}, async ({elements, form}) => {
    form.elements.mode.value = 'convert';
    await form.dispatch('change');
    assert.equal(elements.get('convert-workspace-note').hidden, false);
    assert.equal(elements.get('convert-workspace-field').hidden, false);
    form.elements.mode.value = 'new';
    await form.dispatch('change');
    assert.equal(elements.get('convert-workspace-note').hidden, true);
    assert.equal(elements.get('convert-workspace-field').hidden, true);
  });
  await withTeamPage({workspaces: two.slice(0, 1)}, async ({elements, form}) => {
    form.elements.mode.value = 'convert';
    await form.dispatch('change');
    assert.equal(elements.get('convert-workspace-note').hidden, false);
    assert.equal(elements.get('convert-workspace-field').hidden, true,
      'one convertible workspace needs no picker');
  });
});

test('only the signed-in user non-team workspaces are offered for conversion', async () => {
  await withTeamPage({workspaces: [
    {id: 'w1', name: 'Desk', owner_id: 'u1', kind: 'personal'},
    {id: 'w2', name: 'Someone else', owner_id: 'u2', kind: 'personal'},
    {id: 'w3', name: 'Already a team', owner_id: 'u1', kind: 'team'},
  ]}, async ({elements, form}) => {
    const select = form.elements.workspace_id;
    assert.deepEqual(select.options.map(option => option.value), ['w1']);
    assert.deepEqual(select.options.map(option => option.textContent), ['Desk']);
    assert.equal(elements.get('whoami').textContent, 'alice');
  });
});

test('creating a team posts once with an idempotency key and returns to step 1', async () => {
  await withTeamPage({}, async ({doc, elements, form, calls}) => {
    doc.cookie = '__Host-ot_csrf=csrf-token';
    form.elements.name.value = 'Desk';
    form.elements.slug.value = 'desk-team';
    form.elements.mode.value = 'new';
    await elements.get('next').dispatch('click');
    assert.equal(elements.get('step-1').hidden, true);
    await form.dispatch('submit');
    const post = calls.find(call => call.path === '/v1/teams');
    assert.equal(post.method, 'POST');
    assert.deepEqual(JSON.parse(post.body), {name: 'Desk', slug: 'desk-team', mode: 'new'});
    assert.match(post.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(post.headers['X-CSRF-Token'], 'csrf-token');
    assert.equal(elements.get('status').dataset.kind, 'ok');
    assert.equal(elements.get('status').textContent, '已创建独立团队工作区。');
    assert.equal(elements.get('step-1').hidden, false);
    assert.equal(form.resetCount, 1);
  });
});
