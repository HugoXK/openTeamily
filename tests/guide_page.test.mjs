import assert from 'node:assert/strict';
import test from 'node:test';
import * as guideModule from '../openteamily/static/guide/app.mjs';
import {CATALOG, CATEGORIES, countByCategory, filterCatalog, formatPath, groupCatalog, guideHref, guideInitialQuery} from '../openteamily/static/guide/app.mjs';

test('catalog only contains known categories and no Teamily guide prose', () => {
  const ids = new Set(CATEGORIES.map((item) => item.id));
  assert.ok(ids.has('calls'));
  assert.equal(CATALOG.some((item) => item.title.includes('折叠会话列表') || (item.body || '').includes('再次点击')), false);
  for (const item of CATALOG) {
    assert.ok(ids.has(item.category), item.category);
    assert.ok(item.title);
    assert.ok(item.body);
    assert.ok(Array.isArray(item.path) && item.path.length > 0);
  }
});

test('countByCategory totals every item and keeps an empty calls category', () => {
  const counts = countByCategory(CATALOG);
  assert.equal(counts.all, CATALOG.length);
  assert.equal(counts.calls, 0);
  assert.ok(counts.chat >= 1);
  const named = CATEGORIES.filter((item) => item.id !== 'all').reduce((sum, item) => sum + (counts[item.id] || 0), 0);
  assert.equal(named, counts.all);
});

