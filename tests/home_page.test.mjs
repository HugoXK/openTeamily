import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTitle, formatWhen, kindLabel, meetingMeta } from '../openteamily/static/home/app.mjs';
import { waitForRuntime } from '../openteamily/static/home/runtime-readiness.mjs';
import { spaceHref } from '../openteamily/static/shell/thumb.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('runtime readiness retries temporary failures and stops at confirmed states', async () => {
  const replies = [null, {status: 200, body: {state: 'starting'}}, {status: 200, body: {state: 'ready'}}];
  const waits = [];
  const state = await waitForRuntime(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error('network interruption');
    return reply;
  }, {delay: async ms => waits.push(ms)});
  assert.equal(state, 'ready');
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(await waitForRuntime(async () => ({status: 401})), 'signed-out');
  assert.equal(await waitForRuntime(async () => ({status: 200, body: {state: 'starting'}}), {attempts: 1}), 'timeout');
});

test('conversationTitle names agent, DM and group rows without inventing data', () => {
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper', title: 'Old'}, alice), 'Old');
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper'}, alice), 'Helper');
  assert.equal(conversationTitle({source: 'agent', title: 'Thread'}, alice), 'Thread');
  assert.equal(conversationTitle({source: 'social', kind: 'dm', members: [
    {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}]}, alice), 'bob');
  assert.equal(conversationTitle({source: 'social', kind: 'group', title: '产品群'}, alice), '产品群');
  assert.equal(conversationTitle({source: 'social', kind: 'group'}, alice), '群聊');
});

test('formatWhen uses compact real-time labels', () => {
  const now = 1800000000;
  assert.equal(formatWhen(now - 30, now), '刚刚');
  assert.equal(formatWhen(now - 120, now), '2 分钟前');
  assert.match(formatWhen(now - 7200, now), /^\d{2}:\d{2}$/);
  assert.equal(formatWhen(now - 86400, now), '昨天');
  assert.match(formatWhen(now - 86400 * 10, now), /2027|2026/);
  assert.equal(formatWhen(null, now), '');
});

test('kindLabel and meetingMeta keep summaries honest', () => {
  assert.equal(kindLabel('slides'), '幻灯片');
  assert.equal(kindLabel('unknown'), '作品');
  assert.equal(meetingMeta({action_count: 3, done_count: 1}), '3 个行动项 · 1 已完成');
  assert.equal(meetingMeta({action_count: 0}), '没有行动项');
});


test('home artifact rows deep-link to the existing space editor query', () => {
  const workspace = 'a'.repeat(32);
  const artifact = 'b'.repeat(32);
  assert.equal(spaceHref(workspace, artifact), '/space?workspace=' + workspace + '&artifact=' + artifact);
  assert.equal(spaceHref(workspace), '/space?workspace=' + workspace);
});

test('public work login resumes the requested panel for one safe work slug', async () => {
  const {publicWorkIntentFromHash} = await import('../openteamily/static/shell/public-work-link.mjs');
  assert.deepEqual(publicWorkIntentFromHash('#work-comments=writer-demo'), {
    slug: 'writer-demo', panel: 'comments', continuation: '#work-comments=writer-demo',
    target: '/discover?work=writer-demo&comments=1',
  });
  assert.deepEqual(publicWorkIntentFromHash('#work-detail=writer-demo'), {
    slug: 'writer-demo', panel: 'share', continuation: '#work-detail=writer-demo',
    target: '/discover?work=writer-demo&share=1',
  });
  for (const hash of [
    '#work-comments=one&work-comments=two', '#work-comments=writer-demo&next=/profile',
    '#work-detail=https%3A%2F%2Fexample.invalid', '#work-comments=..%2Fwork', '#public-agent=writer-demo',
  ]) assert.equal(publicWorkIntentFromHash(hash), null);
});
