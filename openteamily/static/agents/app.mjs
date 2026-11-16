export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function canManage(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function readAgentForm(form) {
  const data = new FormData(form);
  return {
    name: (data.get('name') || '').trim(),
    summary: (data.get('summary') || '').trim(),
    instructions: data.get('instructions') || '',
  };
}

export function idempotencyKey() {
  const raw = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  return ('agent-' + raw.replace(/-/g, '')).slice(0, 64);
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
  const createForm = document.getElementById('create-form');
  const editForm = document.getElementById('edit-form');
  let currentUser = null;
  let actor = null;
  let workspaces = [];

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
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

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = '已登录为 ' + currentUser.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const previous = workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    if (!workspaces.length) {
      document.getElementById('role-note').textContent = '还没有可访问的工作区。';
      document.getElementById('agent-list').replaceChildren();
      document.getElementById('agents-empty').hidden = false;
      createForm.hidden = true;
      editForm.hidden = true;
      show('', '');
      return;
    }
    await loadWorkspace();
  }

  async function loadWorkspace() {
    const id = workspaceId();
    if (!id) return;
    const detail = await request('GET', `/v1/workspaces/${id}`);
    if (detail.status !== 200) {
      show('error', messageFor(detail.body.error, '无法打开工作区。'));
      return;
    }
    const members = await request('GET', `/v1/workspaces/${id}/members`);
    const self = members.status === 200
      ? (members.body.items || []).find(row => row.user_id === currentUser.id)
      : null;
    actor = self ? self.role : (detail.body.workspace && detail.body.workspace.owner_id === currentUser.id ? 'owner' : 'member');
    document.getElementById('role-note').textContent = actor === 'owner'
      ? '你是这个工作区的所有者，可以创建和归档智能体。'
      : actor === 'admin'
        ? '你是管理员，可以创建和归档智能体。'
        : '你是成员，可以查看目录，但不能改。';
    createForm.hidden = !canManage(actor);
    editForm.hidden = true;
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return;
    }
    const items = listed.body.items || [];
    const list = document.getElementById('agent-list');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.id = item.id;
      button.textContent = item.name;
      li.append(button);
      if (item.summary) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = ' — ' + item.summary;
        li.append(note);
      }
      list.append(li);
    }
    document.getElementById('agents-empty').hidden = items.length > 0;
    show('', '');
  }

  function fillEdit(agent) {
    editForm.hidden = false;
    editForm.elements.id.value = agent.id;
    editForm.elements.revision.value = String(agent.revision);
    editForm.elements.name.value = agent.name;
    editForm.elements.summary.value = agent.summary || '';
    editForm.elements.instructions.value = agent.instructions || '';
    const writable = canManage(actor);
    for (const field of ['name', 'summary', 'instructions']) {
      editForm.elements[field].disabled = !writable;
    }
    document.getElementById('archive-button').hidden = !writable;
    editForm.querySelector('button[type="submit"]').hidden = !writable;
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    await load();
  });

  workspaceSelect.addEventListener('change', () => loadWorkspace());

  document.getElementById('agent-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const id = workspaceId();
    const result = await request('GET', `/v1/workspaces/${id}/agents/${button.dataset.id}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开这个智能体。'));
      return;
    }
    fillEdit(result.body.agent);
  });

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    const values = readAgentForm(event.currentTarget);
    if (!values.name) {
      show('error', '请填写名称。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/agents`, values, {
      'Idempotency-Key': idempotencyKey(),
    });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建智能体。'));
      return;
    }
    event.currentTarget.reset();
    show('ok', '已保存到目录。管理进程不会运行它。');
    await loadWorkspace();
    if (result.body.agent) fillEdit(result.body.agent);
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage(actor)) return;
    const id = workspaceId();
    const values = readAgentForm(event.currentTarget);
    values.revision = Number(event.currentTarget.elements.revision.value);
    const result = await request(
      'POST',
      `/v1/workspaces/${id}/agents/${event.currentTarget.elements.id.value}`,
      values,
    );
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存。'));
      return;
    }
    show('ok', '已更新。');
    await loadWorkspace();
    fillEdit(result.body.agent);
  });

  document.getElementById('archive-button').addEventListener('click', async () => {
    if (!canManage(actor)) return;
    const id = workspaceId();
    const result = await request(
      'POST',
      `/v1/workspaces/${id}/agents/${editForm.elements.id.value}/archive`,
      {revision: Number(editForm.elements.revision.value)},
    );
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法归档。'));
      return;
    }
    show('ok', '已归档，默认目录里不再显示。');
    await loadWorkspace();
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    editForm.hidden = true;
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

if (globalThis.document && globalThis.document.getElementById('create-form')) {
  mount(globalThis.document);
}
