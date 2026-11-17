import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogItems, csrfCookie, draftFromTemplate, listQuery, namesFromList, readEditor, runResultText, runStatusLabel, scheduleFromForm, tabCategory } from '../openteamily/static/automations/app.mjs';

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
