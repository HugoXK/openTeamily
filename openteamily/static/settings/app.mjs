import { resolveTheme } from '../shell/app.mjs';

const KEYS = ['appearance', 'appearance_schedule', 'appearance_start', 'appearance_end', 'language',
              'chat_language', 'auto_translate', 'send_shortcut', 'message_folding', 'document_cards',
              'link_previews', 'task_completion_reminders', 'likes_visible', 'favorites_visible'];

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function readForm(form) {
  const data = new FormData(form);
  return {
    appearance: data.get('appearance'),
    appearance_schedule: data.get('appearance_schedule'),
    appearance_start: data.get('appearance_start'),
    appearance_end: data.get('appearance_end'),
    language: data.get('language'),
    chat_language: data.get('chat_language'),
    auto_translate: data.has('auto_translate'),
    send_shortcut: data.get('send_shortcut'),
    message_folding: data.get('message_folding'),
    document_cards: data.has('document_cards'),
    link_previews: data.has('link_previews'),
    task_completion_reminders: data.has('task_completion_reminders'),
    likes_visible: data.has('likes_visible'),
    favorites_visible: data.has('favorites_visible'),
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
  document.documentElement.lang = values.language || 'zh-CN';
  document.body.dataset.theme = values.appearance === 'system' ? '' : values.appearance;
  if (values.appearance === 'auto') {
    document.body.dataset.schedule = values.appearance_schedule || 'sunset_sunrise';
  } else {
    delete document.body.dataset.schedule;
  }
}

export function describeAppearance(values) {
  const theme = resolveTheme(values || { appearance: 'system' });
  const look = theme === 'dark' ? '深色' : '浅色';
  const appearance = values && values.appearance;
  if (appearance === 'light') return '当前为浅色。';
  if (appearance === 'dark') return '当前为深色。';
  if (appearance === 'auto' && values.appearance_schedule === 'custom') {
    return '当前为' + look + '。自定义时段的字段尚未与对照完整核对。';
  }
  if (appearance === 'auto') {
    return '当前为' + look + '。「日落到日出」目前按系统浅色或深色偏好估算，没有使用实际日出日落时刻。';
  }
  return '当前为' + look + '（跟随系统）。';
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
  for (const option of form.querySelectorAll('[name="appearance"], [name="appearance_schedule"], [name="send_shortcut"]')) {
    option.checked = option.value === values[option.name];
  }
  for (const name of ['appearance_start', 'appearance_end', 'language',
                      'chat_language', 'message_folding']) {
    form.elements[name].value = values[name];
  }
  for (const name of ['auto_translate', 'document_cards', 'link_previews', 'task_completion_reminders', 'likes_visible', 'favorites_visible']) {
    const field = form.elements[name];
    if (field) field.checked = values[name];
  }
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
    current = settings.body.settings.values;
    revision = settings.body.settings.revision;
    whoami.textContent = session.body.user.username;
    loginPanel.hidden = true;
    settingsPanel.hidden = false;
    fillForm(form, current);
    applyTheme(document, current);
    const appearanceStatus = document.getElementById('appearance-status');
    if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
    const languageCurrent = document.getElementById('language-current');
    const languageSelect = form.querySelector('select[name="language"]');
    if (languageCurrent && languageSelect) {
      const option = languageSelect.selectedOptions[0];
      languageCurrent.textContent = option ? option.textContent : '';
    }
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
        const keyText = model.body.model_api.api_key_set ? '已保存个人密钥（不会回显）。' : '未设置个人密钥。';
        document.getElementById('model-key-state').textContent = keyText;
        const keyDetail = document.getElementById('model-key-state-detail');
        if (keyDetail) keyDetail.textContent = keyText;
      }
    }
    await renderSkillSecrets();
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

  const appearanceBox = document.getElementById('appearance');
  if (appearanceBox) {
    appearanceBox.addEventListener('change', async () => {
      if (!current) return;
      const changes = diff(current, readForm(form));
      const appearanceChanges = {};
      for (const key of ['appearance', 'appearance_schedule', 'appearance_start', 'appearance_end']) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) appearanceChanges[key] = changes[key];
      }
      if (!Object.keys(appearanceChanges).length) return;
      const result = await request('POST', '/v1/settings', {revision, changes: appearanceChanges});
      if (result.status === 409) {
        current = result.body.error.current.values;
        revision = result.body.error.current.revision;
        fillForm(form, current);
        applyTheme(document, current);
        const appearanceStatus = document.getElementById('appearance-status');
        if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
        show('error', '设置已在别处更新，已重新加载。');
        return;
      }
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '无法更新外观。'));
        return;
      }
      current = result.body.settings.values;
      revision = result.body.settings.revision;
      fillForm(form, current);
      applyTheme(document, current);
      const appearanceStatus = document.getElementById('appearance-status');
      if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
      show('ok', '外观已更新。');
    });
  }

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
      const appearanceStatus = document.getElementById('appearance-status');
      if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
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
    const appearanceStatus = document.getElementById('appearance-status');
    if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
    show('ok', '已保存。');
  });

  async function renderSkillSecrets() {
    const list = document.getElementById('skill-secret-list');
    const skillForm = document.getElementById('skill-secrets-form');
    if (!list || !skillForm) return;
    list.textContent = '';
    const listed = await request('GET', '/v1/skill-secrets');
    if (listed.status !== 200) return;
    for (const item of listed.body.items) {
      const row = document.createElement('li');
      row.textContent = item.name + ' ';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        const result = await request('POST', '/v1/skill-secrets', {name: item.name, action: 'delete'});
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法删除技能密钥。'));
          return;
        }
        await renderSkillSecrets();
      });
      row.appendChild(remove);
      list.appendChild(row);
    }
  }

  const skillForm = document.getElementById('skill-secrets-form');
  if (skillForm) {
    skillForm.addEventListener('submit', async event => {
      event.preventDefault();
      const name = skillForm.elements.name.value.trim();
      const value = skillForm.elements.value.value;
      const result = await request('POST', '/v1/skill-secrets', {name, action: 'set', value});
      skillForm.elements.value.value = '';
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '保存技能密钥失败。'));
        return;
      }
      show('ok', '技能密钥已保存。');
      await renderSkillSecrets();
    });
  }

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
