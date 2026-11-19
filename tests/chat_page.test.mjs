import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeSessions, SEARCH_TABS, initial, chatIdentity, applyChatIdentity, composeSelectedLabel, filterMemberChoices, composeCreateEnabled, composeGroupPayload, GROUP_CREATE_INTRO, GROUP_CREATE_MODES, mount, messageSearchQuery, homepageStartIndex, stripHomepageStartQuery } from '../openteamily/static/chat/app.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('initial uses the first letter or digit and skips leading punctuation', () => {
  assert.equal(initial('Helper'), 'H');
  assert.equal(initial('产品群'), '产');
  assert.equal(initial('[CI FIXTURE] Directory assistant'), 'C');
  assert.equal(initial('...'), '?');
  assert.equal(initial(''), '?');
});

test('chatIdentity shows a letter avatar only for a real conversation title', () => {
  assert.deepEqual(chatIdentity('Directory assistant'), {
    title: 'Directory assistant', initial: 'D', showAvatar: true,
  });
  assert.deepEqual(chatIdentity('  '), {title: '聊天', initial: '', showAvatar: false});
  assert.deepEqual(chatIdentity('聊天'), {title: '聊天', initial: '', showAvatar: false});
  const document = {
    nodes: {
      'chat-title': {textContent: ''},
      'chat-avatar': {textContent: '', hidden: true},
    },
    getElementById(id) { return this.nodes[id]; },
  };
  applyChatIdentity(document, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-title'].textContent, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-avatar'].textContent, 'C');
  assert.equal(document.nodes['chat-avatar'].hidden, false);
  applyChatIdentity(document, '聊天');
  assert.equal(document.nodes['chat-avatar'].hidden, true);
  assert.equal(document.nodes['chat-avatar'].textContent, '');
});

test('SEARCH_TABS lists the recorded search scopes', () => {
  assert.deepEqual(SEARCH_TABS.map((entry) => entry[1]), [
    '全部', 'Artifacts', '联系人', '群组', '智能体', '消息', '文件', '云文档', '媒体', '链接',
  ]);
});

test('mergeSessions combines agent and social rows without inventing pins', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.source, row.id, row.title]), [
    ['social', 's1', 'bob'],
    ['social', 's2', '产品群'],
    ['agent', 'c1', 'Helper'],
  ]);
  assert.equal(sessions.every((row) => !row.pinned), true);
  assert.deepEqual(sessions.map((row) => row.preview), [
    '单聊 · 2 人',
    '群聊 · 2 人',
    'Old thread',
  ]);
});

test('mergeSessions prefers a last-message preview from the listing', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', preview: 'Latest assistant reply', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', preview: '你好 Alice', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', preview: '', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.id, row.preview]), [
    ['s1', '你好 Alice'],
    ['s2', '群聊 · 2 人'],
    ['c1', 'Latest assistant reply'],
  ]);
});


test('messageSearchQuery adds only an explicit conversation scope and encodes keywords', async () => {
  const {messageSearchQuery} = await import('../openteamily/static/chat/app.mjs');
  const global = new URLSearchParams(messageSearchQuery('budget & 预算'));
  assert.equal(global.get('q'), 'budget & 预算');
  assert.equal(global.has('conversation_id'), false);
  const scoped = new URLSearchParams(messageSearchQuery('budget & 预算', 'a'.repeat(32)));
  assert.equal(scoped.get('conversation_id'), 'a'.repeat(32));
  assert.deepEqual([...scoped.keys()].sort(), ['conversation_id', 'limit', 'q']);
});


function keyEvent(overrides) {
  return {
    key: 'Enter',
    isComposing: false,
    keyCode: 13,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

test('shouldSendOnShortcut honors enter and Ctrl/Cmd+Enter bindings and ignores IME', async () => {
  const {shouldSendOnShortcut} = await import('../openteamily/static/chat/app.mjs');
  assert.equal(shouldSendOnShortcut(keyEvent(), 'enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({shiftKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({altKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({key: 'a'}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({isComposing: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({keyCode: 229}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true, shiftKey: true}), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'unknown'), true);
  assert.equal(shouldSendOnShortcut(null, 'enter'), false);
});

test('composeSelectedLabel reports the recorded selected count', () => {
  assert.equal(composeSelectedLabel(0), '已选 0');
  assert.equal(composeSelectedLabel(2), '已选 2');
});

test('filterMemberChoices matches usernames without inventing members', () => {
  const members = [
    {user_id: alice, username: 'alice'},
    {user_id: bob, username: 'bob'},
  ];
  assert.deepEqual(filterMemberChoices(members, alice, '').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'BO').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'zzz'), []);
});

test('composeCreateEnabled stays off until a custom-group selection exists', () => {
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 3}), false);
  assert.equal(composeCreateEnabled({composeMode: 'contact', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'contact', selectedCount: 0}), false);
});

