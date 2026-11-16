export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function listQuery(needle, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function actionQuery(needle, status, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function dueDateValue(dueAt) {
  if (dueAt == null || dueAt === '') return '';
  const date = new Date(Number(dueAt) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function dueAtFromDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function applyTheme(settings) {
  const appearance = settings && settings.appearance;
  document.body.dataset.theme = appearance === 'dark' || appearance === 'light' ? appearance : '';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const listEl = document.getElementById('memory-list');
  const emptyEl = document.getElementById('list-empty');
  const editor = document.getElementById('editor-form');
  const actionEditor = document.getElementById('action-editor-form');
  const listPanel = document.getElementById('list-panel');
  let currentUser = null;
  let workspaces = [];
  let currentPage = null;
  let currentAction = null;
  let pageChoices = [];

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

  function randomKey() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function renderList(items) {
    listEl.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.title;
      button.dataset.id = item.id;
      button.addEventListener('click', () => openPage(item.id));
      li.appendChild(button);
      listEl.appendChild(li);
    }
    emptyEl.hidden = items.length > 0;
  }

  function fillPageSelect(select, selected) {
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不关联';
    select.appendChild(empty);
    for (const page of pageChoices) {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title;
      select.appendChild(option);
    }
    select.value = selected || '';
  }

  function renderActions(items) {
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const due = dueDateValue(item.due_at);
      const linked = item.memory_page_title ? ` · ${item.memory_page_title}` : '';
      button.textContent = `${item.status === 'done' ? '已完成' : '未完成'} · ${item.title}${due ? ` · ${due}` : ''}${linked}`;
      button.dataset.id = item.id;
      button.addEventListener('click', () => openAction(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = items.length > 0;
  }

  async function loadActions() {
    const id = workspaceId();
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    if (!id) {
      renderActions([]);
      return;
    }
    const status = document.getElementById('action-filter').value;
    const listed = await request('GET', `/v1/workspaces/${id}/memory/actions${actionQuery('', status)}`);
    if (listed.status !== 200) {
      if (list) list.replaceChildren();
      if (empty) empty.hidden = true;
      show('error', messageFor(listed.body.error, '无法加载下一步行动。'));
      return;
    }
    renderActions(listed.body.items || []);
  }

  async function loadSession() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200 || !session.body.user) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      editor.hidden = true;
      if (actionEditor) actionEditor.hidden = true;
      await renderProviders();
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = '已登录：' + currentUser.username;
    const prefs = await request('GET', '/v1/settings');
    if (prefs.status === 200) applyTheme(prefs.body.settings);
    const listed = await request('GET', '/v1/workspaces');
    workspaces = listed.status === 200 && listed.body.items ? listed.body.items : [];
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.appendChild(option);
    }
    if (!workspaceSelect.value && workspaces[0]) workspaceSelect.value = workspaces[0].id;
    await loadWorkspace();
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

  async function loadWorkspace() {
    const id = workspaceId();
    currentPage = null;
    currentAction = null;
    editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    listPanel.hidden = false;
    if (!id) {
      pageChoices = [];
      renderList([]);
      fillPageSelect(document.getElementById('new-action-page'), '');
      renderActions([]);
      return;
    }
    const needle = document.getElementById('search').value.trim();
    const listed = await request('GET', `/v1/workspaces/${id}/memory${listQuery(needle)}`);
    if (listed.status !== 200) {
      pageChoices = [];
      renderList([]);
      renderActions([]);
      show('error', messageFor(listed.body.error, '无法加载记忆页。'));
      return;
    }
    pageChoices = listed.body.items || [];
    renderList(pageChoices);
    fillPageSelect(document.getElementById('new-action-page'), '');
    await loadActions();
  }

  async function openPage(pageId) {
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/${pageId}`);
    if (seen.status !== 200 || !seen.body.page) {
      show('error', messageFor(seen.body.error, '无法打开记忆页。'));
      return;
    }
    currentPage = seen.body.page;
    currentAction = null;
    listPanel.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    editor.hidden = false;
    editor.elements.title.value = currentPage.title;
    editor.elements.body.value = currentPage.body || '';
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
  }

  async function openAction(actionId) {
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/actions/${actionId}`);
    if (seen.status !== 200 || !seen.body.action) {
      show('error', messageFor(seen.body.error, '无法打开下一步行动。'));
      return;
    }
    currentAction = seen.body.action;
    currentPage = null;
    listPanel.hidden = true;
    editor.hidden = true;
    actionEditor.hidden = false;
    actionEditor.elements.title.value = currentAction.title;
    actionEditor.elements.notes.value = currentAction.notes || '';
    actionEditor.elements.status.value = currentAction.status;
    actionEditor.elements.due.value = dueDateValue(currentAction.due_at);
    fillPageSelect(actionEditor.elements.memory_page_id, currentAction.memory_page_id || '');
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
  }

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    show('ok', '已登录。');
    await loadSession();
  });

  document.getElementById('logout-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法退出登录。'));
      return;
    }
    currentUser = null;
    currentPage = null;
    currentAction = null;
    show('ok', '已退出登录。');
    await loadSession();
  });

  workspaceSelect.addEventListener('change', () => loadWorkspace());
  document.getElementById('search').addEventListener('input', () => loadWorkspace());
  document.getElementById('action-filter').addEventListener('change', () => loadActions());

  document.getElementById('new-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) return;
    const title = document.getElementById('new-title').value.trim();
    const created = await fetcher(`/v1/workspaces/${id}/memory`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({title, body: ''}),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建记忆页。'));
      return;
    }
    document.getElementById('new-title').value = '';
    show('ok', '已创建记忆页。');
    await openPage(parsed.page.id);
  });

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentPage) return;
    const saved = await request('POST', `/v1/workspaces/${id}/memory/${currentPage.id}`, {
      revision: currentPage.revision,
      changes: {title: editor.elements.title.value, body: editor.elements.body.value},
    });
    if (saved.status !== 200 || !saved.body.page) {
      show('error', messageFor(saved.body.error, '无法保存记忆页。'));
      return;
    }
    currentPage = saved.body.page;
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
    show('ok', '已保存。');
  });

  document.getElementById('delete-page').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id || !currentPage) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/${currentPage.id}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除记忆页。'));
      return;
    }
    show('ok', '已删除。');
    await loadWorkspace();
  });

  document.getElementById('close-editor').addEventListener('click', () => loadWorkspace());

  document.getElementById('new-action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) return;
    const title = document.getElementById('new-action-title').value.trim();
    const notes = document.getElementById('new-action-notes').value;
    const dueAt = dueAtFromDate(document.getElementById('new-action-due').value);
    const pageId = document.getElementById('new-action-page').value || null;
    const payload = {title, notes};
    if (dueAt != null) payload.due_at = dueAt;
    if (pageId) payload.memory_page_id = pageId;
    const created = await fetcher(`/v1/workspaces/${id}/memory/actions`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建下一步行动。'));
      return;
    }
    document.getElementById('new-action-title').value = '';
    document.getElementById('new-action-notes').value = '';
    document.getElementById('new-action-due').value = '';
    document.getElementById('new-action-page').value = '';
    show('ok', '已创建下一步行动。');
    await openAction(parsed.action.id);
  });

  actionEditor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentAction) return;
    const saved = await request('POST', `/v1/workspaces/${id}/memory/actions/${currentAction.id}`, {
      revision: currentAction.revision,
      changes: {
        title: actionEditor.elements.title.value,
        notes: actionEditor.elements.notes.value,
        status: actionEditor.elements.status.value,
        due_at: dueAtFromDate(actionEditor.elements.due.value),
        memory_page_id: actionEditor.elements.memory_page_id.value || null,
      },
    });
    if (saved.status !== 200 || !saved.body.action) {
      show('error', messageFor(saved.body.error, '无法保存下一步行动。'));
      return;
    }
    currentAction = saved.body.action;
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
    show('ok', '已保存。');
  });

  document.getElementById('delete-action').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id || !currentAction) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/actions/${currentAction.id}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除下一步行动。'));
      return;
    }
    show('ok', '已删除。');
    await loadWorkspace();
  });

  document.getElementById('close-action-editor').addEventListener('click', () => loadWorkspace());

  loadSession();
}

if (typeof document !== 'undefined' && document.getElementById('login-form')) {
  mount(document);
}