test('filterCatalog matches title, body, path and category', () => {
  assert.deepEqual(filterCatalog(CATALOG, {category: 'calls'}).map((item) => item.id), []);
  const chat = filterCatalog(CATALOG, {category: 'chat'});
  assert.ok(chat.every((item) => item.category === 'chat'));
  const found = filterCatalog(CATALOG, {query: 'flybot.pyz'});
  assert.deepEqual(found.map((item) => item.id), ['download-runtime']);
  const pathHit = filterCatalog(CATALOG, {query: '收起侧边栏'});
  assert.ok(pathHit.some((item) => item.id === 'memory-dir-collapse'));
  assert.ok(filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'}).length === 0);
});

test('groupCatalog preserves category order and formatPath joins crumbs', () => {
  const grouped = groupCatalog(filterCatalog(CATALOG, {category: 'all'}));
  assert.equal(grouped[0].id, CATALOG[0].category);
  assert.ok(grouped.every((group) => group.items.length > 0));
  assert.equal(formatPath(['设置', '外观']), '设置 › 外观');
  assert.equal(formatPath([]), '');
});

test('the guide deep link round-trips the keyword through the query string', () => {
  assert.equal(guideHref('外观'), '/guide?q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('  '), '/guide');
  assert.equal(guideHref(''), '/guide');
  assert.equal(guideInitialQuery('?q=%E5%A4%96%E8%A7%82'), '外观');
  assert.equal(guideInitialQuery('?x=1'), '');
  assert.equal(guideInitialQuery(''), '');
  assert.deepEqual(filterCatalog(CATALOG, {category: 'settings', query: '外观'}).map((item) => item.id), ['settings-hub', 'settings-appearance']);
  assert.deepEqual(filterCatalog(CATALOG, {query: '日出日落'}).map((item) => item.id), ['settings-appearance']);
});

test('the empty state names an empty category instead of blaming a search', () => {
  const {emptyGuideMessage} = guideModule;
  assert.equal(typeof emptyGuideMessage, 'function', 'the guide page cannot tell an empty category from a fruitless search');
  const emptyCategory = filterCatalog(CATALOG, {category: 'calls'});
  assert.deepEqual(emptyCategory, []);
  assert.equal(emptyGuideMessage(emptyCategory, ''), '这一类还没有指引。');
  assert.equal(emptyGuideMessage(emptyCategory, '   '), '这一类还没有指引。');
  const noHits = filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'});
  assert.deepEqual(noHits, []);
  assert.equal(emptyGuideMessage(noHits, 'xyz-not-a-feature'), '没有匹配的指引。');
  assert.equal(emptyGuideMessage(filterCatalog(CATALOG, {category: 'chat'}), ''), '');
});

test('the guide deep link carries the category as well as the keyword', () => {
  assert.equal(typeof guideModule.guideInitialCategory, 'function',
    'the guide page never reads ?category= back from the URL');
  const initial = guideModule.guideInitialCategory;
  assert.equal(initial('?category=calls'), 'calls');
  assert.equal(initial('?category=settings&q=%E5%A4%96%E8%A7%82'), 'settings');
  assert.equal(initial('?category=not-a-category'), 'all');
  assert.equal(initial('?category='), 'all');
  assert.equal(initial('?q=%E5%A4%96%E8%A7%82'), 'all');
  assert.equal(initial(''), 'all');
  assert.equal(guideHref('', 'calls'), '/guide?category=calls');
  assert.equal(guideHref('', 'all'), '/guide');
  assert.equal(guideHref('外观', 'settings'), '/guide?category=settings&q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('外观', 'all'), '/guide?q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('', 'not-a-category'), '/guide');
});

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.elements = undefined;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  removeAttribute(key) {
    delete this.attributes[key];
  }

  addEventListener(key, handler) {
    this.handlers[key] = handler;
  }

  querySelectorAll() {
    return [];
  }

  focus() {}

  reset() {}
}

function fakeGuideDocument() {
  const elements = new Map();
  const doc = {
    cookie: '',
    readyState: 'complete',
    body: new FakeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) {
        const el = new FakeElement(id.endsWith('-form') ? 'form' : 'div');
        if (id.endsWith('-form')) {
          el.elements = {username: new FakeElement('input'), password: new FakeElement('input')};
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createElementNS(_namespace, tag) { return new FakeElement(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

test('a category deep link selects its chip and narrows the list', async () => {
  const {doc, el} = fakeGuideDocument();
  const replaced = [];
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.location = {pathname: '/guide', search: '?category=calls'};
  globalThis.history = {replaceState: (...args) => replaced.push(args)};
  globalThis.fetch = async (path) => (path === '/v1/auth/session'
    ? {status: 200, json: async () => ({user: {id: 'user-1', username: 'alice'}})}
    : {status: 404, json: async () => ({error: {message: 'missing'}})});
  try {
    await import('../openteamily/static/guide/app.mjs?category=calls');
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const chips = el('guide-categories').children;
    const selected = chips.filter((chip) => chip.attributes['aria-current'] === 'true')
      .map((chip) => chip.dataset.category);
    assert.deepEqual(selected, ['calls'], 'the calls chip is not the current category');
    assert.equal(el('guide-list').children.length, 0, 'the list still shows other categories');
    assert.equal(el('guide-count').textContent, '当前显示 0 条');
    assert.equal(el('guide-empty').hidden, false);
    assert.equal(el('guide-empty').textContent, '这一类还没有指引。');
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
    globalThis.history = previous.history;
    globalThis.fetch = previous.fetch;
  }
});

async function mountGuide(search) {
  const {doc, el} = fakeGuideDocument();
  const replaced = [];
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
  };
  globalThis.document = doc;
  globalThis.location = {pathname: '/guide', search};
  globalThis.history = {replaceState: (...args) => replaced.push(args)};
  globalThis.fetch = async (path) => (path === '/v1/auth/session'
    ? {status: 200, json: async () => ({user: {id: 'user-1', username: 'alice'}})}
    : {status: 404, json: async () => ({error: {message: 'missing'}})});
  await import(`../openteamily/static/guide/app.mjs?mount=${encodeURIComponent(search)}`);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const chip = (id) => el('guide-categories').children.find((item) => item.dataset.category === id);
  return {
    el,
    replaced,
    chip,
    currentCategory: () => el('guide-categories').children
      .filter((item) => item.attributes['aria-current'] === 'true')
      .map((item) => item.dataset.category),
    restore() {
      globalThis.document = previous.document;
      globalThis.location = previous.location;
      globalThis.history = previous.history;
      globalThis.fetch = previous.fetch;
    },
  };
}

test('clicking a category chip writes the category into the URL', async () => {
  const page = await mountGuide('');
  try {
    page.chip('calls').handlers.click();
    assert.equal(page.replaced.length, 1, 'clicking a category chip never updated the URL');
    assert.equal(page.replaced[0][2], '/guide?category=calls',
      'the category chip did not put ?category= into the URL');
    assert.deepEqual(page.currentCategory(), ['calls']);
  } finally {
    page.restore();
  }
});

test('clicking a category chip keeps the keyword in the URL too', async () => {
  const page = await mountGuide('?q=%E5%A4%96%E8%A7%82');
  try {
    assert.equal(page.el('guide-search').value, '外观');
    page.chip('settings').handlers.click();
    assert.equal(page.replaced.length, 1, 'clicking a category chip never updated the URL');
    assert.equal(page.replaced[0][2], '/guide?category=settings&q=%E5%A4%96%E8%A7%82',
      'the chip click dropped the keyword or the category from the URL');
    assert.deepEqual(page.currentCategory(), ['settings']);
  } finally {
    page.restore();
  }
});