test('composeGroupPayload omits a blank title so the existing API can default it', () => {
  assert.deepEqual(composeGroupPayload([bob], '  产品群  '), {
    kind: 'group', member_ids: [bob], title: '产品群',
  });
  assert.deepEqual(composeGroupPayload([bob], '   '), {kind: 'group', member_ids: [bob]});
});

test('group create chrome keeps the recorded labels and no billing copy', () => {
  assert.equal(GROUP_CREATE_INTRO, '添加名称，然后邀请好友并添加 AI 智能体。');
  assert.deepEqual(GROUP_CREATE_MODES, [
    ['custom', '自定义群组'],
    ['team', 'AI 智能体团队'],
  ]);
});

import {groupPickerChoices, groupAgentSummary} from '../openteamily/static/chat/app.mjs';

test('group picker distinguishes stored agents and people; contact picker omits agents', () => {
  const humans = [{user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}];
  const agents = [{id: 'helper', name: 'Helper'}, {id: 'old', name: 'Archived', archived: 1}];
  const choices = groupPickerChoices(humans, alice, agents);
  assert.deepEqual(choices.map(row => [row.id, row.kind]), [[bob, 'human'], ['helper', 'agent']]);
  assert.ok(choices[1].label.includes('AI 智能体（自动回复未接通）'));
  assert.deepEqual(groupPickerChoices(humans, alice).map(row => row.id), [bob]);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 1, selectedHumanCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 2, selectedHumanCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 2, selectedHumanCount: 1}), false);
  assert.deepEqual(composeGroupPayload([bob], '', ['helper']), {
    kind: 'group', member_ids: [bob], agent_ids: ['helper'],
  });
  assert.equal(groupAgentSummary({agent_members: []}), '');
  assert.ok(groupAgentSummary({agent_members: [{name: 'Helper'}]}).includes('Helper。可明确请求一次回复'));
});

import {groupReplyStatus} from '../openteamily/static/chat/app.mjs';
test('explicit group reply statuses distinguish pending, success and fixed errors', () => {
  assert.equal(groupReplyStatus({status: 'queued'}), '等待执行');
  assert.equal(groupReplyStatus({status: 'running'}), '执行中');
  assert.equal(groupReplyStatus({status: 'succeeded'}), '已完成');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'no_agent'}), '失败：没有可用运行时连接');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'timeout'}), '失败：执行超时');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'private diagnostic'}), '失败：请求失败');
});

test('the chat empty state offers two native links to /agents and /guide', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="chat-empty"');
  assert.ok(start > -1, 'the chat page has an empty state');
  const block = html.slice(start, html.indexOf('id="message-list"', start));
  assert.match(block, /<a href="\/agents">浏览智能体<\/a>/);
  assert.match(block, /<a href="\/guide">查看功能指引<\/a>/);
  assert.doesNotMatch(block, /<button[^>]*>帮助中心/, 'the next steps are links, not disabled buttons');
});

// These tests drive the real mount() with a stubbed two-page fetch, importing
// only symbols that exist on main today. On main the first page renders its 20
// hits and offers no way to reach the cursor page the server returned, and the
// query builder drops a cursor it is handed, so the assertions below fail as
// user-visible behaviour rather than as a missing export.

class FakeElement {
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
    this.name = '';
    this.href = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!names().includes(name)) element.className = [...names(), name].join(' ');
      },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter((item) => item !== handler);
  }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    if (selector === 'input:not(:disabled)') {
      return descendants(this).find((node) => node.tagName === 'INPUT' && !node.disabled) || null;
    }
    return null;
  }
}

function descendants(node) {
  const rows = [];
  for (const child of node.children) rows.push(child, ...descendants(child));
  return rows;
}

