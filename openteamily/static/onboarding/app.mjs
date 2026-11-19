function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
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
  const form = document.getElementById('onboarding-form');
  const select = document.getElementById('industry');
  const roleChoices = document.getElementById('role-choices');
  const roleLocked = document.getElementById('role-locked');
  const customIndustryLabel = document.getElementById('custom-industry-label');
  const customIndustry = document.getElementById('custom-industry');
  const customRoleLabel = document.getElementById('custom-role-label');
  const customRole = document.getElementById('custom-role');
  if (!status || !loginPanel || !mainPanel || !form) return;
  let industries = [];
  let current = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function populateIndustries() {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择你的行业';
    select.append(placeholder);
    for (const row of industries) {
      const option = document.createElement('option');
      option.value = row.name;
      option.textContent = row.name;
      select.append(option);
    }
  }

  function renderRoles() {
    const name = select.value;
    const row = industries.find(item => item.name === name);
    roleChoices.replaceChildren();
    customIndustryLabel.hidden = name !== '其他';
    customRoleLabel.hidden = true;
    roleLocked.hidden = Boolean(name);
    if (!name) return;
    const roles = row ? row.roles : [];
    const values = new Set(roles);
    for (const role of roles) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'role';
      radio.value = role;
      radio.addEventListener('change', () => {
        customRoleLabel.hidden = radio.value !== '其他';
        if (radio.value === '其他') customRole.focus();
      });
      label.append(radio, document.createTextNode(role));
      roleChoices.append(label);
    }
    if (!roles.length) {
      customRoleLabel.hidden = false;
      return;
    }
    if (current && current.industry === name && current.role) {
      if (values.has(current.role)) {
        const radio = roleChoices.querySelector('input[name="role"][value="' + CSS.escape(current.role) + '"]');
        if (radio) radio.checked = true;
        customRoleLabel.hidden = current.role !== '其他';
      } else {
        customRoleLabel.hidden = false;
        customRole.value = current.role;
      }
    }
  }

  function chosenRole() {
    const checked = roleChoices.querySelector('input[name="role"]:checked');
    if (checked) return checked.value === '其他' ? customRole.value.trim() : checked.value;
    return customRole.value.trim();
  }

  function fill(state) {
    current = state;
    select.value = state && state.industry && industries.some(item => item.name === state.industry)
      ? state.industry : (state && state.industry ? '其他' : '');
    if (select.value === '其他' && state && state.industry && state.industry !== '其他') {
      customIndustry.value = state.industry;
    }
    customRole.value = state && state.role || '';
    renderRoles();
    const meta = document.getElementById('onboarding-meta');
    if (state && state.completed) {
      meta.textContent = '已完成' + (state.industry ? ' · ' + state.industry + (state.role ? ' · ' + state.role : '') : '') + '，可随时修改。';
    } else {
      meta.textContent = '';
    }
  }

  function renderChecklist(steps) {
    const list = document.getElementById('onboarding-checklist');
    if (!list) return;
    list.replaceChildren();
    for (const [index, step] of steps.entries()) {
      const row = document.createElement('li');
      row.dataset.state = step.state;
      row.className = step.state === 'done' ? 'note' : '';
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = step.state === 'done' ? '✓ ' : (index + 1) + '. ';
      const label = document.createElement('strong');
      label.textContent = step.title;
      row.append(mark, label, document.createTextNode(' — ' + step.detail));
      list.append(row);
    }
    const ready = document.getElementById('onboarding-ready');
    if (!ready) return;
    const done = steps.every(step => step.state === 'done');
    ready.hidden = !done;
    if (!done) {
      ready.replaceChildren();
      return;
    }
    const link = document.createElement('a');
    link.setAttribute('href', '/chat');
    link.setAttribute('role', 'button');
    link.textContent = '去聊天';
    ready.replaceChildren(document.createTextNode('可以开始了：'), link);
  }

  async function loadChecklist() {
    const steps = [
      {title: '创建工作区', state: 'unknown', detail: ''},
      {title: '邀请一位同事', state: 'unknown', detail: ''},
      {title: '发出第一条消息', state: 'unknown', detail: ''},
    ];
    const listed = await request('GET', '/v1/workspaces?limit=100');
    if (listed.status !== 200) {
      for (const step of steps) step.detail = '读取工作区失败，需要登录一个有权限的账号才能判断。';
      renderChecklist(steps);
      return;
    }
    const workspaces = listed.body.items || [];
    if (!workspaces.length) {
      steps[0].state = 'pending';
      steps[0].detail = '还没有工作区：到聊天页新建一个。';
      steps[1].detail = '需要你先创建工作区才能判断。';
      steps[2].detail = '需要你先创建工作区才能判断。';
      renderChecklist(steps);
      return;
    }
    const space = workspaces[0];
    steps[0].state = 'done';
    steps[0].detail = '已有工作区「' + (space.name || space.id) + '」。';
    const members = await request('GET', '/v1/workspaces/' + space.id + '/members');
    if (members.status !== 200) {
      steps[1].detail = '读取成员失败，暂时无法判断。';
    } else {
      const count = (members.body.items || []).length;
      steps[1].state = count > 1 ? 'done' : 'pending';
      steps[1].detail = count > 1
        ? '已有 ' + count + ' 位成员。'
        : '目前只有你：邀请一位同事加入这个工作区。';
    }
    let messagesKnown = false;
    let hasMessages = false;
    const agents = await request('GET', '/v1/workspaces/' + space.id + '/agents?limit=100');
    if (agents.status === 200) {
      messagesKnown = true;
      for (const agent of (agents.body.items || []).slice(0, 5)) {
        const talks = await request('GET', '/v1/workspaces/' + space.id + '/agents/' + agent.id + '/conversations?limit=1');
        if (talks.status === 200 && (talks.body.items || []).length) {
          hasMessages = true;
          break;
        }
      }
    }
    const social = await request('GET', '/v1/workspaces/' + space.id + '/social/conversations?limit=1');
    if (social.status === 200) {
      messagesKnown = true;
      if ((social.body.items || []).length) hasMessages = true;
    }
    if (!messagesKnown) {
      steps[2].detail = '读取消息失败，暂时无法判断。';
    } else if (hasMessages) {
      steps[2].state = 'done';
      steps[2].detail = '已经有消息了。';
    } else {
      steps[2].state = 'pending';
      steps[2].detail = '还没有消息：到聊天页发出第一条。';
    }
    renderChecklist(steps);
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
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = session.body.user.username;
    document.getElementById('whoami').dataset.username = session.body.user.username;
    loadChecklist();
    const result = await request('GET', '/v1/onboarding');
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法读取工作背景。'));
      return;
    }
    industries = result.body.industries || [];
    populateIndustries();
    fill(result.body.onboarding);
  }

  select.addEventListener('change', () => {
    current = null;
    customRole.value = '';
    renderRoles();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    let industry = select.value;
    if (industry === '其他') industry = customIndustry.value.trim();
    const role = chosenRole();
    if (!industry) {
      show('error', '请选择或填写行业。');
      return;
    }
    if (!role) {
      show('error', '请选择或填写角色。');
      return;
    }
    const result = await request('POST', '/v1/onboarding', {industry, role, completed: true});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    globalThis.location.assign('/chat');
  });

  document.getElementById('onboarding-skip').addEventListener('click', async () => {
    const result = await request('POST', '/v1/onboarding', {industry: '', role: '', completed: true});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '暂时跳过失败。'));
      return;
    }
    globalThis.location.assign('/chat');
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
