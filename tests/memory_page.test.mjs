import assert from 'node:assert/strict';
import {mount} from '../openteamily/static/memory/app.mjs';
import test from 'node:test';
import {actionQuery, applyDirectoryCollapsed, bindGraphNodeGestures, csrfCookie, directoryGroups, dueAtFromDate, dueDateValue, fillGraphHoverCard, formatTopics, applyMarkdown, graphHoverAllowed, graphLayout, graphPreviewModel, hideGraphHoverCard, listQuery, matchingMemoryPages, MEMORY_EMPTY_NO_MATCH, MEMORY_EMPTY_WORKSPACE, memoryPageFromSearch, memoryPageMeta, memoryPagePreview, memoryUpdatedLabel, parseTopics, queryForMemoryPage, showGraphHoverCard, topicTag} from '../openteamily/static/memory/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('matchingMemoryPages filters titles in place without inventing body search', () => {
  const rows = [
    {id: 'a', title: '项目简报'},
    {id: 'b', title: '运维手册'},
    {id: 'c', title: 'Project Brief'},
  ];
  assert.deepEqual(matchingMemoryPages(rows, '').map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(matchingMemoryPages(rows, '运维').map((row) => row.title), ['运维手册']);
  assert.deepEqual(matchingMemoryPages(rows, '简报').map((row) => row.title), ['项目简报']);
  assert.deepEqual(matchingMemoryPages(rows, 'BRIEF').map((row) => row.title), ['Project Brief']);
  assert.equal(MEMORY_EMPTY_WORKSPACE, '这个工作区还没有记忆页。');
  assert.equal(MEMORY_EMPTY_NO_MATCH, '没有匹配的记忆页。试试其他关键词。');
});

test('listQuery and actionQuery encode filters and omit empty values', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('brief'), '?q=brief');
  assert.equal(actionQuery('', 'open'), '?status=open');
  assert.equal(actionQuery('跟进', 'done'), '?q=%E8%B7%9F%E8%BF%9B&status=done');
  assert.equal(actionQuery('', ''), '');
});

test('due date helpers convert UTC calendar days', () => {
  assert.equal(dueAtFromDate(''), null);
  assert.equal(dueAtFromDate('2027-01-15'), Date.UTC(2027, 0, 15) / 1000);
  assert.equal(dueDateValue(Date.UTC(2027, 0, 15) / 1000), '2027-01-15');
  assert.equal(dueDateValue(null), '');
  assert.equal(dueDateValue('bad'), '');
});

test('parseTopics splits unique names and formatTopics joins them', () => {
  assert.deepEqual(parseTopics('Getting Started, wiki，Getting started'), ['Getting Started', 'wiki']);
  assert.equal(formatTopics(['Getting Started', 'wiki']), 'Getting Started，wiki');
  assert.equal(formatTopics([]), '');
});

test('graphLayout places a single node at the center and sorts a circle by id', () => {
  assert.deepEqual(graphLayout([]), []);
  assert.deepEqual(graphLayout([{id: 'b'}], 200, 100), [{id: 'b', x: 100, y: 50}]);
  const placed = graphLayout([{id: 'm2'}, {id: 'm1'}], 200, 200, 50);
  assert.equal(placed[0].id, 'm1');
  assert.equal(placed[1].id, 'm2');
  assert.equal(placed[0].x, 100);
  assert.equal(placed[0].y, 50);
  assert.equal(placed[1].x, 100);
  assert.equal(placed[1].y, 150);
});

test('memoryPageFromSearch and queryForMemoryPage stay on the recorded allowlist', () => {
  assert.equal(memoryPageFromSearch(''), 'overview');
  assert.equal(memoryPageFromSearch('?page=profile'), 'profile');
  assert.equal(memoryPageFromSearch('?page=todos'), 'actions');
  assert.equal(memoryPageFromSearch('?page=unknown'), 'overview');
  assert.equal(queryForMemoryPage('overview'), '');
  assert.equal(queryForMemoryPage('profile'), '?page=profile');
  assert.equal(queryForMemoryPage('actions'), '?page=todos');
  assert.equal(memoryPageFromSearch('?page=meetings'), 'overview');
  assert.equal(queryForMemoryPage('meetings'), '');
});

test('memoryUpdatedLabel uses a UTC calendar date and ignores bad values', () => {
  assert.equal(memoryUpdatedLabel(''), '');
  assert.equal(memoryUpdatedLabel(null), '');
  assert.equal(memoryUpdatedLabel('bad'), '');
  assert.equal(memoryUpdatedLabel(Date.UTC(2026, 10, 17) / 1000), '2026-11-17');
});

test('topicTag and memoryPageMeta render date plus hash tags without inventing a 新 badge', () => {
  assert.equal(topicTag(''), '');
  assert.equal(topicTag('  wiki  '), '#wiki');
  assert.equal(topicTag('#already'), '#already');
  assert.equal(memoryPageMeta({}), '');
  assert.equal(
    memoryPageMeta({updated: Date.UTC(2026, 10, 17) / 1000, topics: ['CI fixture', '#keep']}),
    '2026-11-17 · #CI fixture · #keep',
  );
  assert.equal(memoryPagePreview({}), '');
  assert.equal(memoryPagePreview({preview: '  First line of the page.  '}), 'First line of the page.');
});