function matchesSelector(node, selector) {
  if (!node || !selector) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = /^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    const value = attr[3];
    const actual = attr[2].startsWith('data-')
      ? node.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      : node.attributes[attr[2]];
    if (value === undefined) return actual !== undefined && actual !== null && actual !== '';
    return actual === value;
  }
  return node.tagName === selector.toUpperCase();
}

// Ids, initial hidden state, labels and search tabs come from the served page,
// so the harness cannot invent a control the user would not have.
function fakeChatDocument(html) {
  const byId = new Map();
  const tabs = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (id) {
      const element = new FakeElement(tag);
      element.id = id[1];
      element.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      element.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
      byId.set(id[1], element);
    }
    const tab = /\bdata-search-tab="([^"]+)"/.exec(attrs);
    if (tab) {
      const element = new FakeElement('button');
      element.dataset.searchTab = tab[1];
      tabs.push(element);
    }
  }
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)<\/\1>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[2]);
    const label = match[3].trim();
    if (id && label && byId.has(id[1])) byId.get(id[1]).textContent = label;
  }
  const body = new FakeElement('body');
  const doc = {
    cookie: '',
    body,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '#search-panel [data-search-tab]') return tabs;
      return [];
    },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function json(status, body) { return {status, json: async () => body}; }

function searchHit(index) {
  const padded = String(index).padStart(2, '0');
  return {
    kind: 'agent',
    conversation_id: 'cv-' + padded,
    message_id: 'm-' + padded,
    title: '对话 ' + index,
    snippet: '片段 ' + index,
  };
}

function messagePage(start, count, cursor) {
  const items = [];
  for (let index = start; index < start + count; index += 1) items.push(searchHit(index));
  return {items, cursor};
}

function chatFetcher({failNext = false} = {}) {
  const requests = [];
  // Page two repeats the last hit of page one, so appending must not show it twice.
  const pages = [messagePage(1, 20, 'cursor-1'), messagePage(20, 20, '')];
  const fetcher = async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path.startsWith('/v1/workspaces/ws-1/search/messages?')) {
      if (failNext && /[?&]cursor=/.test(path)) throw new Error('无法加载更多。');
      const page = pages.shift();
      if (!page) throw new Error('unexpected search page: ' + path);
      return json(200, page);
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 16) {
  for (let index = 0; index < times; index += 1) await tick();
}

async function fire(node, type, event = {}) {
  for (const handler of (node.handlers && node.handlers[type]) || []) await handler(event);
}

function installChatGlobals({narrow = false} = {}) {
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.location = {hash: '', pathname: '/chat'};
  globalThis.history = {replaceState() {}};
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = (query) => ({matches: narrow && query === '(max-width: 900px)'});
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  };
}

function messageRowTitles(doc) {
  const results = doc.getElementById('search-results');
  const titles = [];
  for (const section of results.children) {
    const list = section.children.find((child) => child.tagName === 'UL');
    for (const row of (list ? list.children : [])) {
      const button = row.children[0];
      const title = button && button.children[0];
      if (title) titles.push(title.textContent);
    }
  }
  return titles;
}

// The user-facing entry to page two: a visible control labelled 加载更多, whether
// it lives beside the results or inside them.
function visibleLoadMoreLabels(doc) {
  const labels = [];
  const add = (node) => {
    if (node && !node.hidden) labels.push(String(node.textContent || '').trim());
  };
  add(doc.getElementById('search-more'));
  const visit = (node) => {
    if (!node) return;
    if (node.tagName === 'BUTTON' && String(node.textContent || '').trim() === '加载更多') add(node);
    for (const child of node.children || []) visit(child);
  };
  visit(doc.getElementById('search-results'));
  return labels;
}

async function openMessageSearch(doc, el, fetcher) {
  await mount(doc, {fetcher});
  await settle();
  assert.equal(el('workspace').value, 'ws-1', 'the fixture workspace is selected');
  const input = el('session-search');
  await fire(input, 'focus');
  input.value = '上周';
  await fire(input, 'input');
  await settle();
}

function chatHtml() {
  return readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
}

