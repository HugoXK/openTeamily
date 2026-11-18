function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function sanitizeHandle(username) {
  let text = String(username || '').toLowerCase().replace(/[^a-z0-9._]+/g, '.');
  text = text.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  if (text.length < 3) text = (text + 'user').slice(0, 30);
  text = text.slice(0, 30).replace(/\.+$/g, '');
  return text || 'user';
}

export function parseTags(text) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(text || '').split(/[,，]/)) {
    const tag = raw.trim().slice(0, 20);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('profile-form');
  if (!status || !loginPanel || !mainPanel || !form) return;
  const goals = ['health', 'finance', 'career', 'hobbies', 'family', 'productivity', 'other'];
  let revision = 0;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function fill(profile, username) {
    const value = profile || {};
    form.elements.name.value = value.name || username || '';
    form.elements.handle.value = value.handle || sanitizeHandle(username);
    form.elements.bio.value = value.bio || '';
    form.elements.tags.value = (value.tags || []).join(', ');
    form.elements.gender.value = value.gender || '';
    form.elements.location.value = value.location || '';
    form.elements.website.value = value.website || '';
    for (const key of goals) {
      const input = document.getElementById('goal-' + key);
      if (input) input.value = (value.goals && value.goals[key]) || '';
    }
    revision = Number(value.revision || 0);
    const meta = document.getElementById('profile-meta');
    meta.textContent = revision
      ? '修订 ' + revision + ' · Teamily ID 可用于公开资料地址'
      : '还没有保存过资料。保存后会生成 Teamily ID。';
    const link = document.getElementById('profile-public');
    if (link) link.href = value.handle ? '/p/' + encodeURIComponent(value.handle) : '/v1/profile';
  }

  function collect() {
    const changes = {
      name: form.elements.name.value.trim(),
      handle: form.elements.handle.value.trim(),
      bio: form.elements.bio.value,
      tags: parseTags(form.elements.tags.value),
      gender: form.elements.gender.value,
      location: form.elements.location.value.trim(),
      website: form.elements.website.value.trim(),
      goals: {},
    };
    for (const key of goals) {
      const input = document.getElementById('goal-' + key);
      if (input) changes.goals[key] = input.value;
    }
    return changes;
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    const username = session.body.user.username;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = username;
    whoami.textContent = username;
    document.getElementById('profile-username').textContent = username;
    const result = await request('GET', '/v1/profile');
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法读取资料。'));
      return;
    }
    fill(result.body.profile, username);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const changes = collect();
    if (!changes.name) {
      show('error', '请填写昵称。');
      return;
    }
    const result = await request('POST', '/v1/profile', {revision, changes});
    if (result.status === 409) {
      const current = result.body && result.body.error && result.body.error.current;
      if (current) fill(current, document.getElementById('profile-username').textContent);
      show('error', messageFor(result.body.error, '资料已在别处更新，已重新加载。'));
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    fill(result.body.profile, document.getElementById('profile-username').textContent);
    show('ok', '资料已保存。');
  });

  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !['TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(event.target.tagName)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  const login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/login', {
        username: login.elements.username.value,
        password: login.elements.password.value,
      });
      if (result.status !== 200) {
        show('error', messageFor(result.body && result.body.error, '无法登录。'));
        return;
      }
      login.reset();
      await load();
    });
  }

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      await request('POST', '/v1/auth/logout', {});
      await load();
    });
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
