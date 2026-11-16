export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const EXPIRY_SECONDS = {d7: 7 * 86400, d30: 30 * 86400, d90: 90 * 86400};

export function readKeyForm(form) {
  const data = new FormData(form);
  const body = {name: (data.get('name') || '').trim()};
  const period = data.get('expires') || 'never';
  if (period !== 'never' && EXPIRY_SECONDS[period]) body.expires_in = EXPIRY_SECONDS[period];
  return body;
}

export function installCommands(origin) {
  const base = (origin || '').replace(/\/$/, '');
  return {
    unix: `curl -fsSL ${base}/install/flybot.sh | sh`,
    windows: `irm ${base}/install/flybot.ps1 | iex`,
    daemon: `flybot daemon start --origin ${base} --key <runtime-key>`,
  };
}

export function listItemHasSecret(item) {
  return Boolean(item && Object.prototype.hasOwnProperty.call(item, 'token'));
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatExpiry(expires) {
  if (!expires) return '永不过期';
  return '过期时间 ' + String(expires);
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), origin} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const runtimesPanel = document.getElementById('runtimes-panel');
  const connectPanel = document.getElementById('connect-panel');
  const host = origin || (globalThis.location && globalThis.location.origin) || '';
  let currentUser = null;
  let tab = 'runtimes';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function showTab(name) {
    tab = name === 'connect' ? 'connect' : 'runtimes';
    runtimesPanel.hidden = tab !== 'runtimes';
    connectPanel.hidden = tab !== 'connect';
    for (const button of document.querySelectorAll('.tabs [data-tab]')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
  }

  function fillCommands() {
    const commands = installCommands(host);
    const unix = document.getElementById('install-unix');
    const windows = document.getElementById('install-windows');
    const daemon = document.getElementById('daemon-command');
    if (unix) unix.textContent = commands.unix;
    if (windows) windows.textContent = commands.windows;
    if (daemon) daemon.textContent = commands.daemon;
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

  function renderKeys(items) {
    const list = document.getElementById('key-list');
    const empty = document.getElementById('keys-empty');
    list.textContent = '';
    empty.hidden = items.length > 0;
    for (const item of items) {
      if (listItemHasSecret(item)) continue;
      const row = document.createElement('li');
      const meta = document.createElement('span');
      const state = item.revoked ? '已撤销' : formatExpiry(item.expires);
      meta.textContent = `${item.name} · ${item.prefix}… · ${state}`;
      row.appendChild(meta);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', () => revokeKey(item));
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  async function revokeKey(item) {
    const result = await request('POST', `/v1/runtime-keys/${item.id}/revoke`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法撤销密钥。'));
      return;
    }
    show('ok', '已撤销密钥。');
    await loadKeys();
  }

  async function loadKeys() {
    const listed = await request('GET', '/v1/runtime-keys');
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取运行时密钥。'));
      return;
    }
    document.getElementById('device-id').textContent = listed.body.device_id || '';
    renderKeys(listed.body.items || []);
  }

  async function load() {
    fillCommands();
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
    await loadKeys();
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

  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.getElementById('open-connect').addEventListener('click', () => showTab('connect'));

  document.getElementById('key-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = readKeyForm(event.currentTarget);
    if (!values.name) {
      show('error', '请填写密钥名称。');
      return;
    }
    const result = await request('POST', '/v1/runtime-keys', values);
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法生成密钥。'));
      return;
    }
    const box = document.getElementById('issued-token');
    box.hidden = false;
    box.textContent = result.body.token
      ? `密钥只显示一次：${result.body.token}`
      : '已生成密钥，但响应里没有令牌。';
    event.currentTarget.reset();
    show('ok', '已生成密钥。完整密钥只显示这一次，列表只保留前缀。');
    await loadKeys();
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

if (globalThis.document && globalThis.document.getElementById('key-form')) {
  mount(globalThis.document);
}