test('message search pages by cursor through a 加载更多 control instead of stopping at 20', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher();
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    const searchRequests = () => requests.filter((path) => path.includes('/search/messages?'));
    assert.equal(searchRequests().length, 1, 'the first query asks the server once');
    assert.match(searchRequests()[0], /[?&]limit=20(&|$)/, 'the first page asks for limit=20');
    assert.doesNotMatch(searchRequests()[0], /cursor=/, 'the first page has no cursor yet');

    const first = messageRowTitles(doc);
    assert.equal(first.length, 20, 'page one shows exactly the 20 hits the server returned');
    assert.equal(first[0], '对话 1');
    assert.equal(first[19], '对话 20');
    assert.deepEqual(
      visibleLoadMoreLabels(doc),
      ['加载更多'],
      'the server returned a cursor, so the 20 rendered rows must offer a way to reach page two',
    );

    await fire(el('search-more'), 'click');
    await settle();
    assert.equal(searchRequests().length, 2, 'clicking the control asks for the next page');
    assert.match(searchRequests()[1], /[?&]cursor=cursor-1(&|$)/, 'the second request carries the cursor');
    assert.match(searchRequests()[1], /[?&]limit=20(&|$)/, 'the page size stays 20');
    const appended = messageRowTitles(doc);
    assert.equal(appended.length, 39, 'the next page is appended once, without repeating the last row');
    assert.equal(appended[38], '对话 39');
    assert.deepEqual(visibleLoadMoreLabels(doc), [], 'an empty cursor hides the control again');
  } finally {
    restore();
  }
});

test('a failed next page keeps the rows already shown and leaves the control for a retry', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher({failNext: true});
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'page one still offers the next page');
    await fire(el('search-more'), 'click');
    await settle();
    assert.match(requests[requests.length - 1], /[?&]cursor=cursor-1(&|$)/);
    assert.equal(messageRowTitles(doc).length, 20, 'the rows already shown stay');
    assert.equal(doc.getElementById('search-empty').textContent, '无法加载更多。');
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'the cursor survives so the user can retry');
    assert.equal(el('search-more').disabled, false);
  } finally {
    restore();
  }
});

test('messageSearchQuery hands the next-page cursor to the server', () => {
  const first = new URLSearchParams(messageSearchQuery('上周'));
  assert.equal(first.get('limit'), '20', 'the page size stays 20');
  assert.equal(first.get('cursor'), null, 'the first page sends no cursor');

  const next = new URLSearchParams(messageSearchQuery('上周', alice, 'cursor-1'));
  assert.equal(next.get('limit'), '20', 'the page size stays 20');
  assert.equal(next.get('conversation_id'), alice);
  assert.equal(next.get('cursor'), 'cursor-1', 'a supplied cursor must reach the server, or page two is unreachable');
});

// Narrow screens show one pane at a time: the conversation list or the open
// conversation. The stylesheet keys that switch on `sessions-open`; these tests
// drive mount() and pin the class to the user's actual path through the page.

function sessionFetcher() {
  const aliceRow = {user_id: alice, username: 'alice'};
  const first = {
    id: 'conv-1', kind: 'dm', title: 'bob', updated: 30,
    members: [aliceRow, {user_id: bob, username: 'bob'}],
  };
  const second = {
    id: 'conv-2', kind: 'dm', title: 'carol', updated: 20,
    members: [aliceRow, {user_id: 'c'.repeat(32), username: 'carol'}],
  };
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') {
      return json(200, {items: [first, second]});
    }
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-1') {
      return json(200, {
        conversation: first,
        items: [{id: 'm-1', user_id: bob, body: '你好', created: '2026-01-01T00:00:00Z'}],
      });
    }
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-2') {
      return json(200, {conversation: second, items: []});
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher};
}

function sessionRows(el) {
  return el('conversation-list').children.map((li) => li.children[0]);
}

test('a narrow-screen chat starts on the conversation list and returns to it from the back control', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(sessionRows(el).length, 2, 'the fixture lists two conversations');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'no conversation is open yet, so the session list must be the pane the narrow stylesheet shows',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'opening a conversation must uncover it instead of leaving the list over it',
    );
    assert.equal(el('message-list').children.length, 1, 'the opened conversation renders its messages');

    assert.ok(el('chat-back'), 'the chat header offers a way back to the session list');
    await fire(el('chat-back'), 'click');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'the back control returns to the list so another conversation can be opened',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[1]});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), false, 'the second conversation opens the same way');
  } finally {
    restore();
  }
});

