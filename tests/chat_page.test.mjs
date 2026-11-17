import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSessions, SEARCH_TABS } from '../openteamily/static/chat/app.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

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
  assert.equal(sessions.every((row) => row.pinned == null), true);
});