test('directoryGroups clusters real topics and leaves untagged pages loose', () => {
  const pages = [
    {id: 'a', title: 'Alpha notes', topics: ['Work notes']},
    {id: 'b', title: 'Beta plan', topics: ['Work notes', 'Planning']},
    {id: 'c', title: 'Loose page', topics: []},
    {id: 'd', title: 'Planner', topics: ['Planning']},
  ];
  const grouped = directoryGroups(pages, [
    {name: 'Work notes', pages: [{id: 'a'}, {id: 'b'}], page_count: 2},
    {name: 'Planning', pages: [{id: 'b'}, {id: 'd'}], page_count: 2},
    {name: 'Empty leftover', pages: [{id: 'missing'}], page_count: 1},
  ]);
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['c']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Work notes', 2, ['a', 'b']],
    ['Planning', 2, ['b', 'd']],
  ]);
  assert.equal(grouped.groups.some((group) => group.name === 'Getting Started' || group.name === 'Empty leftover'), false);
});

test('directoryGroups still groups from page topics when the catalog is empty', () => {
  const grouped = directoryGroups(
    [{id: 'n1', title: 'Solo', topics: ['Planning']}, {id: 'n2', title: 'Other'}],
    [],
  );
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['n2']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Planning', 1, ['n1']],
  ]);
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
  el('memory-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['memory-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['memory-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

test('graphPreviewModel uses title, existing preview and topic tags', () => {
  assert.deepEqual(graphPreviewModel({}), {title: '', summary: '', tags: []});
  assert.deepEqual(
    graphPreviewModel({title: ' Welcome ', preview: '  First line.  ', topics: ['CI fixture', '#keep']}),
    {title: 'Welcome', summary: 'First line.', tags: ['#CI fixture', '#keep']},
  );
});

test('graphHoverAllowed hides the card on coarse pointers and 390-wide viewports', () => {
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 1440}), true);
  assert.equal(graphHoverAllowed({pointerCoarse: true, viewportWidth: 1440}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 390}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 389}), false);
});

function hoverCard() {
  const child = (className) => {
    const node = {className, textContent: '', hidden: false};
    return node;
  };
  const title = child('graph-hover-title');
  const summary = child('graph-hover-summary');
  const tags = child('graph-hover-tags');
  const map = {
    '.graph-hover-title': title,
    '.graph-hover-summary': summary,
    '.graph-hover-tags': tags,
  };
  return {
    hidden: true,
    style: {},
    attributes: {},
    title,
    summary,
    tags,
    querySelector(sel) { return map[sel] || null; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    removeAttribute(key) { delete this.attributes[key]; },
  };
}

function gestureTarget() {
  const listeners = {};
  return {
    attributes: {},
    listeners,
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      const payload = {key: event.key, preventDefault() {}, ...event};
      for (const fn of listeners[type] || []) fn(payload);
    },
  };
}

test('fillGraphHoverCard writes title, summary and tags and can hide empty rows', () => {
  const card = hoverCard();
  fillGraphHoverCard(card, {title: 'Alpha', summary: 'Hello', tags: ['#wiki']});
  assert.equal(card.title.textContent, 'Alpha');
  assert.equal(card.summary.textContent, 'Hello');
  assert.equal(card.summary.hidden, false);
  assert.equal(card.tags.textContent, '#wiki');
  fillGraphHoverCard(card, {title: 'Alpha', summary: '', tags: []});
  assert.equal(card.summary.hidden, true);
  assert.equal(card.tags.hidden, true);
});

test('bindGraphNodeGestures keeps click-to-open and adds dblclick and Enter', () => {
  const opened = [];
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p1', title: 'Alpha'}, {openPage: (id) => opened.push(id), hoverAllowed: false});
  assert.equal(target.getAttribute('tabindex'), '0');
  assert.equal(target.getAttribute('role'), 'button');
  assert.equal(target.getAttribute('aria-label'), 'Alpha');
  target.dispatch('click');
  target.dispatch('dblclick');
  target.dispatch('keydown', {key: 'Enter'});
  assert.deepEqual(opened, ['p1', 'p1', 'p1']);
});

test('bindGraphNodeGestures shows a hover card after the delay and hides it on leave or Escape', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p2', title: 'Beta', preview: 'Summary text', topics: ['wiki']}, {
    openPage() {},
    card,
    hoverAllowed: true,
    delayMs: 0,
    position: {left: 12, top: 24},
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  assert.equal(card.getAttribute('data-id'), 'p2');
  assert.equal(card.title.textContent, 'Beta');
  assert.equal(card.summary.textContent, 'Summary text');
  assert.equal(card.tags.textContent, '#wiki');
  assert.equal(card.style.left, '12px');
  assert.equal(card.style.top, '24px');
  target.dispatch('pointerleave');
  assert.equal(card.hidden, true);
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  target.dispatch('keydown', {key: 'Escape'});
  assert.equal(card.hidden, true);
});