test('the 900px stylesheet restores the session pane for the sessions-open state', () => {
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const end = css.indexOf('}', css.indexOf('{', start)) > -1 ? css.indexOf('\n}', start) : -1;
  const block = css.slice(start, end);
  assert.match(
    block,
    /\.sessions-open\s*>\s*\.session-pane\s*\{\s*display:\s*flex/,
    'the rule that hides the pane at 900px needs a matching restore for the list state',
  );
});

test('the 900px stylesheet puts the chat panel back in the second column', () => {
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const block = css.slice(start, css.indexOf('\n}', start));
  for (const selector of ['#main', '#status']) {
    const rule = block.match(
      new RegExp(`body\\.app-workspace\\.chat-open\\s*>\\s*${selector}[^{]*\\{([^}]*)\\}`),
    );
    assert.ok(rule, `the two-column override at 900px must also move ${selector} out of column 3`);
    assert.match(
      rule[1],
      /grid-column:\s*2\b/,
      `${selector} is pinned to grid-column 3 by the shell stylesheet; without this the implicit third column collapses the session pane to its minimum`,
    );
  }
  // With the list shown, #main must leave the flow: otherwise it is auto-placed
  // in an implicit row below the pane and the 1fr row shrinks (pane 624px tall
  // instead of the full viewport).
  assert.match(
    block,
    /\.sessions-open\s*>\s*#main\s*\{\s*display:\s*none/,
    'the list state must hide the chat panel so the pane fills the viewport',
  );
});

test('a wide chat still opens the first conversation instead of stopping on the list', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'above 900px the list is shown beside the conversation, so no list state is applied',
    );
    assert.equal(el('message-list').children.length, 1, 'the first conversation still opens by default');
  } finally {
    restore();
  }
});

test('homepageStartIndex only accepts a 0-4 start query', () => {
  assert.equal(homepageStartIndex(''), null);
  assert.equal(homepageStartIndex('?q=1'), null);
  assert.equal(homepageStartIndex('?start=5'), null);
  assert.equal(homepageStartIndex('?start=-1'), null);
  assert.equal(homepageStartIndex('?start=abc'), null);
  assert.equal(homepageStartIndex('?start=0'), 0);
  assert.equal(homepageStartIndex('start=4'), 4);
  assert.equal(homepageStartIndex('?start=1&x=2'), 1);
});

test('stripHomepageStartQuery removes only the start parameter', () => {
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '?start=0', '#workspace=ws-1'),
    {changed: true, href: '/chat#workspace=ws-1'},
  );
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '?start=0&x=1', ''),
    {changed: true, href: '/chat?x=1'},
  );
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '', '#workspace=ws-1'),
    {changed: false, href: '/chat#workspace=ws-1'},
  );
});

test('a homepage start query opens the created conversation after a member starts it', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const calls = [];
  const conversation = {
    id: 'c'.repeat(32),
    workspace_id: 'ws-1',
    agent_id: 'a'.repeat(32),
    title: '列出这个助手能做什么',
  };
  const fetcher = async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET', body: options.body});
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') {
      return json(200, {items: [{id: conversation.agent_id, name: '文档助手'}]});
    }
    if (path === `/v1/workspaces/ws-1/agents/${conversation.agent_id}/conversations?limit=100`) {
      return json(200, {items: [conversation]});
    }
    if (path === `/v1/workspaces/ws-1/agents/${conversation.agent_id}/conversations/${conversation.id}`) {
      return json(200, {conversation, items: [
        {id: 'm1', role: 'user', body: '列出这个助手能做什么', status: 'succeeded'},
        {id: 'm2', role: 'assistant', body: '这是本地测试回复。', status: 'succeeded'},
      ]});
    }
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/agent-homepages/start') {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).quick_start, 0);
      assert.match(options.headers['Idempotency-Key'] || '', /^home-start-/);
      return json(201, {
        conversation,
        message: {id: 'm1', role: 'user', body: '列出这个助手能做什么'},
        reply: {id: 'm2', role: 'assistant', body: '这是本地测试回复。', status: 'succeeded'},
      });
    }
    throw new Error('unexpected ' + options.method + ' ' + path);
  };
  const history = [];
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
  };
  globalThis.location = {hash: '', pathname: '/chat', search: '?start=0'};
  globalThis.history = {
    replaceState(_state, _title, url) { history.push(String(url)); globalThis.location.hash = String(url).includes('#') ? '#' + String(url).split('#').pop() : ''; },
  };
  globalThis.addEventListener = () => {};
  try {
    await mount(doc, {fetcher});
    await settle();
    const startCalls = calls.filter((item) => item.path === '/v1/agent-homepages/start');
    assert.equal(startCalls.length, 1, 'the page should start once from the query');
    assert.equal(JSON.parse(startCalls[0].body).quick_start, 0);
    assert.match(history.join(' '), /conversation=/);
    assert.ok(history.some((url) => url.startsWith('/chat#') || url === '/chat' || !url.includes('start=')),
      'the start query should be removed after a successful start: ' + history.join(' | '));
    const list = el('message-list');
    const texts = [];
    const visit = (node) => {
      if (!node) return;
      if (node.textContent) texts.push(String(node.textContent));
      for (const child of node.children || []) visit(child);
    };
    visit(list);
    assert.ok(texts.some((text) => text.includes('列出这个助手能做什么')),
      'the started prompt should appear in the conversation: ' + texts.join(' | '));
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  }
});


