// Ticking an action item on /meetings writes that meeting back at once,
// through the existing edit route, without pressing 保存.
import assert from 'node:assert/strict';
import test from 'node:test';

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
    this.checked = false;
    this.type = '';
    this.className = '';
    this._text = '';
  }
  get textContent() { return this._text; }
  set textContent(value) {
    this._text = String(value);
    if (this._text === '') this.children = [];
  }
  get innerText() { return this._text; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  // A real <select> selects its first option once one exists.
  pickFirstOption() {
    if (this.tagName !== 'select' || this.value) return;
    const first = this.children.find((child) => child.tagName === 'option');
    if (first) this.value = first.value;
  }
  appendChild(child) { this.children.push(child); this.pickFirstOption(); return child; }
  append(...nodes) { for (const node of nodes) this.children.push(node); this.pickFirstOption(); }
  replaceChildren(...nodes) { this.children = nodes; this.pickFirstOption(); }
  focus() {}
  click() { for (const handler of this.handlers.click || []) handler(); }
  reset() {}
  get options() { return this.children.filter((child) => child.tagName === 'option'); }
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: 'ot_dev_csrf=test',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' ? 'select' : id === 'meeting-form' ? 'form' : 'div';
        elements.set(id, new FakeElement(tag));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, elements};
}

const WORKSPACE = 'a'.repeat(32);
const MEETING_ID = 'b'.repeat(32);
const OTHER_MEETING_ID = 'c'.repeat(32);

function meeting(id = MEETING_ID, revision = 3, actions = [
  {text: 'A', done: false, owner: ''},
  {text: 'B', done: false, owner: ''},
]) {
  return {
    id, workspace_id: WORKSPACE, title: 'Weekly', started_at: 1800000000,
    attendees: ['alice'], revision, created_by: 'alice', updated_by: 'alice',
    summary: '', transcript: '', action_items: actions.map((item) => ({...item})),
    action_count: actions.length,
    done_count: actions.filter((item) => item.done).length,
  };
}

async function mountPage(tag, { revokeWith = 200, beforeWrite = () => {}, native = false, mobile = false, readList, saveArtifact } = {}) {
  const {doc, elements} = fakeDocument();
  if (native) doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const state = {calls: [], body: meeting(), posted: [], revokeWith};
  const json = (status, payload) => ({status, json: async () => payload});
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    state.calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return json(200, {user: {username: 'alice'}});
    if (path === '/v1/workspaces?limit=100' || path === '/v1/workspaces?scope=personal') {
      return json(200, {items: [{id: WORKSPACE, name: 'Team'}]});
    }
    if (path.startsWith(`/v1/workspaces/${WORKSPACE}/meetings?`)) {
      if (readList) return readList(new URLSearchParams(path.split('?')[1]), options, json);
      return json(200, {items: [{
        id: MEETING_ID, title: state.body.title, started_at: state.body.started_at,
        attendees: state.body.attendees, done_count: state.body.done_count,
        action_count: state.body.action_count,
      }], cursor: null});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}/artifact` && method === 'POST' && saveArtifact) {
      return saveArtifact(JSON.parse(options.body), json);
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'GET') {
      return json(200, {meeting: state.body, viewer_username: 'alice'});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${OTHER_MEETING_ID}` && method === 'GET') {
      return json(200, {meeting: {...meeting(OTHER_MEETING_ID, 8), title: 'Other'}});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      state.posted.push(payload);
      await beforeWrite();
      if (revokeWith !== 200) return json(revokeWith, {error: {message: 'Meeting changed elsewhere; reload and retry'}});
      state.body = {
        ...state.body,
        revision: state.body.revision + 1,
        action_items: payload.changes.action_items.map((item) => ({...item})),
        done_count: payload.changes.action_items.filter((item) => item.done).length,
        action_count: payload.changes.action_items.length,
      };
      return json(200, {meeting: state.body});
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = {document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData, matchMedia: globalThis.matchMedia};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  globalThis.matchMedia = () => ({matches: mobile});
  const restore = () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    if (saved.matchMedia === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = saved.matchMedia;
    globalThis.FormData = saved.FormData;
  };
  await import('../openteamily/static/meetings/app.mjs?toggle=' + tag);
  await settle();
  return {doc, elements, state, restore};
}

async function settle() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function checkbox(doc, index) {
  const row = doc.getElementById('action-list').children[index];
  const label = row && row.children[2];
  return label && label.children[0];
}

