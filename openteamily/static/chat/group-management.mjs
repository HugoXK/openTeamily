const WORKSPACE_ID = /^[a-f0-9]{32}$/;
const CONVERSATION_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,80}$/;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/;

function managedGroup(context) {
  const conversation = context?.conversation;
  const management = conversation?.group_management;
  if (!context?.owner || !WORKSPACE_ID.test(context.workspace || '') ||
      conversation?.kind !== 'group' || conversation.public_agent || !CONVERSATION_ID.test(conversation.id || '') ||
      !Number.isSafeInteger(management?.revision) || management.revision < 0) return null;
  return {...context, conversationId: conversation.id, management};
}

function sameGroup(a, b) {
  return Boolean(a && b && a.owner === b.owner && a.workspace === b.workspace && a.conversationId === b.conversationId);
}

function memberPermissions(target, member) {
  const id = member?.group_member_id;
  const {management} = target;
  if (typeof id !== 'string' || !MEMBER_ID.test(id) || id === management.owner_id) return {};
  const self = member.user_id === target.owner;
  return {
    remove: management.can_remove === true && !self,
    transfer: management.can_transfer === true && (!self || management.owner_inactive === true) &&
      Array.isArray(management.active_member_ids) && management.active_member_ids.includes(id),
  };
}

export function mountGroupManagement(document, {request, context, onChanged, onLeft, onRefresh, notify}) {
  const node = id => document.getElementById(`group-management-${id}`);
  const dialog = node('dialog');
  const nameField = node('name');
  const confirm = node('confirm');
  const cancel = node('cancel');
  const status = node('status');
  const refresh = node('refresh');
  const text = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
  const sameScope = target => sameGroup(target, managedGroup(context()));
  const active = new Set();
  const key = target => JSON.stringify([target.owner, target.workspace, target.conversationId]);
  let view = null;

  function available(target, mode, memberId) {
    const {management, conversation} = target;
    if (mode === 'rename') return management.can_rename === true;
    if (mode === 'leave') return management.can_leave === true || management.leave_requires_transfer === true;
    if (mode === 'member' || mode === 'remove' || mode === 'transfer') {
      const member = conversation.members?.find(item => item.group_member_id === memberId);
      const permissions = memberPermissions(target, member);
      return mode === 'member' ? permissions.remove || permissions.transfer : permissions[mode];
    }
    return false;
  }

  function say(message = '', canRefresh = false) {
    status.textContent = message;
    refresh.hidden = !canRefresh || typeof onRefresh !== 'function';
  }

  function setBusy(busy) {
    confirm.disabled = busy;
    nameField.disabled = busy;
    refresh.disabled = busy;
  }

  function render() {
    const {mode, target, memberId} = view;
    const member = target.conversation.members?.find(item => item.group_member_id === memberId);
    const memberName = member?.username || text('该成员', 'this member');
    const rename = mode === 'rename';
    const choosing = mode === 'member';
    const transferFirst = mode === 'leave' && target.management.leave_requires_transfer === true;
    const recover = mode === 'transfer' && target.management.owner_inactive === true;
    const title = {
      rename: text('编辑群名', 'Edit group name'),
      member: memberName,
      remove: text('移除成员', 'Remove member'),
      transfer: recover ? text('设置新群主', 'Set new owner') : text('转让群主', 'Transfer ownership'),
      leave: text('退出群聊', 'Leave group'),
    }[mode];
    const description = {
      rename: '',
      member: '',
      remove: text(`将 ${memberName} 移出群聊？群消息及对方的工作区成员身份会保留。`,
        `Remove ${memberName} from this group? Group messages and their workspace membership will remain.`),
      transfer: recover ? text(`由 ${memberName} 接任群主？`, `Set ${memberName} as the new owner?`)
        : text(`将群主权限交给 ${memberName}？转让后，你仍是群成员。`,
          `Give ${memberName} ownership of this group? You’ll stay in the group as a member.`),
      leave: transferFirst ? text('你是群主。请先在成员列表中选择新群主，再退出群聊。',
        'Choose a new owner from the member list before leaving this group.')
        : text('退出后，此群会从你的聊天列表移除。群聊及其消息会保留。',
          'This group will be removed from your chat list. The group and its messages will remain.'),
    }[mode];
    node('heading').textContent = title;
    node('description').textContent = description;
    node('name-row').hidden = !rename;
    node('member-actions').hidden = !choosing;
    node('remove').hidden = !choosing || !available(target, 'remove', memberId);
    node('transfer').hidden = !choosing || !available(target, 'transfer', memberId);
    node('transfer').textContent = target.management.owner_inactive === true ? text('设置新群主', 'Set new owner')
      : text('转让群主', 'Transfer ownership');
    node('choose-owner').hidden = !transferFirst;
    confirm.hidden = choosing || transferFirst;
    confirm.textContent = rename ? text('保存', 'Save') : title;
    confirm.classList.toggle('group-management-danger', mode === 'leave' || mode === 'remove');
    setBusy(false);
    say();
  }

  function open(mode, memberId) {
    const target = managedGroup(context());
    if (!target || !available(target, mode, memberId)) return;
    if (active.has(key(target))) {
      notify?.('ok', text('正在保存群设置…', 'Saving group settings…'));
      return;
    }
    view = {target, mode, memberId, blocked: false};
    if (mode === 'rename') nameField.value = target.conversation.title || '';
    render();
    dialog.showModal();
    if (mode === 'rename') {
      nameField.focus();
      nameField.select();
    } else cancel.focus();
  }

  function selectAction(mode) {
    if (!view || !sameScope(view.target) || !available(managedGroup(context()), mode, view.memberId)) return;
    view.mode = mode;
    render();
    cancel.focus();
  }

  function showMembers() {
    const tab = document.getElementById('group-info-tab-people');
    tab?.click();
    tab?.focus();
  }

  function sync() {
    const target = managedGroup(context());
    node('rename').hidden = !target || !available(target, 'rename');
    node('footer').hidden = !target || !available(target, 'leave');
    if (dialog.open && view && !sameGroup(target, view.target)) dialog.close();
  }

  function decorateMember(row, member) {
    const target = managedGroup(context());
    if (!target) return row;
    const memberId = member.group_member_id;
    if (memberId && memberId === target.management.owner_id) {
      const note = row.querySelector('small');
      if (note) {
        note.classList.add('group-management-owner');
        note.textContent = member.user_id === target.owner ? text('群主 · 你', 'Owner · You') : text('群主', 'Owner');
      }
    }
    if (!available(target, 'member', memberId)) return row;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.manageGroupMember = memberId;
    button.className = 'group-management-member';
    button.textContent = text('管理', 'Manage');
    button.setAttribute('aria-label', text(`管理成员 ${member.username}`, `Manage ${member.username}`));
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => { if (sameScope(target)) open('member', memberId); });
    row.append(button);
    return row;
  }

  function checkAgain(next) {
    next.blocked = true;
    confirm.disabled = true;
    say(text('群设置已变化，请刷新后再确认。', 'Group settings changed. Refresh before confirming.'), true);
  }

  dialog.addEventListener('close', () => { if (!dialog.open) view = null; });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  node('rename').addEventListener('click', () => open('rename'));
  node('leave').addEventListener('click', () => open('leave'));
  node('remove').addEventListener('click', () => selectAction('remove'));
  node('transfer').addEventListener('click', () => selectAction('transfer'));
  node('choose-owner').addEventListener('click', () => { dialog.close(); showMembers(); });
  cancel.addEventListener('click', () => dialog.close());
  refresh.addEventListener('click', async () => {
    const next = view;
    if (!next || !sameScope(next.target) || refresh.disabled) return;
    let latest;
    setBusy(true);
    try { latest = await onRefresh?.(next.target); } catch {}
    if (view !== next || !dialog.open || !sameScope(next.target)) return;
    setBusy(false);
    const target = managedGroup(context());
    if (!latest && target.management.revision === next.target.management.revision) {
      say(text('群信息读取失败，请重试。', 'Could not refresh group info. Try again.'), true);
      confirm.disabled = true;
      return;
    }
    if (!available(target, next.mode, next.memberId)) {
      dialog.close();
      notify?.('ok', text('群信息已更新，此操作已不可用。', 'Group info updated. This action is no longer available.'));
      return;
    }
    next.target = target;
    next.blocked = false;
    render();
    say(text('群信息已更新，请检查后确认。', 'Group info updated. Review it before confirming.'));
    if (next.mode === 'rename') nameField.focus();
    else cancel.focus();
  });

  node('form').addEventListener('submit', async event => {
    event.preventDefault();
    const next = view;
    const current = managedGroup(context());
    if (!next || next.blocked || confirm.hidden || confirm.disabled || !sameGroup(current, next.target)) return;
    const {target, mode: action, memberId} = next;
    if (current.management.revision !== target.management.revision || !available(current, action, memberId)) {
      checkAgain(next);
      return;
    }
    const scopeKey = key(target);
    if (active.has(scopeKey)) return;
    const payload = {action, revision: target.management.revision};
    if (memberId) payload.member_id = memberId;
    if (action === 'rename') {
      payload.title = nameField.value.trim();
      if (!payload.title || payload.title.length > nameField.maxLength) {
        say(text('请输入群名，最多 80 个字符。', 'Enter a group name up to 80 characters.'));
        nameField.focus();
        return;
      }
    }
    const path = `/v1/workspaces/${target.workspace}/social/conversations/${target.conversationId}/management`;
    active.add(scopeKey);
    setBusy(true);
    say(text('正在保存…', 'Saving…'));
    let result;
    try { result = await request('POST', path, payload, undefined, AbortSignal.timeout(10000)); } catch {}
    finally { active.delete(scopeKey); }
    const latest = managedGroup(context());
    if (!sameGroup(latest, target)) return;
    const stillAsking = view === next && dialog.open;
    if (stillAsking) setBusy(false);
    if (result?.status === 200) {
      const {conversation, left, conversation_id: id} = result.body || {};
      if (action === 'leave' && left === true && id === target.conversationId) {
        if (stillAsking) dialog.close();
        onLeft(target);
        return;
      }
      if (action !== 'leave' && conversation?.id === target.conversationId && conversation.workspace_id === target.workspace &&
          managedGroup({...target, conversation})) {
        if (stillAsking) dialog.close();
        if (conversation.group_management.revision >= latest.management.revision) onChanged(conversation, target);
        if (stillAsking && action !== 'rename') showMembers();
        notify?.('ok', text('群信息已更新。', 'Group info updated.'));
        return;
      }
    }
    if (!stillAsking) return;
    if ([403, 404, 409].includes(result?.status)) checkAgain(next);
    else if (result?.status === 400 && action === 'rename') {
      say(text('群名无法保存，请检查后重试。', 'Check the group name and try again.'));
      nameField.focus();
    } else say(text('暂时无法确认结果，可以重试。', 'Could not confirm the result. You can try again.'));
  });

  return {sync, decorateMember};
}