test('message search tab switches await the in-flight query and newer queries win', async () => {
  const {createMessageSearch} = await import('../openteamily/static/chat/app.mjs');
  const resolvers = [];
  const search = createMessageSearch(() => new Promise(resolve => resolvers.push(resolve)));
  const first = search.load('old');
  const same = search.load('old');
  assert.equal(resolvers.length, 1, 'a tab switch reuses the pending search');
  resolvers[0]({items: [{kind: 'social', message_id: 'old', snippet: 'old'}]});
  await Promise.all([first, same]);
  assert.equal(search.state.hits.length, 1);
  const stale = search.load('stale');
  const latest = search.load('latest');
  resolvers[2]({items: [{kind: 'social', message_id: 'latest', snippet: 'latest'}]});
  await latest;
  resolvers[1]({items: [{kind: 'social', message_id: 'stale', snippet: 'stale'}]});
  await stale;
  assert.equal(search.state.hits[0].messageId, 'latest');
});

test('social sessions retain server unread counts without inventing agent unread state', () => {
  const rows = mergeSessions([], [{id: 'social-unread', kind: 'group', title: 'Group', unread_count: 3}], 'alice');
  assert.equal(rows[0].unread_count, 3);
});


for (const mode of ['visible', 'hidden', 'failed']) {
  test('social unread acknowledgement is snapshot bounded: ' + mode, async () => {
    const {doc, el} = fakeChatDocument(chatHtml());
    const {fetcher: original} = sessionFetcher();
    const posts = [];
    doc.visibilityState = mode === 'hidden' ? 'hidden' : 'visible';
    const fetcher = async (path, options = {}) => {
      if (path.endsWith('/conv-1/read')) {
        posts.push(JSON.parse(options.body));
        return json(mode === 'failed' ? 500 : 200, {unread_count: 1});
      }
      const result = await original(path, options);
      const body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      if (path.endsWith('/social/conversations/conv-1')) {
        body.conversation.unread_count = 2;
        body.items.push({id: 'm-2', user_id: bob, body: 'second', created: '2026-01-01T00:00:01Z'});
      }
      return json(result.status, body);
    };
    const restore = installChatGlobals({narrow: true});
    try {
      await mount(doc, {fetcher});
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, '2');
      await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
      if (mode === 'hidden') assert.equal(posts.length, 0);
      else assert.deepEqual(posts, [{message_id: 'm-2'}]);
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, mode === 'visible' ? '1' : '2');
    } finally { restore(); }
  });
}


test('social pinned state sorts before recency and unread filter uses server state', () => {
  const rows = mergeSessions([], [
    {id: 'new', kind: 'dm', updated: 20, unread_count: 1},
    {id: 'old', kind: 'group', updated: 1, pinned: true},
  ], alice);
  assert.equal(rows[0].id, 'old');
  assert.equal(rows[1].unread_count, 1);
});

test('session filter selects only real unread social rows', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      return json(result.status, body);
    }});
    el('session-filter-value').value = 'unread';
    await fire(el('session-filter-value'), 'change');
    assert.equal(sessionRows(el).length, 1);
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-1');
    el('session-filter-value').value = 'all';
    await fire(el('session-filter-value'), 'change');
    assert.equal(sessionRows(el).length, 2);
  } finally { restore(); }
});

