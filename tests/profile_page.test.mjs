import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHandle, parseTags } from '../openteamily/static/profile/app.mjs';

test('sanitizeHandle derives a lowercase dotted handle', () => {
  assert.equal(sanitizeHandle('Alice'), 'alice');
  assert.equal(sanitizeHandle('Alice Smith'), 'alice.smith');
  assert.equal(sanitizeHandle('a'), 'auser');
  assert.equal(sanitizeHandle('...'), 'user');
  assert.equal(sanitizeHandle('A..B'), 'a.b');
  assert.equal(sanitizeHandle('x'.repeat(40)).length, 30);
  assert.equal(sanitizeHandle(''), 'user');
});

test('parseTags splits, dedupes and bounds tags', () => {
  assert.deepEqual(parseTags('产品, 旅行，产品'), ['产品', '旅行']);
  assert.deepEqual(parseTags(''), []);
  assert.equal(parseTags('t1,t2,t3,t4,t5,t6,t7,t8,t9').length, 8);
  assert.equal(parseTags('x'.repeat(30))[0].length, 20);
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.hidden = true;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.href = '';
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
}

const PROFILE_FIELDS = ['name', 'handle', 'bio', 'tags', 'gender', 'location', 'website'];

function fakeDocument() {
  const elements = new Map();
  return {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement(id === 'profile-form' ? 'form' : 'div');
        if (id === 'profile-form') {
          element.elements = {};
          for (const name of PROFILE_FIELDS) element.elements[name] = new FakeElement('input');
        }
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function installGlobals(doc, fetcher) {
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  return () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
  };
}

async function mountProfile(options = {}) {
  const doc = fakeDocument();
  const calls = [];
  let release = () => {};
  let releasePost = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const postGate = new Promise(resolve => { releasePost = resolve; });
  const profileCalls = () => calls.filter(([path]) => path === '/v1/profile').length;
  const postCalls = () => calls.filter(([path, method]) => path === '/v1/profile' && method === 'POST').length;
  const fetcher = async (path, init) => {
    calls.push([path, init && init.method]);
    if (path === '/v1/auth/session') {
      return {status: 200, json: async () => ({user: {username: 'alice'}})};
    }
    if (path !== '/v1/profile') throw new Error('unexpected ' + path);
    if (init && init.method === 'POST') {
      if (options.holdPost) await postGate;
      if (options.post409) {
        return {status: 409, json: async () => ({error: {
          message: 'Profile changed elsewhere; reload and retry',
          current: {name: 'Alicia', handle: 'alice', revision: 4},
        }})};
      }
      return {status: 200, json: async () => ({profile: {name: 'Alice', handle: 'alice', revision: 4}})};
    }
    if (profileCalls() > 1) {
      if (options.holdRepeat) await gate;
      if (options.failRepeat) return {status: 500, json: async () => ({error: {message: options.failRepeat}})};
    }
    const name = profileCalls() > 1 && options.repeatName ? options.repeatName : 'Alice';
    return {status: 200, json: async () => ({profile: {name, handle: 'alice', revision: 3}})};
  };
  const restore = installGlobals(doc, fetcher);
  await import('../openteamily/static/profile/app.mjs?dom=' + (options.tag || 'profile'));
  await flush();
  return {doc, calls, profileCalls, postCalls, release, releasePost, restore};
}

function clickHandler(doc) {
  const button = doc.getElementById('profile-reload');
  assert.equal(Array.isArray(button.handlers.click) && button.handlers.click.length, 1,
    'the 重新加载 button has no click handler, so clicking it does nothing');
  return button;
}

test('重新加载 re-reads the profile and re-renders the form', async () => {
  const {doc, profileCalls, restore} = await mountProfile({tag: 'reload', repeatName: 'Alicia'});
  try {
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alice');
    assert.equal(profileCalls(), 1);
    const button = clickHandler(doc);
    await button.handlers.click[0]({preventDefault() {}});
    assert.equal(profileCalls(), 2);
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alicia');
    assert.equal(button.disabled, false);
  } finally { restore(); }
});

test('重新加载 disables itself while the request is in flight and does not stack', async () => {
  const {doc, profileCalls, release, restore} = await mountProfile({tag: 'inflight', holdRepeat: true});
  try {
    const button = clickHandler(doc);
    const pending = button.handlers.click[0]({preventDefault() {}});
    await flush();
    assert.equal(button.disabled, true);
    await button.handlers.click[0]({preventDefault() {}});
    await flush();
    assert.equal(profileCalls(), 2);
    release();
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(profileCalls(), 2);
  } finally { restore(); }
});

test('a failed 重新加载 keeps the page status and re-enables the button', async () => {
  const {doc, profileCalls, restore} = await mountProfile({tag: 'failure', failRepeat: '无法读取资料。'});
  try {
    const button = clickHandler(doc);
    await button.handlers.click[0]({preventDefault() {}});
    assert.equal(profileCalls(), 2);
    assert.equal(doc.getElementById('status').dataset.kind, 'error');
    assert.equal(doc.getElementById('status').textContent, '无法读取资料。');
    assert.equal(button.disabled, false);
  } finally { restore(); }
});

function submitHandler(doc) {
  const form = doc.getElementById('profile-form');
  assert.ok(Array.isArray(form.handlers.submit) && form.handlers.submit.length >= 1,
    'the profile form has no submit handler');
  return form.handlers.submit[0];
}

test('连点两次保存只发一次 POST /v1/profile 且按钮在飞时 disabled', async () => {
  const {doc, postCalls, releasePost, restore} = await mountProfile({tag: 'save-double', holdPost: true});
  try {
    const submit = submitHandler(doc);
    const save = doc.getElementById('profile-save');
    const first = submit({preventDefault() {}});
    await flush();
    const second = submit({preventDefault() {}});
    await flush();
    try {
      assert.equal(postCalls(), 1, 'a second click while the first POST is in flight must not send another request');
      assert.equal(save.disabled, true, 'the save button should be disabled while the POST is in flight');
    } finally { releasePost(); }
    await Promise.all([first, second]);
    assert.equal(save.disabled, false, 'the save button should be enabled again after the POST settles');
    assert.equal(postCalls(), 1);
  } finally { restore(); }
});

test('a 409 save shows a Chinese status line instead of the server English text', async () => {
  const {doc, restore} = await mountProfile({tag: 'save-409', post409: true});
  try {
    await submitHandler(doc)({preventDefault() {}});
    const status = doc.getElementById('status');
    assert.equal(status.dataset.kind, 'error');
    assert.equal(status.textContent, '资料已在别处更新，已重新加载。');
    assert.equal(doc.getElementById('profile-form').elements.name.value, 'Alicia',
      'the 409 payload should still refill the form with the current profile');
  } finally { restore(); }
});