test('bindGraphNodeGestures does not open a hover card when hover is not allowed', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p3', title: 'Gamma', preview: 'Nope'}, {
    openPage() {},
    card,
    hoverAllowed: false,
    delayMs: 0,
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, true);
  assert.equal(card.getAttribute('data-id'), undefined);
});

// The 「偏好」 block sits in the 我的资料 view and keeps its rows in local
// page state: adding and deleting must change the list without any request.

class PrefElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.options = [];
    this.elements = {};
    this.focused = false;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    if (this.tagName === 'SELECT') {
      this.options = this.children;
      if (!this.value && this.children[0]) this.value = this.children[0].value;
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelector(selector) {
    return this.children.find((child) => child.attributes.class === selector || child.className === selector) || null;
  }
  getBoundingClientRect() { return {left: 0, top: 0, width: 0, height: 0}; }
  focus() { this.focused = true; }
  click() { if (this.handlers.click) this.handlers.click({target: this, preventDefault() {}}); }
}

function prefDocument() {
  const elements = new Map();
  const body = new PrefElement('body');
  const doc = {
    cookie: '',
    body,
    defaultView: {location: {pathname: '/memory', search: '?page=profile'}, history: {replaceState() {}}},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'action-filter' || id === 'new-action-page' || id === 'link-target' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'search' || id === 'topic-search' ? 'input'
          : id === 'graph-canvas' || id === 'graph-hover-card' ? 'svg'
          : 'div';
        const el = new PrefElement(tag);
        if (id === 'editor-form') {
          el.hidden = true;
          el.elements = {title: new PrefElement('input'), body: new PrefElement('textarea'), topics: new PrefElement('input')};
        }
        if (id === 'action-editor-form') {
          el.hidden = true;
          el.elements = {
            title: new PrefElement('input'), notes: new PrefElement('textarea'),
            status: new PrefElement('select'), due: new PrefElement('input'),
            memory_page_id: new PrefElement('select'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new PrefElement(tag); },
    createElementNS(_ns, tag) { return new PrefElement(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const prefFlush = () => new Promise((resolve) => setImmediate(resolve));
const prefSettle = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await prefFlush();
};
const prefJson = (status, body) => ({status, json: async () => body});

function prefFetcher(calls) {
  return async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET'});
    if (path === '/v1/auth/session') return prefJson(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/settings') return prefJson(404, {});
    if (path === '/v1/workspaces') return prefJson(200, {items: [{id: 'ws-1', name: 'Desk', owner_id: 'user-1'}]});
    if (path === '/v1/workspaces/ws-1/memory') return prefJson(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/actions') return prefJson(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') {
      return prefJson(200, {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
    }
    if (path === '/v1/workspaces/ws-1/memory/profile') {
      return prefJson(200, {profile: {revision: 0, professional: '', work_style: '', communication: ''}});
    }
    throw new Error('unexpected ' + path);
  };
}

async function mountPreferences() {
  const {doc, el} = prefDocument();
  const calls = [];
  await mount(doc, {fetcher: prefFetcher(calls)});
  await prefSettle();
  return {doc, el, calls};
}

test('the 偏好 block starts empty and says how to fill it', async () => {
  const {el, calls} = await mountPreferences();
  assert.equal(el('profile-panel').hidden, false);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preferences-empty').textContent, '还没有偏好，加一条试试');
  assert.equal(el('preference-list').children.length, 0);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('adding a preference appends one row, clears the field and hides the empty state', async () => {
  const {el, calls} = await mountPreferences();
  el('preference-input').value = '回复用中文';
  el('add-preference').click();
  assert.equal(el('preference-list').children.length, 1);
  const row = el('preference-list').children[0];
  assert.equal(row.children[0].textContent, '回复用中文');
  assert.equal(row.children[1].textContent, '删除');
  assert.equal(el('preferences-empty').hidden, true);
  assert.equal(el('preference-input').value, '');
  assert.equal(el('preference-status').textContent, '已添加偏好。');
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('an empty preference is not added and the status line says why', async () => {
  const {el} = await mountPreferences();
  el('preference-input').value = '   ';
  el('add-preference').click();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '请先写一条偏好。');
});

test('deleting removes only that preference and brings the empty state back', async () => {
  const {el, calls} = await mountPreferences();
  for (const text of ['回复用中文', '会议纪要控制在 200 字']) {
    el('preference-input').value = text;
    el('add-preference').click();
  }
  assert.equal(el('preference-list').children.length, 2);
  el('preference-list').children[0].children[1].click();
  assert.equal(el('preference-list').children.length, 1);
  assert.equal(el('preference-list').children[0].children[0].textContent, '会议纪要控制在 200 字');
  assert.equal(el('preferences-empty').hidden, true);
  el('preference-list').children[0].children[1].click();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '已删除偏好。');
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('applyMarkdown wraps or prefixes the selected textarea text', () => {
  const area = {value: 'hello world', selectionStart: 0, selectionEnd: 5, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(area, 'bold'), '**hello** world');
  const empty = {value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(empty, 'h1'), '# 标题');
  const link = {value: 'docs', selectionStart: 0, selectionEnd: 4, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(link, 'link'), '[docs](https://)');
});