test('independent conversation search uses current id and pages without opening sidebar search', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const calls = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/search/messages?')) {
        calls.push(path);
        const url = new URL(path, 'https://management.test');
        assert.equal(url.searchParams.get('conversation_id'), 'conv-1');
        return json(200, {items: [{kind: 'social', conversation_id: 'conv-1', message_id: url.searchParams.get('cursor') ? 'second' : 'first', snippet: 'Scoped result'}], cursor: url.searchParams.get('cursor') ? null : 'next-id'});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    assert.equal(el('conversation-search-panel').hidden, false);
    el('conversation-search-query').value = 'needle';
    await fire(el('conversation-search-form'), 'submit', {preventDefault() {}});
    assert.equal(el('conversation-search-results').children[0].textContent, 'Scoped result');
    assert.equal(el('conversation-search-more').hidden, false);
    await fire(el('conversation-search-more'), 'click');
    assert.equal(calls.length, 2);
    assert.equal(el('conversation-search-results').children.length, 2);
    assert.match(calls[1], /cursor=next-id/);
  } finally { restore(); }
});

test('own message editing and confirmed retraction call versioned endpoints', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  let text = 'Original', revision = 1, retracted = false;
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.includes('/messages/mine-1/')) {
        const payload = JSON.parse(options.body); posts.push([path, payload]);
        assert.equal(payload.revision, revision);
        revision += 1;
        if (path.endsWith('/edit')) text = payload.body;
        else { text = ''; retracted = true; }
        return json(200, {message: {}});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) body.items = [{id: 'mine-1', user_id: alice, body: text, revision, retracted}];
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    let li = el('message-list').children[0];
    await fire(li.children[3], 'click'); // edit opens inline controls
    li.children[5].children[0].value = 'Edited';
    await fire(li.children[5].children[1], 'click');
    assert.equal(text, 'Edited');
    li = el('message-list').children[0];
    await fire(li.children[4], 'click'); // only opens confirmation
    assert.equal(posts.length, 1);
    await fire(li.children[5].children[0], 'click');
    assert.equal(posts.length, 2);
    assert.equal(el('message-list').children[0].children[1].textContent, '此消息已撤回');
  } finally { restore(); }
});


test('visual session groups use real pins and preserve order within each group', async () => {
  const {groupSessionsForDisplay, sessionDisplayGroup} = await import('../openteamily/static/chat/app.mjs');
  const items = [{id: 'g', kind: 'group'}, {id: 'a', source: 'agent'}, {id: 'p', pinned: true, kind: 'group'}, {id: 'd', kind: 'dm'}];
  assert.deepEqual(groupSessionsForDisplay(items).map(row => row.id), ['p', 'a', 'd', 'g']);
  assert.deepEqual(items.map(row => row.id), ['g', 'a', 'p', 'd']);
  assert.equal(sessionDisplayGroup(items[0]), '群聊');
  assert.equal(sessionDisplayGroup(items[2]), '置顶');
});

test('session timestamps use Hong Kong calendar boundaries and never invent unread state', async () => {
  const {formatSessionTime} = await import('../openteamily/static/chat/app.mjs');
  const seconds = value => Date.parse(value) / 1000;
  const now = Date.parse('2026-11-19T00:01:00+08:00');
  assert.equal(formatSessionTime(seconds('2026-11-18T23:59:00+08:00'), now), '昨天');
  assert.equal(formatSessionTime(seconds('2026-11-19T00:00:00+08:00'), now), '00:00');
  assert.match(formatSessionTime(seconds('2026-11-10T12:00:00+08:00'), now), /2026/);
  assert.equal(formatSessionTime('invalid', now), '');
});

test('icon chat controls preserve accessible names, disabled truth and attachment privacy', () => {
  const html = chatHtml();
  assert.match(html, /id="conversation-search-open"[^>]*aria-label="搜索当前会话"[\s\S]*?<svg/);
  assert.match(html, /disabled title="未实现：语音或视频通话"/);
  assert.match(html, /class="attachment-menu"[\s\S]*?id="chat-attachment"/);
  assert.match(html, /工作区成员可在作品库查看/);
  assert.match(html, /disabled title="未实现：语音消息"[\s\S]*?sr-only">语音/);
});
