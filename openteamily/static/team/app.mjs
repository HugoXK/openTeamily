export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function validName(value) {
  const name = (value || '').trim();
  return name.length >= 1 && name.length <= 60;
}

export function validSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(value || '');
}

export function readWizard(form) {
  const data = new FormData(form);
  const mode = data.get('mode') || 'new';
  return {
    name: (data.get('name') || '').trim(),
    slug: (data.get('slug') || '').trim(),
    mode,
    workspace_id: mode === 'convert' ? (data.get('workspace_id') || '') : undefined,
  };
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

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('wizard-form');
  let step = 1;
  let owned = [];

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

  function renderStep() {
    for (const marker of document.querySelectorAll('#steps [data-step]')) {
      marker.setAttribute('aria-current', Number(marker.dataset.step) === step ? 'step' : 'false');
    }
    for (const index of [1, 2, 3]) {
      document.getElementById('step-' + index).hidden = index !== step;
    }
    document.getElementById('back').hidden = step === 1;
    document.getElementById('next').hidden = step === 3;
    document.getElementById('submit').hidden = step !== 3;
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
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = session.body.user.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const items = listed.status === 200 ? (listed.body.items || []) : [];
    owned = items.filter(item => item.owner_id === session.body.user.id && item.kind !== 'team');
    const select = form.elements.workspace_id;
    select.textContent = '';
    for (const item of owned) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    }
    renderStep();
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

  document.getElementById('next').addEventListener('click', () => {
    const values = readWizard(form);
    if (step === 1 && !validName(values.name)) {
      show('error', '团队名称需要 1 到 60 个字。');
      return;
    }
    if (step === 2 && !validSlug(values.slug)) {
      show('error', '团队 ID 需要 3 到 30 个小写字母、数字或连字符。');
      return;
    }
    show('', '');
    step += 1;
    renderStep();
  });

  document.getElementById('back').addEventListener('click', () => {
    step = Math.max(1, step - 1);
    renderStep();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = readWizard(form);
    if (!validName(values.name) || !validSlug(values.slug)) {
      show('error', '请先填好名称和团队 ID。');
      return;
    }
    if (values.mode === 'convert' && !values.workspace_id) {
      show('error', '请选择要转换的工作区。');
      return;
    }
    const body = {name: values.name, slug: values.slug, mode: values.mode};
    if (values.mode === 'convert') body.workspace_id = values.workspace_id;
    const result = await request('POST', '/v1/teams', body, {'Idempotency-Key': idempotencyKey()});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '创建团队失败。'));
      return;
    }
    show('ok', values.mode === 'convert' ? '当前工作区已转成团队。' : '已创建独立团队工作区。');
    await load();
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    step = 1;
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('wizard-form')) {
  mount(globalThis.document);
}
