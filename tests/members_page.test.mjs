import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addableRoles, canAdd, canChange, canInvite, canRemove,
  readAccept, readAddMember, readInvite,
} from '../openteamily/static/members/app.mjs';

test('permission helpers follow the documented role defaults', () => {
  assert.deepEqual(addableRoles('owner'), ['admin', 'member']);
  assert.deepEqual(addableRoles('admin'), ['member']);
  assert.deepEqual(addableRoles('member'), []);
  assert.equal(canAdd('owner'), true);
  assert.equal(canAdd('member'), false);
  assert.equal(canChange('owner'), true);
  assert.equal(canChange('admin'), false);
  assert.equal(canInvite('admin'), true);
  assert.equal(canInvite('member'), false);
  assert.equal(canRemove('owner', {user_id: 'b', role: 'admin'}, 'a'), true);
  assert.equal(canRemove('admin', {user_id: 'b', role: 'admin'}, 'a'), false);
  assert.equal(canRemove('admin', {user_id: 'b', role: 'member'}, 'a'), true);
  assert.equal(canRemove('member', {user_id: 'b', role: 'member'}, 'a'), false);
  assert.equal(canRemove('member', {user_id: 'me', role: 'member'}, 'me'), true);
  assert.equal(canRemove('owner', {user_id: 'a', role: 'owner'}, 'a'), false);
});

test('readAddMember and readInvite map form fields', () => {
  const values = {username: ' Bob ', role: 'admin', expires_days: '7', max_uses: '2', token: ' tok '};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readAddMember({}), {username: 'Bob', role: 'admin'});
    assert.deepEqual(readInvite({}), {role: 'admin', expires_in: 604800, max_uses: 2});
    assert.deepEqual(readAccept({}), {token: 'tok'});
  } finally {
    globalThis.FormData = original;
  }
});

test('invite approval option and state labels', async () => {
  const {inviteState} = await import('../openteamily/static/members/app.mjs');
  assert.equal(inviteState({revoked: 1, frozen: true}), '已撤销');
  assert.equal(inviteState({revoked: 0, frozen: true}), '已冻结');
  assert.equal(inviteState({revoked: 0, requires_approval: true}), '有效 · 需审批');
  assert.equal(inviteState({revoked: 0}), '有效');
});

test('suspend permission mirrors the server rules', async () => {
  const {canSuspend} = await import('../openteamily/static/members/app.mjs');
  assert.equal(canSuspend('owner', {user_id: 'a', role: 'admin'}, 'o'), true);
  assert.equal(canSuspend('admin', {user_id: 'a', role: 'admin'}, 'b'), false);
  assert.equal(canSuspend('admin', {user_id: 'm', role: 'member'}, 'b'), true);
  assert.equal(canSuspend('owner', {user_id: 'o', role: 'owner'}, 'o'), false);
  assert.equal(canSuspend('member', {user_id: 'm', role: 'member'}, 'x'), false);
});

test('team directory membership labels', async () => {
  const {directoryMembershipLabel} = await import('../openteamily/static/members/app.mjs');
  assert.equal(directoryMembershipLabel({membership: 'member'}), '已加入');
  assert.equal(directoryMembershipLabel({membership: 'pending'}), '等待审批');
  assert.equal(directoryMembershipLabel({membership: null}), '');
});
