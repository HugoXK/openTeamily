export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};

export function readAddMember(form) {
  const data = new FormData(form);
  const role = data.get('role') === 'admin' ? 'admin' : 'member';
  return {username: (data.get('username') || '').trim(), role};
}

export function readInvite(form) {
  const data = new FormData(form);
  const days = Number(data.get('expires_days') || 7);
  const uses = Number(data.get('max_uses') || 1);
  return {
    role: data.get('role') === 'admin' ? 'admin' : 'member',
    expires_in: Math.round(days * 86400),
    max_uses: uses,
    ...(data.get('requires_approval') ? {requires_approval: true} : {}),
  };
}

export function canSuspend(actorRole, item, selfId) {
  if (!item || item.role === 'owner' || item.user_id === selfId) return false;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && item.role === 'member';
}

export function inviteState(item) {
  if (item.revoked) return '已撤销';
  if (item.frozen) return '已冻结';
  return item.requires_approval ? '有效 · 需审批' : '有效';
}

export function readAccept(form) {
  const data = new FormData(form);
  return {token: (data.get('token') || '').trim()};
}

export function canAdd(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function addableRoles(actor) {
  if (actor === 'owner') return ['admin', 'member'];
  if (actor === 'admin') return ['member'];
  return [];
}

export function canChange(actor) {
  return actor === 'owner';
}

export function canInvite(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function canRemove(actor, target, selfId) {
  if (!target || target.role === 'owner') return false;
  if (target.user_id === selfId) return actor === 'admin' || actor === 'member';
  if (actor === 'owner') return target.role === 'admin' || target.role === 'member';
  if (actor === 'admin') return target.role === 'member';
  return false;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let actor = null;
  let workspaces = [];

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function setRoleOptions(form, actorRole) {
    const select = form.elements.role;
    const allowed = addableRoles(actorRole);
    for (const option of select.options) {
      option.hidden = !allowed.includes(option.value);
    }
    if (!allowed.includes(select.value)) select.value = allowed[0] || 'member';
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  function renderMembers(items) {
    const list = document.getElementById('member-list');
    const empty = document.getElementById('members-empty');
    list.textContent = '';
    empty.hidden = items.length > 0;
    const selfId = currentUser && currentUser.id;
    for (const item of items) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${item.username} · ${ROLE_LABELS[item.role] || item.role}${item.suspended ? ' · 已停用' : ''}`;
      row.appendChild(label);
      if (canSuspend(actor, item, selfId)) {
        const suspend = document.createElement('button');
        suspend.type = 'button';
        suspend.textContent = item.suspended ? '恢复访问' : '停用';
        suspend.title = item.suspended ? '恢复后对方可再次访问本工作区' : '停用后对方保留成员身份，但无法访问本工作区，可随时恢复';
        suspend.addEventListener('click', () => suspendMember(item, !item.suspended));
        row.appendChild(suspend);
      }
      if (canChange(actor) && item.role !== 'owner') {
        const change = document.createElement('button');
        change.type = 'button';
        change.textContent = item.role === 'admin' ? '改为成员' : '改为管理员';
        change.addEventListener('click', () => changeRole(item, item.role === 'admin' ? 'member' : 'admin'));
        row.appendChild(change);
      }
      if (canRemove(actor, item, selfId)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = item.user_id === selfId ? '退出' : '移除';
        remove.addEventListener('click', () => removeMember(item));
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
  }

  function renderInvites(items) {
    const list = document.getElementById('invite-list');
    const empty = document.getElementById('invites-empty');
    list.textContent = '';
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const state = inviteState(item);
      const meta = document.createElement('span');
      meta.textContent = `${ROLE_LABELS[item.role] || item.role} · ${state} · 已用 ${item.use_count}/${item.max_uses}`;
      row.appendChild(meta);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', () => revokeInvite(item));
        const freeze = document.createElement('button');
        freeze.type = 'button';
        freeze.textContent = item.frozen ? '恢复' : '冻结';
        freeze.title = item.frozen ? '恢复后邀请可再次使用' : '暂停这条邀请，不撤销，可随时恢复';
        freeze.addEventListener('click', () => inviteAction(item, item.frozen ? 'unfreeze' : 'freeze'));
        row.appendChild(freeze);
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  async function changeRole(item, role) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}`, {role});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更改角色。'));
      return;
    }
    show('ok', '已更改角色。');
    await loadWorkspace();
  }

  async function suspendMember(item, suspend) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/${suspend ? 'suspend' : 'unsuspend'}`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更新成员状态。'));
      return;
    }
    show('ok', suspend ? '已停用该成员的访问。' : '已恢复该成员的访问。');
    await loadWorkspace();
  }

  async function removeMember(item) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法移除成员。'));
      return;
    }
    show('ok', item.user_id === currentUser.id ? '已退出工作区。' : '已移除。');
    await load();
  }

  async function inviteAction(item, action) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/invites/${item.id}/${action}`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更新邀请。'));
      return;
    }
    show('ok', action === 'freeze' ? '已冻结邀请。' : '已恢复邀请。');
    await loadWorkspace();
  }

  function renderJoinRequests(items) {
    const list = document.getElementById('join-request-list');
    const empty = document.getElementById('join-requests-empty');
    if (!list) return;
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      meta.textContent = `${item.username} · 申请成为${ROLE_LABELS[item.role] || item.role}`;
      row.appendChild(meta);
      for (const [decision, label] of [['approve', '批准'], ['reject', '拒绝']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => decideJoin(item, decision));
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  }

  async function decideJoin(item, decision) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/join-requests/${item.id}/${decision}`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法处理申请。'));
      return;
    }
    show('ok', decision === 'approve' ? '已批准，对方已加入。' : '已拒绝申请。');
    await loadWorkspace();
  }

  async function revokeInvite(item) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/invites/${item.id}/revoke`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法撤销邀请。'));
      return;
    }
    show('ok', '已撤销邀请。');
    await loadWorkspace();
  }

  async function loadWorkspace() {
    const id = workspaceId();
    const addForm = document.getElementById('add-form');
    const inviteForm = document.getElementById('invite-form');
    const invitesPanel = document.getElementById('invites-panel');
    if (!id) {
      actor = null;
      renderMembers([]);
      document.getElementById('role-note').textContent = '还没有工作区。';
      addForm.hidden = true;
      inviteForm.hidden = true;
      invitesPanel.hidden = true;
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/members`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取成员列表。'));
      return;
    }
    const items = listed.body.items || [];
    const self = items.find(item => currentUser && item.user_id === currentUser.id);
    actor = self ? self.role : null;
    document.getElementById('role-note').textContent = actor
      ? `当前角色：${ROLE_LABELS[actor] || actor}`
      : '';
    renderMembers(items);
    addForm.hidden = !canAdd(actor);
    inviteForm.hidden = !canInvite(actor);
    invitesPanel.hidden = !canInvite(actor);
    if (canAdd(actor)) setRoleOptions(addForm, actor);
    if (canInvite(actor)) {
      setRoleOptions(inviteForm, actor);
      const invites = await request('GET', `/v1/workspaces/${id}/invites`);
      if (invites.status === 200) renderInvites(invites.body.items || []);
      else renderInvites([]);
      const joins = await request('GET', `/v1/workspaces/${id}/join-requests`);
      const joinPanel = document.getElementById('join-requests-panel');
      if (joinPanel) joinPanel.hidden = false;
      renderJoinRequests(joins.status === 200 ? (joins.body.items || []) : []);
    } else {
      const joinPanel = document.getElementById('join-requests-panel');
      if (joinPanel) joinPanel.hidden = true;
    }
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = currentUser.username;
    const space = await request('GET', '/v1/workspaces?limit=100');
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = space.body.items || [];
    const previous = workspaceSelect.value;
    workspaceSelect.textContent = '';
    for (const item of workspaces) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || item.slug || item.id;
      workspaceSelect.appendChild(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    await loadWorkspace();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  workspaceSelect.addEventListener('change', async () => {
    document.getElementById('issued-token').hidden = true;
    await loadWorkspace();
  });

  document.getElementById('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区。');
      return;
    }
    const values = readAddMember(event.currentTarget);
    if (!values.username) {
      show('error', '请填写用户名。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/members`, values);
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法添加成员。'));
      return;
    }
    event.currentTarget.reset();
    setRoleOptions(event.currentTarget, actor);
    show('ok', '已添加。');
    await loadWorkspace();
  });

  document.getElementById('invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区。');
      return;
    }
    const values = readInvite(event.currentTarget);
    const result = await request('POST', `/v1/workspaces/${id}/invites`, values);
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法生成邀请。'));
      return;
    }
    const box = document.getElementById('issued-token');
    box.hidden = false;
    box.textContent = result.body.token
      ? `邀请令牌只显示一次：${result.body.token}`
      : '已生成邀请，但响应里没有令牌。';
    show('ok', '已生成邀请。令牌只显示这一次。');
    await loadWorkspace();
  });

  document.getElementById('accept-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = readAccept(event.currentTarget);
    if (!values.token) {
      show('error', '请填写邀请令牌。');
      return;
    }
    const result = await request('POST', '/v1/invites/accept', values);
    if (![200, 201, 202].includes(result.status)) {
      show('error', messageFor(result.body.error, '无法接受邀请。'));
      return;
    }
    event.currentTarget.reset();
    if (result.status === 202 || (result.body.join_request && result.body.join_request.status === 'pending')) {
      show('ok', '已提交加入申请，等待所有者或管理员审批。');
      return;
    }
    show('ok', '已加入工作区。');
    await load();
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('add-form')) {
  mount(globalThis.document);
}
