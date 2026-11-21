import assert from 'node:assert/strict';
import test from 'node:test';
import { mountGroupManagement } from '../openteamily/static/chat/group-management.mjs';

const workspace = 'a'.repeat(32);
const group = 'b'.repeat(32);
const owner = {user_id: 'owner-account', group_member_id: 'owner-social', username: 'Owner'};
const member = {user_id: 'member-account', group_member_id: 'member-social', username: 'Member'};

function viewOf({actor = owner, id = group, revision = 4, management = {}} = {}) {
  return {owner: actor.user_id, workspace, conversation: {
    id, workspace_id: workspace, kind: 'group', title: 'Project work', members: [owner, member], group_management: {
      revision, owner_id: owner.group_member_id, active_member_ids: [owner.group_member_id, member.group_member_id],
      can_rename: actor === owner, can_remove: actor === owner, can_transfer: actor === owner,
      can_leave: actor !== owner, leave_requires_transfer: actor === owner, ...management,
    },
  }};
}

class Element {
  children = [];
  dataset = {};
  classList = {add() {}, toggle() {}};
  events = new Map();
  hidden = false;
  disabled = false;
  maxLength = 80;
  addEventListener(name, listener) { this.events.set(name, listener); }
  fire(name) { return this.events.get(name)?.({preventDefault() {}}); }
  click() { return this.fire('click'); }
  append(child) { this.children.push(child); }
  querySelector() { return this.note; }
  setAttribute() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() {}
  select() {}
}

function ui(context, {request, onChanged, onLeft, onRefresh} = {}) {
  const nodes = new Map();
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const control = name => getElementById(`group-management-${name}`);
  const controller = mountGroupManagement({getElementById, createElement: () => new Element(), documentElement: {lang: 'en'}},
    {context, request, onChanged, onLeft, onRefresh});
  const memberButton = person => controller.decorateMember(new Element(), person).children[0];
  return {control, controller, memberButton};
}

test('group owner must transfer first, with explicit confirmation and authoritative member identity', async () => {
  let current = viewOf();
  const writes = [];
  const {control, memberButton} = ui(() => current, {
    request: async (method, path, body) => {
      writes.push({method, path, body});
      return {status: 200, body: {conversation: viewOf({revision: 5, management: {owner_id: member.group_member_id}}).conversation}};
    },
    onChanged: conversation => { current = {...current, conversation}; },
  });
  control('leave').click();
  assert.equal(control('choose-owner').hidden, false);
  assert.equal(control('confirm').hidden, true);
  await control('form').fire('submit');
  assert.deepEqual(writes, []);
  control('choose-owner').click();
  assert.equal(memberButton(owner), undefined);
  memberButton(member).click();
  control('transfer').click();
  assert.deepEqual(writes, []);
  await control('form').fire('submit');
  assert.deepEqual(writes, [{method: 'POST', path: `/v1/workspaces/${workspace}/social/conversations/${group}/management`,
    body: {action: 'transfer', revision: 4, member_id: member.group_member_id}}]);
  assert.equal(current.conversation.group_management.owner_id, member.group_member_id);
});

test('an active team manager can recover ownership with themselves when the owner is inactive', () => {
  const current = viewOf({actor: member, management: {owner_inactive: true, can_transfer: true, active_member_ids: [member.group_member_id]}});
  const {control, memberButton} = ui(() => current);
  memberButton(member).click();
  assert.equal(control('transfer').hidden, false);
  assert.equal(control('transfer').textContent, 'Set new owner');
  assert.equal(control('remove').hidden, true);
});

test('read-back after a version conflict preserves the draft and never retries implicitly', async () => {
  let current = viewOf();
  const writes = [];
  const {control} = ui(() => current, {
    request: async (_method, _path, body) => { writes.push(body); return {status: 409, body: {}}; },
    onRefresh: async () => { current = viewOf({revision: 5}); return true; },
  });
  control('rename').click();
  control('name').value = 'Revised group name';
  await control('form').fire('submit');
  assert.equal(control('confirm').disabled, true);
  assert.equal(control('refresh').hidden, false);
  await control('refresh').click();
  assert.equal(control('name').value, 'Revised group name');
  assert.equal(control('confirm').disabled, false);
  assert.equal(writes.length, 1);
  await control('form').fire('submit');
  assert.deepEqual(writes.map(body => [body.revision, body.title]), [[4, 'Revised group name'], [5, 'Revised group name']]);
});

test('a successful late leave receipt cannot close or change a different group', async () => {
  let current = viewOf({actor: member});
  let finish;
  const {control, controller} = ui(() => current, {
    request: () => new Promise(resolve => { finish = resolve; }),
    onLeft: () => assert.fail('late response changed a different group'),
  });
  control('leave').click();
  const pending = control('form').fire('submit');
  current = viewOf({actor: member, id: 'c'.repeat(32)});
  controller.sync();
  assert.equal(control('dialog').open, false);
  finish({status: 200, body: {left: true, conversation_id: group}});
  await pending;
});
