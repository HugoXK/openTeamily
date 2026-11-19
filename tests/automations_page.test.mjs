import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogItems, csrfCookie, draftFromTemplate, listQuery, mount, namesFromList, readEditor, runResultText, runStatusLabel, scheduleFromForm, scheduleSummary, tabCategory } from '../openteamily/static/automations/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes tab and search', () => {
  assert.equal(listQuery('mine', ''), '?category=mine');
  assert.equal(listQuery('work', '  brief '), '?category=work&q=brief');
  assert.equal(tabCategory('life'), 'life');
  assert.equal(tabCategory('other'), 'mine');
});

test('scheduleFromForm and namesFromList map editor fields', () => {
  const fake = {
    get(name) {
      return {
        kind: 'monthly', time: '10:15', time_zone: 'UTC', day: '16',
        weekday: '1', date: '2026-11-20',
      }[name];
    },
  };
  assert.deepEqual(scheduleFromForm(fake), {kind: 'monthly', time: '10:15', time_zone: 'UTC', day: 16});
  assert.deepEqual(namesFromList('alice, Bob, alice'), ['alice', 'Bob']);
});

test('readEditor collects tag fields', () => {
  const values = {
    title: ' Brief ', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
    participants: 'alice, bob', agents: 'brief-bot', kind: 'weekdays',
    time: '09:00', time_zone: 'Asia/Shanghai', prompt: 'hello',
  };
  const fake = {
    get(name) { return values[name]; },
    has(name) { return name === 'enabled'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readEditor({}), {
      title: 'Brief', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
      participants: ['alice', 'bob'], agents: ['brief-bot'],
      schedule: {kind: 'weekdays', time: '09:00', time_zone: 'Asia/Shanghai'},
      prompt: 'hello', enabled: true,
    });
  } finally {
    globalThis.FormData = original;
  }
});

test('runStatusLabel and runResultText describe durable run rows', () => {
  assert.equal(runStatusLabel({status: 'succeeded'}), '已完成');
  assert.equal(runStatusLabel({status: 'queued', error_code: 'no_agent'}), '等待已连接的代理');
  assert.equal(runStatusLabel({status: 'timeout'}), '已超时');
  assert.equal(runResultText({result: {text: 'brief from fake provider'}}), 'brief from fake provider');
  assert.equal(runResultText({result: {}}), '');
});

test('catalogItems filters recorded work and life templates', () => {
  const templates = [
    {id: 'custom', title: '自定义', category: 'custom', prompt: ''},
    {id: 'daily_brief', title: '每日工作简报', category: 'work', prompt: '汇总当天要处理的事项。'},
    {id: 'birthday_reminder', title: '生日和纪念日提醒', category: 'life', prompt: '在日期到来前提醒我。'},
    {id: 'habit_reminder', title: '健康和习惯提醒', category: 'life', prompt: '在约定的时间提醒我。'},
  ];
  assert.deepEqual(catalogItems(templates, 'work', '').map(item => item.id), ['daily_brief']);
  assert.deepEqual(catalogItems(templates, 'life', '习惯').map(item => item.id), ['habit_reminder']);
  assert.deepEqual(catalogItems(templates, 'mine', ''), []);
});

test('draftFromTemplate uses recorded daily brief defaults only', () => {
  assert.deepEqual(draftFromTemplate({
    id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
  }, 'alice'), {
    template_id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
    intent: 'monitor', scope: 'once',
    schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
    participants: ['alice'], agents: [], enabled: false,
  });
  const life = draftFromTemplate({
    id: 'birthday_reminder', title: '生日和纪念日提醒', prompt: '提前提醒。',
  }, 'alice');
  assert.equal(life.intent, '');
  assert.equal(life.scope, 'once');
  assert.equal(life.schedule.kind, 'now');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.classList = {add() {}, remove() {}, contains() { return false; }};
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
  get elements() { return (this._elements ||= {template_id: new FakeNode('select')}); }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  appendChild(child) {
    this.children.push(child);
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll() { return []; }
  querySelector() { return new FakeNode(); }
}

function fakeDocument() {
  const elements = new Map();
  const tags = {'editor-form': 'form', workspace: 'select', search: 'input'};
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode(tags[id] || 'div'));
      return elements.get(id);
    },
    createElement(tag) { return new FakeNode(tag); },
    querySelectorAll() { return []; },
    querySelector() { return new FakeNode(); },
  };
  return {doc, elements};
}

async function mountList(items) {
  const {doc, elements} = fakeDocument();
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push(`${options.method || 'GET'} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') return {status: 200, json: async () => ({items})};
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    await mount(doc, {fetcher});
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  return {list: elements.get('automation-list'), calls};
}

test('scheduleSummary writes the editor wording for every recorded schedule kind', () => {
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'Asia/Shanghai'}, true), '立即运行 · 已启用');
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'UTC'}, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '每天 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '18:00', time_zone: 'UTC'}, true), '每天 18:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}, true), '每周四 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekdays', time: '08:30', time_zone: 'Asia/Shanghai'}, true), '工作日 08:30（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'monthly', time: '09:00', day: 16, time_zone: 'Asia/Shanghai'}, true), '每月 16 日 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '单次 2026-11-20 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'later', date: '2026-11-20', time: '08:00', time_zone: 'UTC'}, true), '单次 2026-11-20 08:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, false), '每天 09:00（Asia/Shanghai）· 未启用');
  assert.equal(scheduleSummary(null, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'mystery', time_zone: 'UTC'}, true).includes('mystery'), false, 'an unknown kind is never echoed to the reader');
});

test('list rows describe the schedule instead of printing the internal kind', async () => {
  const {list} = await mountList([
    {id: 'a1', title: '每日简报', enabled: true, schedule: {kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a2', title: '周报', enabled: true, schedule: {kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}},
    {id: 'a3', title: '一次性提醒', enabled: true, schedule: {kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a4', title: '立即运行的任务', enabled: true, schedule: {kind: 'now', time_zone: 'Asia/Shanghai'}},
    {id: 'a5', title: '每月复盘', enabled: false, schedule: {kind: 'monthly', time: '18:00', day: 16, time_zone: 'UTC'}},
  ]);
  const rows = list.children.map(row => row.textContent);
  assert.match(rows[0], /每日简报/);
  assert.match(rows[0], /每天 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[1], /周报/);
  assert.match(rows[1], /每周四 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[2], /一次性提醒/);
  assert.match(rows[2], /单次 2026-11-20 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[3], /立即运行的任务/);
  assert.match(rows[3], /立即运行 · 已启用/);
  assert.match(rows[4], /每月复盘/);
  assert.match(rows[4], /每月 16 日 18:00（UTC）· 未启用/);
  const joined = list.textContent;
  assert.doesNotMatch(joined, /(?:^|\s)(?:now|later|once|daily|weekly|monthly|weekdays)(?=\s|$)/u,
    `the list must not print an internal schedule kind: ${joined}`);
});

import { templateFromSearch } from '../openteamily/static/automations/app.mjs';

test('?template= accepts only a plain template id', () => {
  assert.equal(templateFromSearch('?template=daily_brief'), 'daily_brief');
  assert.equal(templateFromSearch('?template=../x'), '');
  assert.equal(templateFromSearch(''), '');
});
