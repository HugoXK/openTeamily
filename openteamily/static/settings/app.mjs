const KEYS = ['appearance', 'language', 'send_shortcut', 'fold_long_messages', 'document_cards'];

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function readForm(form) {
  const data = new FormData(form);
  return {
    appearance: data.get('appearance'),
    language: data.get('language'),
    send_shortcut: data.get('send_shortcut'),
    fold_long_messages: data.has('fold_long_messages'),
    document_cards: data.has('document_cards'),
  };
}

export function diff(current, next) {
  const changes = {};
  for (const key of KEYS) {
    if (current[key] !== next[key]) changes[key] = next[key];
  }
  return changes;
}

export function applyTheme(document, values) {
  document.documentElement.lang = values.language === 'en' ? 'en' : 'zh-CN';
  document.body.dataset.theme = values.appearance === 'system' ? '' : values.appearance;
}

export function readModelForm(form) {
  const data = new FormData(form);
  const provider = data.get('provider') || '';
  const changes = {};
  if (provider) {
    changes.provider = provider;
    changes.base_url = data.get('base_url') || '';
    changes.model = data.get('model') || '';
  }
  const key = data.get('api_key');
  if (key) changes.api_key = key;
  return changes;
}

export function fillModelForm(form, values) {
  form.elements.provider.value = values && values.api_key_set ? (values.provider || '') : '';
  form.elements.base_url.value = values && values.api_key_set ? (values.base_url || '') : '';
  form.elements.model.value = values && values.api_key_set ? (values.model || '') : '';
  form.elements.api_key.value = '';
}

export function fillForm(form, values) {
  for (const option of form.querySelectorAll('[name="appearance"], [name="send_shortcut"]')) {
    option.checked = option.value === values[option.name];
  }
  form.elements.language.value = values.language;
  form.elements.fold_long_messages.checked = values.fold_long_messages;
  form.elements.document_cards.checked = values.document_cards;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const settingsPanel = document.getElementById('settings-panel');
  const whoami = document.getElementById('whoami');
  const form = document.getElementById('settings-form');
  const modelForm = document.getElementById('model-api-form');
  let revision = 0;
  let current = null;
  let modelRevision = 0;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body) {
    const headers = {'Accept': 'application/json'};
    const options = {method, headers, credentials: 'same-origin'};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrfCookie(document.cookie);
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(path, options);
    const payload = await response.json();
    return {status: response.status, body: payload};
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      settingsPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    const settings = await request('GET', '/v1/settings');
    if (settings.status !== 200) {
      show('error', messageFor(settings.body.error, '无法读取设置。'));
      return;
    }
    loginPanel.hidden = true;
    settingsPanel.hidden = false;
    whoami.textContent = session.body.user.username;
    current = settings.body.settings.values;
    revision = settings.body.settings.revision;
    fillForm(form, current);
    applyTheme(document, current);
    if (modelForm) {
      const model = await request('GET', '/v1/model-api');
      if (model.status === 200) {
        modelRevision = model.body.model_api.revision;
        fillModelForm(modelForm, model.body.model_api);
        const effective = model.body.effective || {};
        const source = effective.source === 'account' ? '正在使用你自己的配置' :
          effective.source === 'platform' ? '正在使用平台默认配置' : '还没有可用的模型 API';
        const label = effective.model ? `${source}（${effective.provider || ''} ${effective.model}）` : source;
        document.getElementById('model-effective').textContent = label;
        document.getElementById('model-key-state').textContent = model.body.model_api.api_key_set ? '已保存个人密钥（不会回显）。' : '未设置个人密钥。';
      }
    }
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
      button.dataset.provider = item.id;
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

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const changes = diff(current, readForm(form));
    if (!Object.keys(changes).length) {
      show('ok', '没有需要保存的更改。');
      return;
    }
    const result = await request('POST', '/v1/settings', {revision, changes});
    if (result.status === 409) {
      current = result.body.error.current.values;
      revision = result.body.error.current.revision;
      fillForm(form, current);
      applyTheme(document, current);
      show('error', '设置已在别处更新，已重新加载，请再保存一次。');
      return;
    }
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.settings.values;
    revision = result.body.settings.revision;
    fillForm(form, current);
    applyTheme(document, current);
    show('ok', '已保存。');
  });

  if (modelForm) {
    modelForm.addEventListener('submit', async event => {
      event.preventDefault();
      const changes = readModelForm(modelForm);
      if (!Object.keys(changes).length) {
        show('ok', '没有需要保存的模型 API 更改。');
        return;
      }
      const result = await request('POST', '/v1/model-api', {revision: modelRevision, changes});
      modelForm.elements.api_key.value = '';
      if (result.status === 409) {
        show('error', '模型 API 已在别处更新，已重新加载，请再保存一次。');
        await load();
        return;
      }
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '保存模型 API 失败。'));
        return;
      }
      show('ok', '模型 API 已保存。');
      await load();
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    current = null;
    revision = 0;
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('settings-form')) {
  mount(globalThis.document);
}
