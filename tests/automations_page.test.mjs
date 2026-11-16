import assert from 'node:assert/strict';
import test from 'node:test';
import { csrfCookie, listQuery, namesFromList, readEditor, scheduleFromForm, tabCategory } from '../openteamily/static/automations/app.mjs';

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
