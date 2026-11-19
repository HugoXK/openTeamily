import assert from 'node:assert/strict';
import test from 'node:test';
import {
  csrfCookie, listQuery, visibleArtifacts, artifactMatchesType,
  artifactMatchesModified, viewFromSearch, queryForView, FILE_TYPE_LABELS,
  sessionFilterChoices, applyDirectoryCollapsed, artifactDeletePrompt, mount,
} from '../openteamily/static/artifacts/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
});

test('visibleArtifacts filters by kind, saved messages and creator', () => {
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice'},
    {title: 'Site', kind: 'website', created_by: 'bob'},
    {title: 'Clip', kind: 'document', created_by: 'alice', source: {kind: 'agent_message', id: 'm1'}},
  ];
  assert.deepEqual(visibleArtifacts(items, {kind: 'website'}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'messages'}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'meetings'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'mine', username: 'alice'}).map((item) => item.title), ['Doc', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'favorites'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), []);
});

test('visibleArtifacts maps recorded filters onto existing fields', () => {
  const now = Date.parse('2026-11-17T02:30:00Z');
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice', updated: now / 1000 - 60},
    {title: 'Site', kind: 'website', created_by: 'bob', updated: now / 1000 - 60},
    {title: 'Photo', kind: 'media', created_by: 'alice', updated: now / 1000 - 60, media: {mime: 'image/png'}},
    {title: 'Old', kind: 'document', created_by: 'alice', updated: now / 1000 - 40 * 24 * 60 * 60},
    {title: 'Task', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_task', conversation_id: 'c1'}},
    {title: 'Clip', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_message', conversation_id: 'c2'}},
  ];
  assert.equal(FILE_TYPE_LABELS.length, 13);
  assert.equal(artifactMatchesType(items[0], '云文档'), true);
  assert.equal(artifactMatchesType(items[5], '云文档'), false);
  assert.equal(artifactMatchesType(items[2], '图片'), true);
  assert.equal(artifactMatchesType(items[0], 'Markdown'), false);
  assert.equal(artifactMatchesType({kind: 'slides'}, '幻灯片'), true);
  assert.equal(artifactMatchesType({kind: 'document'}, '幻灯片'), false);
  assert.deepEqual(visibleArtifacts(items, {types: ['网页']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {types: ['消息']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {types: ['Markdown']}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {modified: 'today', now}).map((item) => item.title),
                   ['Doc', 'Site', 'Photo', 'Task', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {modified: 'custom', now}).map((item) => item.title),
                   items.map((item) => item.title));
  assert.deepEqual(visibleArtifacts(items, {creators: ['bob']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {sessions: ['c2']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), ['Task']);
  assert.equal(artifactMatchesModified(items[3], 'd30', now), false);
  assert.equal(artifactMatchesModified(items[3], 'd90', now), true);
});

test('sessionFilterChoices uses conversation titles instead of raw ids', () => {
  const choices = sessionFilterChoices([
    {title: 'Clip', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Again', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Other', source: {kind: 'agent_message', conversation_id: 'c1'}},
    {title: 'Plain', kind: 'document'},
  ]);
  assert.deepEqual(choices, [
    {id: 'c1', label: '对话'},
    {id: 'c2', label: '晨会'},
  ]);
  assert.equal(choices.some((row) => row.label === 'c1' || row.label === 'c2'), false);
});

test('viewFromSearch and queryForView stay on the recorded allowlist', () => {
  assert.deepEqual(viewFromSearch(''), {kind: 'all', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=created'), {kind: 'all', scope: 'mine'});
  assert.deepEqual(viewFromSearch('?view=starred'), {kind: 'all', scope: 'favorites'});
  assert.deepEqual(viewFromSearch('?view=memory'), {kind: 'all', scope: 'memory'});
  assert.deepEqual(viewFromSearch('?view=meetings'), {kind: 'meetings', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=unknown'), {kind: 'all', scope: 'all'});
  assert.equal(queryForView('all', 'all'), '');
  assert.equal(queryForView('all', 'mine'), '?view=created');
  assert.equal(queryForView('all', 'favorites'), '?view=starred');
  assert.equal(queryForView('all', 'memory'), '?view=memory');
  assert.equal(queryForView('meetings', 'all'), '?view=meetings');
});

test('applyDirectoryCollapsed hides the directory in session only', () => {
  const nodes = {};
  const el = (id, extra = {}) => {
    const node = {
      id,
      hidden: false,
      className: '',
      attributes: {},
      classList: {
        toggle(name, on) {
          const parts = new Set((node.className || '').split(/\s+/).filter(Boolean));
          if (on) parts.add(name);
          else parts.delete(name);
          node.className = [...parts].join(' ');
        },
      },
      setAttribute(key, value) {
        node.attributes[key] = value;
      },
      getAttribute(key) {
        return node.attributes[key];
      },
    };
    Object.assign(node, extra);
    nodes[id] = node;
    return node;
  };
  el('list-panel');
  el('artifact-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['artifact-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['artifact-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.parentNode = null;
    this._text = '';
    this.classList = {
      add() {}, remove() {},
      toggle(name, on) { this._last = [name, on]; },
      contains() { return false; },
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this.children = []; this._text = String(value); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter(item => item !== handler);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(child) { return child === this || this.children.includes(child); }
  focus() { if (this.ownerDocument) this.ownerDocument._activeElement = this; }
  getContext() { return {fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {}}; }
  async dispatch(type, event = {}) {
    if (!event.preventDefault) event.preventDefault = () => {};
    for (const handler of this.handlers[type] || []) await handler(event);
  }
}

function fakeDocument() {
  const elements = new Map();
  const created = [];
  const doc = {
    cookie: '',
    _activeElement: null,
    get activeElement() { return this._activeElement; },
    getElementById(id) {
      if (!elements.has(id)) {
        const tags = {workspace: 'select', search: 'input', 'editor-form': 'form', 'artifact-list': 'ul'};
        const node = new FakeNode(tags[id] || 'div');
        node.ownerDocument = doc;
        elements.set(id, node);
      }
      return elements.get(id);
    },
    createElement(tag) {
      const node = new FakeNode(tag);
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    createTextNode(text) {
      const node = new FakeNode('#text');
      node.textContent = text;
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      doc.handlers[type] = (doc.handlers[type] || []).filter(item => item !== handler);
    },
    async dispatch(type, event = {}) {
      if (!event.preventDefault) event.preventDefault = () => {};
      for (const handler of doc.handlers[type] || []) await handler(event);
    },
    handlers: {},
  };
  const form = doc.getElementById('editor-form');
  form.elements = {title: new FakeNode('input'), body: new FakeNode('textarea')};
  return {doc, elements, created, form};
}

function reply({status = 200, body = {}} = {}) {
  return {status, json: async () => body};
}

async function openArtifactsPage({items = [], artifact} = {}) {
  const {doc, elements, created, form} = fakeDocument();
  const calls = [];
  let listed = items.slice();
  const target = artifact || {id: 'a1', title: 'Doc', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'};
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({method, path, headers: options.headers || {}, body: options.body});
    if (path === '/v1/auth/session') return reply({body: {user: {id: 'u1', username: 'alice'}}});
    if (path === '/v1/auth/providers') return reply({body: {items: []}});
    if (path === '/v1/workspaces?limit=100') return reply({body: {items: [{id: 'w1', name: 'Desk'}]}});
    if (path === '/v1/workspaces/w1/artifacts') return reply({body: {items: listed}});
    if (path === '/v1/workspaces/w1/artifacts/a1') return reply({body: {artifact: target}});
    if (path === '/v1/workspaces/w1/artifacts/a1/shares') return reply({body: {items: []}});
    if (path === '/v1/workspaces/w1/artifacts/a1/versions') return reply({body: {items: []}});
    if (path === '/v1/workspaces/w1/artifacts/a1/discover') return reply({body: {discover: {}}});
    if (path === '/v1/workspaces/w1/artifacts/a1/remove') {
      listed = [];
      return reply({status: 200});
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  let mounted = false;
  try {
    await mount(doc, {fetcher});
    mounted = true;
  } finally {
    if (!mounted) {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  }
  return {
    doc, elements, created, form, calls,
    removeCalls() { return calls.filter(call => call.path === '/v1/workspaces/w1/artifacts/a1/remove'); },
    alertdialog() { return created.filter(node => node.getAttribute('role') === 'alertdialog' && node.parentNode); },
    close() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    },
  };
}

async function openEditorOn(page) {
  const list = page.elements.get('artifact-list');
  const row = list.children[0];
  assert.ok(row, 'the list must render the artifact row first');
  await row.children[0].dispatch('click');
}

test('artifactDeletePrompt names the artifact and never echoes an empty title', () => {
  assert.deepEqual(artifactDeletePrompt({title: 'Doc'}), {
    question: '删除「Doc」？', detail: '删除后不能恢复。', cancelLabel: '取消', confirmLabel: '确认',
  });
  assert.equal(artifactDeletePrompt({title: '  '}).question, '删除这个作品？');
  assert.equal(artifactDeletePrompt(null).question, '删除这个作品？');
});

test('clicking remove asks first and sends no request until the answer is yes', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    assert.equal(trigger.hidden, false);
    void trigger.dispatch('click');
    assert.equal(page.removeCalls().length, 0, 'opening the question must not send the delete request');
    const dialogs = page.alertdialog();
    assert.equal(dialogs.length, 1, 'one inline alertdialog must exist');
    const box = dialogs[0];
    assert.equal(box.getAttribute('aria-labelledby'), 'remove-artifact-question');
    const question = box.children.find(child => child.id === 'remove-artifact-question');
    assert.equal(question.textContent, '删除「Doc」？');
    assert.deepEqual(box.children.filter(child => child.tagName === 'BUTTON').map(child => child.textContent), ['取消', '确认']);
    assert.equal(trigger.hidden, true);
    const buttons = box.children.filter(child => child.tagName === 'BUTTON');
    assert.equal(page.doc.activeElement, buttons[0], 'focus starts on the cancel button');
  } finally {
    page.close();
  }
});

test('cancel and Escape keep the artifact and send nothing', async () => {
  for (const how of ['cancel', 'escape']) {
    const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
    try {
      await openEditorOn(page);
      const trigger = page.elements.get('remove-artifact');
      const list = page.elements.get('artifact-list');
      const statusText = page.elements.get('status').textContent;
      const rowsBefore = list.children.length;
      const pending = trigger.dispatch('click');
      const box = page.alertdialog()[0];
      const choice = box.children.filter(child => child.tagName === 'BUTTON');
      if (how === 'cancel') await choice[0].dispatch('click');
      else await page.doc.dispatch('keydown', {key: 'Escape'});
      await pending;
      assert.equal(page.removeCalls().length, 0, `no delete request after ${how}`);
      assert.equal(page.alertdialog().length, 0, `the question closes after ${how}`);
      assert.equal(trigger.hidden, false, `the remove button returns after ${how}`);
      assert.equal(page.doc.activeElement, trigger, `focus returns to remove after ${how}`);
      assert.equal(list.children.length, rowsBefore, `the list is unchanged after ${how}`);
      assert.equal(page.elements.get('status').textContent, statusText, `the status line is unchanged after ${how}`);
    } finally {
      page.close();
    }
  }
});

test('confirming deletes the artifact exactly once and clears it from the list', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    const pending = trigger.dispatch('click');
    const box = page.alertdialog()[0];
    await box.children.filter(child => child.tagName === 'BUTTON')[1].dispatch('click');
    await pending;
    assert.equal(page.removeCalls().length, 1);
    assert.equal(page.elements.get('status').textContent, '已删除。');
    assert.equal(page.elements.get('status').dataset.kind, 'ok');
    assert.equal(page.elements.get('artifact-list').children.length, 0);
    assert.equal(page.elements.get('editor-form').hidden, true);
    assert.equal(page.elements.get('list-panel').hidden, false);
  } finally {
    page.close();
  }
});