test('ticking an action item writes the meeting back without pressing 保存', async () => {
  const {doc, state, restore} = await mountPage('tick-' + Math.random());
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'one edit request goes out for one tick');
    const payload = state.posted[0];
    assert.equal(payload.revision, 3, 'the request carries the revision the page holds');
    assert.deepEqual(Object.keys(payload.changes), ['action_items'], 'only action_items is sent, so other fields are not clobbered');
    assert.deepEqual(payload.changes.action_items, [
      {text: 'A', done: true, owner: ''},
      {text: 'B', done: false, owner: ''},
    ], 'only the ticked item flips');
    assert.equal((await doc.getElementById('status').textContent).trim(), '已标记完成。');
    assert.match(doc.getElementById('meeting-list').children[0].children[0].children[1].textContent, /1\/2 行动项/,
      'the list count follows the tick');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 4/);
  } finally {
    restore();
  }
});

test('a stale revision reverts the tick and says the meeting moved on', async () => {
  const {doc, state, restore} = await mountPage('conflict-' + Math.random(), {revokeWith: 409});
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'the page tried once');
    assert.equal(box.checked, false, 'the tick goes back to the server state');
    assert.equal((await doc.getElementById('status').textContent).trim(), '会议已在别处更新，请重新打开后再勾选。');
    assert.equal(doc.getElementById('status').dataset.kind, 'error');
  } finally {
    restore();
  }
});

test('a tick persists only the saved action and keeps unsaved edits local', async () => {
  const {doc, state, restore} = await mountPage('draft-isolation');
  try {
    const row = doc.getElementById('action-list').children[1];
    const title = row.children[0];
    title.value = 'draft text';
    title.handlers.input[0]();
    const box = checkbox(doc, 1);
    box.checked = true;
    await box.handlers.change[0]();
    assert.equal(state.posted[0].changes.action_items[1].text, 'B');
    assert.equal(state.posted[0].changes.action_items[1].done, true);
    assert.equal(title.value, 'draft text');
    assert.equal(box.checked, true);
  } finally {
    restore();
  }
});

test('an earlier write cannot update the newly selected meeting', async () => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  const {doc, state, restore} = await mountPage('scope-fence', {beforeWrite: () => held});
  try {
    const box = checkbox(doc, 0);
    box.checked = true;
    const sent = box.handlers.change[0]();
    assert.equal(doc.getElementById('save-meeting').disabled, true);
    await doc.getElementById('meeting-list').handlers.click[0]({
      target: {closest: () => ({dataset: {meeting: OTHER_MEETING_ID}})},
    });
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 8/);
    finish();
    await sent;
    assert.equal(state.body.revision, 4);
    assert.equal(doc.getElementById('meeting-title').value, 'Other');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 8/);
    assert.equal(doc.getElementById('save-meeting').disabled, false);
    assert.equal(doc.getElementById('status').textContent, '');
  } finally {
    finish();
    restore();
  }
});

test('a new meeting that was never saved only changes locally', async () => {
  const {doc, elements, state, restore} = await mountPage('new-' + Math.random());
  try {
    // No saved meeting selected: the form is empty and no id is held.
    elements.get('new-meeting').handlers.click[0]();
    await settle();
    elements.get('add-action').handlers.click[0]();
    await settle();
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the checkbox still works before the first save');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();
    assert.equal(state.posted.length, 0, 'nothing is written for a meeting that does not exist yet');
  } finally {
    restore();
  }
});

test('native search and paged retries replace only the current listing, preserving edits', async () => {
  let releaseOld;
  let oldSignal;
  let appendAttempts = 0;
  const old = new Promise(resolve => { releaseOld = resolve; });
  const {doc, restore} = await mountPage('meeting-list-pages', {
    native: true,
    async readList(query, options, json) {
      assert.equal(query.get('limit'), '20');
      assert.equal(query.get('order'), 'recent');
      if (query.get('q') === 'old') {
        oldSignal = options.signal;
        await old;
        return json(200, {items: [{...meeting(), title: 'Outdated'}], cursor: null});
      }
      if (query.get('q') === 'new') {
        assert.equal(query.get('open'), '1');
        if (query.get('cursor')) {
          assert.equal(query.get('cursor'), MEETING_ID);
          if (++appendAttempts === 1) return json(503, {});
          return json(200, {items: [{...meeting(), title: 'Duplicate'}, {...meeting(OTHER_MEETING_ID), title: 'Next'}], cursor: null});
        }
        return json(200, {items: [{...meeting(), title: 'Filtered'}], cursor: MEETING_ID});
      }
      return json(200, {items: [meeting()], cursor: null});
    },
  });
  const ele = id => doc.getElementById(id);
  const titles = () => ele('meeting-list').children.map(li => li.children[0].children[0].textContent);
  try {
    assert.deepEqual(titles(), ['Weekly']);
    ele('meeting-title').value = 'An unsaved editor title';
    ele('meeting-search').value = 'old';
    ele('meeting-list-filters').handlers.submit[0]({preventDefault() {}});
    ele('meeting-search').value = '  new ';
    ele('meeting-open-only').checked = true;
    ele('meeting-open-only').handlers.change[0]();
    assert.equal(oldSignal.aborted, true);
    releaseOld();
    await settle();
    assert.deepEqual(titles(), ['Filtered']);
    assert.equal(ele('meeting-title').value, 'An unsaved editor title');
    await ele('meeting-list-more').handlers.click[0]();
    assert.deepEqual(titles(), ['Filtered']);
    assert.equal(ele('meeting-list-retry').hidden, false);
    await ele('meeting-list-retry').handlers.click[0]();
    assert.deepEqual(titles(), ['Filtered', 'Next']);
    assert.equal(ele('meeting-list-retry').hidden, true);
    assert.equal(ele('meeting-list-more').hidden, true);
  } finally {
    releaseOld();
    restore();
  }
});

