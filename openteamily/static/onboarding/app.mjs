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

const LOOK_LABELS = {color: '颜色', expression: '表情', headwear: '头饰', glasses: '眼镜', hand: '手持'};

export function lookSummary(look) {
  if (!look) return '还没有选择形象。';
  return Object.keys(LOOK_LABELS).map(name => `${LOOK_LABELS[name]}：${look[name]}`).join(' · ');
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

  async function judgeAgents(step, spaces) {
    let total = 0;
    let firstName = '';
    let failed = false;
    for (const space of spaces) {
      const agents = await request('GET', '/v1/workspaces/' + space.id + '/agents?limit=100');
      if (agents.status !== 200) {
        failed = true;
        continue;
      }
      const items = agents.body.items || [];
      total += items.length;
      if (!firstName && items.length && items[0].name) firstName = items[0].name;
    }
    if (total) {
      step.state = 'done';
      step.detail = '已有 ' + total + ' 个智能体' + (firstName ? '，其中「' + firstName + '」' : '') + '。';
    } else if (failed) {
      step.state = 'unknown';
      step.detail = '读取智能体失败，暂时无法判断。';
    } else {
      step.state = 'pending';
      step.detail = '还没有智能体：到智能体页创建一个。';
    }
  }

  async function judgeAutomations(step, spaces) {
    let automations = 0;
    let runsKnown = false;
    let ran = false;
    let listFailed = false;
    let runFailed = false;
    for (const space of spaces) {
      const listed = await request('GET', '/v1/workspaces/' + space.id + '/automations');
      if (listed.status !== 200) {
        listFailed = true;
        continue;
      }
      const items = listed.body.items || [];
      automations += items.length;
      for (const item of items) {
        const runs = await request('GET', '/v1/workspaces/' + space.id + '/automations/' + item.id + '/runs?limit=20');
        if (runs.status !== 200) {
          runFailed = true;
          continue;
        }
        runsKnown = true;
        if ((runs.body.items || []).some(run => run.status === 'succeeded' || run.status === 'failed')) {
          ran = true;
        }
      }
      if (ran) break;
    }
    if (ran) {
      step.state = 'done';
      step.detail = '已经有自动化执行记录。';
    } else if (!automations) {
      if (listFailed) {
        step.state = 'unknown';
        step.detail = '读取自动化失败，暂时无法判断。';
      } else {
        step.state = 'pending';
        step.detail = '还没有自动化：到自动化页创建一条。';
      }
    } else if (!runsKnown && runFailed) {
      step.state = 'unknown';
      step.detail = '读取运行记录失败，暂时无法判断。';
    } else {
      step.state = 'pending';
      step.detail = '自动化还没有执行过：到自动化页跑一次。';
    }
  }

  async function judgeRuntime(step) {
    const runtimes = await request('GET', '/v1/runtime/connections');
    if (runtimes.status !== 200) {
      step.detail = '读取运行时失败，暂时无法判断。';
      return;
    }
    const items = runtimes.body.items || [];
    const online = items.filter(item => item.status === 'online').length;
    if (online) {
      step.state = 'done';
      step.detail = '已有 ' + online + ' 个运行时在线。';
    } else if (items.length) {
      step.state = 'pending';
      step.detail = '运行时当前离线：重新启动它就能继续。';
    } else {
      step.state = 'pending';
      step.detail = '还没有连接运行时：到运行时页按提示连接。';
    }
  }

  async function judgeChecklist(steps) {
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const spaces = listed.status === 200 ? (listed.body.items || []) : [];
    if (listed.status !== 200) {
      steps[0].detail = '读取工作区失败，需要登录一个有权限的账号才能判断。';
      steps[2].detail = '读取工作区失败，需要登录一个有权限的账号才能判断。';
    } else if (!spaces.length) {
      steps[0].detail = '需要你先创建工作区才能判断。';
      steps[2].detail = '需要你先创建工作区才能判断。';
    } else {
      // Every workspace counts: a second workspace may hold the agent and the
      // finished run, so judging only the first one would report "还没有" for a
      // user who already has them.
      await judgeAgents(steps[0], spaces);
      await judgeAutomations(steps[2], spaces);
    }
    await judgeRuntime(steps[1]);
  }

  async function loadChecklist() {
    const steps = [
      {title: '建智能体', state: 'unknown', detail: ''},
      {title: '连运行时', state: 'unknown', detail: ''},
      {title: '跑一次自动化', state: 'unknown', detail: ''},
    ];
    try {
      await judgeChecklist(steps);
    } catch {
      // A thrown request must not leave the block blank: keep the three rows,
      // say why they are unknown, and never tick them. A transport failure also
      // means later requests cannot be trusted, so nothing else is judged here.
      for (const step of steps) {
        if (step.state === 'done') continue;
        step.state = 'unknown';
        if (!step.detail) step.detail = '读取时出错，暂时无法判断。';
      }
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
    await loadChecklist();
    const result = await request('GET', '/v1/onboarding');
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法读取工作背景。'));
      return;
    }
    industries = result.body.industries || [];
    populateIndustries();
    fill(result.body.onboarding);
    renderSteps(result.body.steps, result.body.onboarding);
  }

  function renderSteps(steps, state) {
    const section = document.getElementById('onboarding-steps');
    if (!section) return;
    section.hidden = !steps || !state || !state.completed;
    if (section.hidden) return;
    const apps = document.getElementById('onboarding-apps');
    apps.textContent = '';
    for (const app of steps.apps || []) {
      const li = document.createElement('li');
      li.textContent = `${app.name} · 未连接`;
      apps.appendChild(li);
    }
    const picks = document.getElementById('onboarding-picks');
    picks.textContent = '';
    for (const item of steps.recommendations || []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'pick';
      box.value = item.key;
      box.checked = (steps.picks || []).includes(item.key);
      label.append(box, ` ${item.title}（${item.kind === 'routine' ? '例行' : '一次性'}）`);
      label.title = item.summary;
      picks.appendChild(label);
    }
    const look = document.getElementById('onboarding-look');
    look.textContent = '';
    for (const [name, options] of Object.entries(steps.look_options || {})) {
      const label = document.createElement('label');
      const choice = document.createElement('select');
      choice.name = name;
      for (const value of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        choice.appendChild(option);
      }
      if (steps.look && steps.look[name]) choice.value = steps.look[name];
      label.append(`${LOOK_LABELS[name] || name} `, choice);
      look.appendChild(label);
    }
    document.getElementById('onboarding-look-preview').textContent = lookSummary(steps.look);
    document.getElementById('onboarding-steps-meta').textContent =
      `已选 ${(steps.picks || []).length} 项 · ` + (steps.look ? '形象已保存' : '形象未保存');
  }

  async function saveStep(path, body, okText) {
    const result = await request('POST', path, body);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    renderSteps(result.body.steps, current || {completed: true});
    show('ok', okText);
  }

  const picksForm = document.getElementById('onboarding-picks-form');
  if (picksForm) picksForm.addEventListener('submit', event => {
    event.preventDefault();
    const chosen = [...document.getElementById('onboarding-picks').querySelectorAll('input[name="pick"]')]
      .filter(box => box.checked).map(box => box.value);
    saveStep('/v1/onboarding/picks', {picks: chosen}, '已保存选择（不会自动创建例行任务）。');
  });

  const lookForm = document.getElementById('onboarding-look-form');
  if (lookForm) lookForm.addEventListener('submit', event => {
    event.preventDefault();
    const look = {};
    for (const choice of document.getElementById('onboarding-look').querySelectorAll('select')) look[choice.name] = choice.value;
    saveStep('/v1/onboarding/look', {look}, '已保存 Agent 形象。');
  });

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
