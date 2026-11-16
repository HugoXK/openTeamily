export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function namesFromList(value) {
  if (!value || !String(value).trim()) return [];
  const seen = new Set();
  const names = [];
  for (const part of String(value).split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function scheduleFromForm(data) {
  const kind = data.get('kind') || 'now';
  const time_zone = data.get('time_zone') || 'Asia/Shanghai';
  if (kind === 'now') return {kind, time_zone};
  const schedule = {kind: kind === 'later' ? 'once' : kind, time: data.get('time') || '09:00', time_zone};
  if (kind === 'later') schedule.date = data.get('date') || '';
  if (kind === 'weekly') schedule.weekday = Number(data.get('weekday') || 1);
  if (kind === 'monthly') schedule.day = Number(data.get('day') || 1);
  return schedule;
}

export function readEditor(form) {
  const data = new FormData(form);
  return {
    title: (data.get('title') || '').trim(),
    template_id: data.get('template_id') || 'custom',
    intent: (data.get('intent') || '').trim(),
    scope: data.get('scope') || 'once',
    participants: namesFromList(data.get('participants')),
    agents: namesFromList(data.get('agents')),
    schedule: scheduleFromForm(data),
    prompt: data.get('prompt') || '',
    enabled: data.has('enabled'),
  };
}

export function tabCategory(value) {
  return value === 'work' || value === 'life' || value === 'mine' ? value : 'mine';
}

export function listQuery(category, search) {
  const params = new URLSearchParams();
  const tab = tabCategory(category);
  if (tab) params.set('category', tab);
  const needle = (search || '').trim();
  if (needle) params.set('q', needle);
  const text = params.toString();
  return text ? '?' + text : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function kindOf(schedule) {
  if (!schedule || !schedule.kind) return 'now';
  return schedule.kind === 'once' ? 'later' : schedule.kind;
}

function fillEditor(form, item, templates, username) {
  const schedule = (item && item.schedule) || {kind: 'now', time_zone: 'Asia/Shanghai'};
  const kind = kindOf(schedule);
  form.elements.template_id.value = (item && item.template_id) || 'custom';
  form.elements.intent.value = (item && item.intent) || '';
  form.elements.scope.value = (item && item.scope) || 'once';
  form.elements.participants.value = item && item.participants
    ? item.participants.map(row => row.username || row).join(', ')
    : (username || '');
  form.elements.agents.value = item && item.agents ? item.agents.join(', ') : '';
  for (const option of form.querySelectorAll('[name="kind"]')) {
    option.checked = option.value === kind;
  }
  form.elements.date.value = schedule.date || '';
  form.elements.time.value = schedule.time || '09:00';
  form.elements.weekday.value = String(schedule.weekday || 1);
  form.elements.day.value = String(schedule.day || 1);
  form.elements.time_zone.value = schedule.time_zone || 'Asia/Shanghai';
  form.elements.prompt.value = (item && item.prompt) || '';
  form.elements.enabled.checked = Boolean(item && item.enabled);
  form.elements.title.value = (item && item.title) || (templates.find(row => row.id === form.elements.template_id.value) || {}).title || '';
}

function renderList(items, list, empty, onOpen) {
  list.textContent = '';
  empty.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = item.title;
    open.addEventListener('click', () => onOpen(item));
    const meta = document.createElement('span');
    meta.className = 'note';
    meta.textContent = `${item.schedule && item.schedule.kind ? item.schedule.kind : ''} ${item.enabled ? '已启用' : '未启用'}`;
    row.appendChild(open);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const workspaceSelect = document.getElementById('workspace');
  const search = document.getElementById('search');
  let currentUser = null;
  let workspaces = [];
  let templates = [];
  let current = null;
  let category = 'mine';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
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

  function fillTemplates() {
    const select = form.elements.template_id;
    select.textContent = '';
    for (const item of templates) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      select.appendChild(option);
    }
  }

  function openEditor(item) {
    current = item;
    listPanel.hidden = true;
    form.hidden = false;
    fillEditor(form, item, templates, currentUser && currentUser.username);
    document.getElementById('remove-automation').hidden = !item || !item.id;
    document.getElementById('tick-automation').hidden = !item || !item.id;
    document.getElementById('life-note').hidden = category !== 'life';
  }

  async function loadList() {
    const id = workspaceId();
    if (!id) return;
    const listed = await request('GET', `/v1/workspaces/${id}/automations${listQuery(category, search.value)}`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取自动化列表。'));
      return;
    }
    renderList(listed.body.items || [], document.getElementById('automation-list'),
               document.getElementById('list-empty'), item => openEditor(item));
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
    const [space, catalog] = await Promise.all([
      request('GET', '/v1/workspaces?limit=100'),
      request('GET', '/v1/automation-templates'),
    ]);
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = space.body.items || [];
    templates = catalog.status === 200 ? (catalog.body.items || []) : [];
    fillTemplates();
    const previous = workspaceSelect.value;
    workspaceSelect.textContent = '';
    for (const item of workspaces) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    if (!workspaces.length) {
      document.getElementById('automation-list').textContent = '';
      document.getElementById('list-empty').hidden = false;
      document.getElementById('list-empty').textContent = '还没有工作区。';
      return;
    }
    document.getElementById('list-empty').textContent = '这个分类下还没有自动化。';
    form.hidden = true;
    listPanel.hidden = false;
    await loadList();
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

  workspaceSelect.addEventListener('change', () => loadList());
  search.addEventListener('input', () => loadList());
  for (const tab of document.querySelectorAll('.tabs [data-category]')) {
    tab.addEventListener('click', async () => {
      category = tabCategory(tab.dataset.category);
      for (const button of document.querySelectorAll('.tabs [data-category]')) {
        button.setAttribute('aria-selected', button === tab ? 'true' : 'false');
      }
      form.hidden = true;
      listPanel.hidden = false;
      await loadList();
    });
  }

  document.getElementById('new-automation').addEventListener('click', () => {
    openEditor(null);
    if (category === 'work') {
      const firstWork = templates.find(item => item.category === 'work');
      if (firstWork) {
        form.elements.template_id.value = firstWork.id;
        form.elements.title.value = firstWork.title;
      }
    }
    form.elements.kind.value = 'now';
    for (const option of form.querySelectorAll('[name="kind"]')) option.checked = option.value === 'now';
  });

  document.getElementById('cancel-editor').addEventListener('click', async () => {
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    await loadList();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = readEditor(form);
    if (!workspaceId()) {
      show('error', '先选择一个工作区。');
      return;
    }
    if (!values.title || !values.participants.length) {
      show('error', '请填写标题和至少一名参与成员。');
      return;
    }
    let result;
    if (current && current.id) {
      const changes = {
        title: values.title, prompt: values.prompt, schedule: values.schedule,
        participants: values.participants, enabled: values.enabled,
        intent: values.intent, scope: values.scope, agents: values.agents,
      };
      result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${current.id}`,
                             {revision: current.revision, changes});
    } else {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/automations`, {
        title: values.title, prompt: values.prompt, template_id: values.template_id,
        schedule: values.schedule, participants: values.participants,
        intent: values.intent, scope: values.scope, agents: values.agents,
      }, {'Idempotency-Key': idempotencyKey()});
      if (result.status === 201 && values.enabled && result.body.automation) {
        const created = result.body.automation;
        result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${created.id}`,
                               {revision: created.revision, changes: {enabled: true}});
      }
    }
    if (result.status === 409) {
      show('error', '自动化已在别处更新，请重新打开后再保存。');
      await loadList();
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.automation;
    fillEditor(form, current, templates, currentUser && currentUser.username);
    document.getElementById('remove-automation').hidden = false;
    document.getElementById('tick-automation').hidden = false;
    show('ok', '已保存。');
  });

  document.getElementById('tick-automation').addEventListener('click', async () => {
    if (!workspaceId()) return;
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/tick`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '触发失败。'));
      return;
    }
    show('ok', '已请求触发一次。这不会在网页进程里启动后台计时，也不等于容器里已经跑完。');
  });

  document.getElementById('remove-automation').addEventListener('click', async () => {
    if (!current || !current.id || !workspaceId()) return;
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${current.id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    show('ok', '已删除。');
    await loadList();
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    current = null;
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