test('native follow-up opens only saved open items and artifact save uses the stored revision', async () => {
  const sent = [];
  const artifactId = 'd'.repeat(32);
  const {doc, state, restore} = await mountPage('meeting-saved-actions', {
    native: true,
    saveArtifact(body, json) {
      sent.push(body);
      return json(201, {artifact: {id: artifactId, workspace_id: WORKSPACE}});
    },
  });
  const ele = id => doc.getElementById(id);
  const link = index => ele('action-list').children[index].children[4];
  try {
    assert.equal(link(0).href, `/automations?workspace=${WORKSPACE}&meeting=${MEETING_ID}&action=0&revision=3`);
    assert.equal(link(0).target, '_blank');
    assert.equal(link(0).hidden, false);
    ele('meeting-transcript').value = 'Unsaved private transcript';
    const input = ele('action-list').children[0].children[0];
    input.value = 'Unsaved action';
    input.handlers.input[0]();
    assert.equal(link(0).getAttribute('aria-disabled'), 'true');
    assert.equal(link(1).getAttribute('aria-disabled'), undefined);
    await ele('save-meeting-artifact').handlers.click[0]();
    assert.deepEqual(sent, [{revision: 3}]);
    assert.equal(ele('meeting-artifact-link').href, `/space?workspace=${WORKSPACE}&artifact=${artifactId}`);
    assert.equal(ele('meeting-artifact-link').hidden, false);
    assert.equal(ele('meeting-transcript').value, 'Unsaved private transcript');
    const box = checkbox(doc, 1);
    box.checked = true;
    await box.handlers.change[0]();
    assert.equal(state.body.revision, 4);
    assert.equal(link(1).hidden, true);
    assert.equal(ele('meeting-artifact-link').hidden, true);
  } finally {
    restore();
  }
});

test('native pagination restarts from the first page when the workspace changes between pages', async () => {
  let firstReads = 0;
  const {doc, restore} = await mountPage('meeting-list-keyset', {
    native: true,
    readList(query, options, json) {
      if (query.get('cursor')) {
        return json(200, {items: [{...meeting(OTHER_MEETING_ID), title: 'Stale page'}], cursor: null, activity_version: 'changed'});
      }
      firstReads += 1;
      return firstReads === 1
        ? json(200, {items: [meeting()], cursor: MEETING_ID, activity_version: 'before'})
        : json(200, {items: [{...meeting(OTHER_MEETING_ID), title: 'Fresh page'}], cursor: null, activity_version: 'changed'});
    },
  });
  const ele = id => doc.getElementById(id);
  try {
    ele('meeting-title').value = 'Draft title';
    await ele('meeting-list-more').handlers.click[0]();
    assert.equal(firstReads, 2);
    assert.deepEqual(ele('meeting-list').children.map(li => li.children[0].children[0].textContent), ['Fresh page']);
    assert.equal(ele('meeting-list-status').textContent, '会议列表已更新。');
    assert.equal(ele('meeting-title').value, 'Draft title');
  } finally {
    restore();
  }
});

test('the mobile list return parks rather than replacing a meeting draft', async () => {
  const {doc, state, restore} = await mountPage('meeting-mobile-park', {mobile: true});
  const ele = id => doc.getElementById(id);
  try {
    ele('new-meeting').handlers.click[0]();
    ele('meeting-title').value = 'Unsent meeting';
    ele('meeting-back-to-list').handlers.click[0]();
    assert.equal(ele('meeting-layout').dataset.view, 'catalogue');
    assert.equal(ele('meeting-resume').hidden, false);
    ele('meeting-resume').click();
    assert.equal(ele('meeting-layout').dataset.view, 'editor');
    assert.equal(ele('meeting-title').value, 'Unsent meeting');
    assert.equal(state.posted.length, 0);
  } finally {
    restore();
  }
});
