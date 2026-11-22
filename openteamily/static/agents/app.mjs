import { createLookAvatar } from '../look/app.mjs';
import { csrfCookie, canManage, idempotencyKey } from '../shell/chat-utils.mjs';

export { csrfCookie, canManage, idempotencyKey, statusLabel } from '../shell/chat-utils.mjs';

// Two-letter card monogram ("Slides Assistant" -> "SA"; CJK names keep one glyph).
export function agentMonogram(name) {
  const text = String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '?';
  if (/^\p{Script=Han}/u.test(words[0])) return words[0].slice(0, 1);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

export function agentTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export const AGENT_CATEGORIES = [
  {slug: 'content-creation', label: 'Content Creation'},
  {slug: 'customer-support', label: 'Customer Support'},
  {slug: 'data-analysis', label: 'Data Analysis'},
  {slug: 'design', label: 'Design'},
  {slug: 'education', label: 'Education'},
  {slug: 'engineering', label: 'Engineering'},
  {slug: 'finance', label: 'Finance'},
  {slug: 'it-security', label: 'IT & Security'},
  {slug: 'investment', label: 'Investment'},
  {slug: 'legal', label: 'Legal'},
  {slug: 'life', label: 'Life'},
  {slug: 'marketing', label: 'Marketing'},
  {slug: 'operations', label: 'Operations'},
  {slug: 'product', label: 'Product'},
  {slug: 'recruiting', label: 'Recruiting'},
  {slug: 'research', label: 'Research'},
  {slug: 'sales', label: 'Sales'},
];

const AGENT_CATEGORY_SLUGS = new Set(AGENT_CATEGORIES.map((entry) => entry.slug));

export function categoryFromSearch(search) {
  const slug = new URLSearchParams((search || '').replace(/^\?/, '')).get('category') || '';
  return AGENT_CATEGORY_SLUGS.has(slug) ? slug : 'all';
}

export function searchWithCategory(search, slug) {
  const params = new URLSearchParams((search || '').replace(/^\?/, ''));
  if (!slug || slug === 'all') params.delete('category');
  else params.set('category', slug);
  const next = params.toString();
  return next ? '?' + next : '';
}

export function readAgentForm(form) {
  const data = new FormData(form);
  const quickStarts = data.get('quick_starts');
  return {
    name: (data.get('name') || '').trim(),
    summary: (data.get('summary') || '').trim(),
    instructions: data.get('instructions') || '',
    category: AGENT_CATEGORY_SLUGS.has(data.get('category')) ? data.get('category') : null,
    ...(typeof quickStarts === 'string' ? {quick_starts: quickStarts.split(/\r?\n/).map(line => line.trim()).filter(Boolean)} : {}),
  };
}

export function categoryLabel(slug) {
  const found = AGENT_CATEGORIES.find((entry) => entry.slug === slug);
  return found ? found.label : '';
}

export function matchesCategory(item, slug) {
  return !slug || slug === 'all' || (item && item.category === slug);
}

export function matchesCreator(item, creatorId) {
  return !creatorId || (item && item.created_by === creatorId);
}

export function creatorChoices(items, names) {
  const seen = new Map();
  for (const item of items || []) {
    const id = item && item.created_by;
    if (id && !seen.has(id)) seen.set(id, (names && names.get(id)) || '用户 ' + String(id).slice(0, 8));
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([id, label]) => ({id, label}));
}

export function fillCreatorOptions(select, items, names, doc) {
  if (!select) return;
  const chosen = select.value;
  const producer = doc || select.ownerDocument;
  const choices = creatorChoices(items, names);
  select.replaceChildren();
  const all = producer.createElement('option');
  all.value = '';
  all.textContent = '全部';
  select.append(all);
  for (const choice of choices) {
    const option = producer.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = choices.some((choice) => choice.id === chosen) ? chosen : '';
}

export function fillCategoryOptions(select, doc) {
  if (!select || !select.options || select.options.length > 1) return;
  for (const entry of AGENT_CATEGORIES) {
    const option = (doc || select.ownerDocument).createElement('option');
    option.value = entry.slug;
    option.textContent = entry.label;
    select.append(option);
  }
}

// The template endpoint reports a handful of known refusals; keep those in the
// page's language and leave anything else in the server's own words.
export function teamTemplateFailure(status, body) {
  const message = body && body.error && body.error.message ? String(body.error.message) : '';
  if (/Only workspace owners and admins/i.test(message)) return '只有工作区所有者或管理员可以创建 AI 团队。';
  if (/Template not found/i.test(message)) return '没有找到这个团队模板。';
  if (/Idempotency/i.test(message)) return '这次请求的幂等键无效，请重试。';
  if (/Conversation (member limit|capacity) reached/i.test(message)) return '群会话或成员配额已满，先清理旧群会话再试。';
  return message || '无法用这个模板建团队。';
}

export function templateAgentText(template) {
  const names = (template && template.agents ? template.agents : []).map((agent) => agent.name).filter(Boolean);
  return names.length ? '含 ' + names.length + ' 个智能体：' + names.join('、') : '';
}

function teamTemplateKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
  const chatPanel = document.getElementById('chat-panel');
  const runtimePanel = document.getElementById('runtime-panel');
  let currentUser = null;
  let actor = null;
  let workspaces = [];
  let currentAgent = null;
  let personalAgentId = '';
  let personalLook = null;
  let agentSelection = 0;
  let sessionLoad = 0;
  let workspaceLoad = 0;
  let loadedWorkspace = '';
  let directoryLoaded = false;
  fillCategoryOptions(createForm.elements.category, document);
  fillCategoryOptions(editForm.elements.category, document);
  const categoryButtons = [...document.querySelectorAll('.filter-row .pill[data-category]')];
  const creatorFilter = document.getElementById('creator-filter');
  let selectedCategory = categoryFromSearch(globalThis.location && globalThis.location.search);
  let selectedCreator = '';
  let memberNames = new Map();
  let teamTemplates = [];
  let teamTemplatesLoaded = false;

  function renderCategoryFilter() {
    for (const button of categoryButtons) {
      button.setAttribute('aria-pressed', button.dataset.category === selectedCategory ? 'true' : 'false');
    }
  }

  function selectCategory(slug, push) {
    selectedCategory = AGENT_CATEGORY_SLUGS.has(slug) ? slug : 'all';
    renderCategoryFilter();
    if (directoryLoaded) renderDirectory();
    if (!globalThis.location || !globalThis.history) return;
    const next = searchWithCategory(globalThis.location.search, selectedCategory);
    const url = globalThis.location.pathname + next + globalThis.location.hash;
    if (push && globalThis.history.pushState) globalThis.history.pushState(null, '', url);
    else if (globalThis.history.replaceState) globalThis.history.replaceState(null, '', url);
  }

  renderCategoryFilter();
  for (const button of categoryButtons) {
    button.addEventListener('click', () => selectCategory(button.dataset.category, true));
  }
  if (globalThis.addEventListener) {
    globalThis.addEventListener('popstate', () => {
      selectedCategory = categoryFromSearch(globalThis.location.search);
      renderCategoryFilter();
      if (directoryLoaded) renderDirectory();
    });
  }

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

  function renderTeamTemplates() {
    const list = document.getElementById('team-template-list');
    const empty = document.getElementById('teams-empty');
    if (!list) return;
    list.replaceChildren();
    for (const template of teamTemplates) {
      const card = document.createElement('li');
      card.className = 'team-template-card';
      card.dataset.slug = template.slug;
      const name = document.createElement('h3');
      name.textContent = template.name || template.slug;
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = template.summary || '';
      const members = document.createElement('p');
      members.className = 'note';
      members.textContent = templateAgentText(template);
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'primary';
      apply.textContent = '用这个模板建团队';
      apply.dataset.slug = template.slug;
      if (!canManage(actor)) {
        apply.disabled = true;
        apply.title = '只有工作区所有者或管理员可以创建 AI 团队';
      }
      apply.addEventListener('click', () => applyTeamTemplate(template, apply));
      card.append(name, summary, members, apply);
      list.append(card);
    }
    if (empty) empty.hidden = teamTemplates.length > 0;
  }

  async function loadTeamTemplates() {
    if (teamTemplatesLoaded) return;
    const listed = await request('GET', '/v1/team-templates');
    if (listed.status !== 200) {
      const empty = document.getElementById('teams-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = '模板列表没有加载出来：' + messageFor(listed.body.error, '服务端没有返回模板。');
      }
      return;
    }
    teamTemplates = listed.body.items || [];
    teamTemplatesLoaded = true;
    renderTeamTemplates();
  }

  async function applyTeamTemplate(template, button) {
    if (!canManage(actor) || button.disabled) return;
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区，再用模板建团队。');
      return;
    }
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = '正在建团队…';
    try {
      const result = await request('POST', `/v1/workspaces/${id}/team-templates/${template.slug}`, {},
        {'Idempotency-Key': teamTemplateKey()});
      if ((result.status !== 200 && result.status !== 201) || !result.body.conversation) {
        show('error', teamTemplateFailure(result.status, result.body));
        return;
      }
      const href = '/chat#workspace=' + encodeURIComponent(id) + '&social=' + encodeURIComponent(result.body.conversation.id);
      show('ok', '团队已建好，正在打开群会话。');
      if (globalThis.location && typeof globalThis.location.assign === 'function') globalThis.location.assign(href);
      else if (globalThis.location) globalThis.location.href = href;
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function syncTeamRunLink() {
    const link = document.getElementById('open-team-runs');
    if (!link) return;
    const workspace = workspaceId();
    link.href = /^[0-9a-f]{32}$/.test(workspace) ? '/team-runs#workspace=' + workspace : '/team-runs';
  }

  function agentBase() {
    return `/v1/workspaces/${workspaceId()}/agents/${currentAgent && currentAgent.id}`;
  }

  async function load() {
    const seq = ++sessionLoad;
    workspaceLoad += 1;
    agentSelection += 1;
    const unavailable = {status: 0, body: {}};
    const session = await request('GET', '/v1/auth/session').catch(() => unavailable);
    if (seq !== sessionLoad) return;
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
    personalAgentId = '';
    personalLook = null;
    directoryLoaded = false;
    loadedWorkspace = '';
    directoryAgents = [];
    editForm.hidden = true;
    chatPanel.hidden = true;
    document.getElementById('agent-list').replaceChildren();
    void request('GET', '/v1/personal-agent').catch(() => unavailable).then(personal => {
      if (seq !== sessionLoad) return;
      const found = personal.status === 200 && personal.body.personal_agent;
      personalAgentId = found?.agent?.id || '';
      personalLook = found ? found.look || null : null;
      if (directoryLoaded && personalAgentId) renderDirectory();
    });
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录为 ' + currentUser.username;
    const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => unavailable);
    if (seq !== sessionLoad) return;
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
    syncTeamRunLink();
    if (!workspaces.length) {
      directoryAgents = [];
      fillCreatorOptions(creatorFilter, [], memberNames, document);
      selectedCreator = '';
      document.getElementById('role-note').textContent = '还没有可访问的工作区。';
      document.getElementById('agent-list').replaceChildren();
      const empty = document.getElementById('agents-empty');
      empty.hidden = false;
      empty.textContent = '这个工作区还没有智能体。';
      const count = document.getElementById('agents-count');
      if (count) count.textContent = '显示 0 个智能体';
      createForm.hidden = true;
      editForm.hidden = true;
      chatPanel.hidden = true;
      if (runtimePanel) runtimePanel.hidden = true;
      show(listed.status === 200 ? '' : 'error', listed.status === 200 ? '' : '无法加载工作区。请刷新后重试。');
      return;
    }
    await loadWorkspace();
  }

  let directoryAgents = [];

  function matchesDirectoryQuery(item, query) {
    if (!query) return true;
    const hay = (item.name + ' ' + (item.summary || '')).toLowerCase();
    return hay.includes(query);
  }

  function renderDirectory() {
    const id = workspaceId();
    const list = document.getElementById('agent-list');
    const empty = document.getElementById('agents-empty');
    const count = document.getElementById('agents-count');
    const query = ((document.getElementById('agent-search') || {}).value || '').trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const item of directoryAgents) {
      if (!matchesDirectoryQuery(item, query) || !matchesCategory(item, selectedCategory)
          || !matchesCreator(item, selectedCreator)) continue;
      shown += 1;
      const li = document.createElement('li');
      li.className = 'agent-card';
      const lookAvatar = item.id === personalAgentId ? createLookAvatar(personalLook, document) : null;
      const avatar = lookAvatar || document.createElement('span');
      if (!lookAvatar) {
        avatar.className = 'avatar';
        avatar.textContent = agentMonogram(item.name);
        avatar.dataset.tone = agentTone(item.name);
      }
      const copy = document.createElement('div');
      copy.className = 'copy';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.id = item.id;
      button.textContent = item.name;
      copy.append(button);
      const note = document.createElement('p');
      note.className = 'summary';
      note.textContent = item.summary || '暂无简介';
      copy.append(note);
      if (item.category && categoryLabel(item.category)) {
        const tag = document.createElement('span');
        tag.className = 'category-tag';
        tag.textContent = categoryLabel(item.category);
        copy.append(tag);
      }
      const chat = document.createElement('a');
      chat.className = 'chat-cta';
      chat.href = '/chat#workspace=' + encodeURIComponent(id) + '&agent=' + encodeURIComponent(item.id);
      chat.textContent = '聊天';
      li.append(avatar, copy, chat);
      list.append(li);
    }
    if (empty) {
      empty.hidden = shown > 0;
      empty.textContent = !directoryAgents.length
        ? '这个工作区还没有智能体。'
        : query
        ? '没有匹配的智能体。试试其他关键词。'
        : selectedCreator
          ? '没有符合筛选的智能体'
          : selectedCategory !== 'all' && directoryAgents.length
            ? '「' + categoryLabel(selectedCategory) + '」类目下还没有智能体。选「全部」查看其余智能体。'
            : '这个工作区还没有智能体。';
    }
    if (count) count.textContent = '显示 ' + shown + ' 个智能体';
  }

  const apiKeyForm = document.getElementById('api-key-form');
  if (apiKeyForm) apiKeyForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentAgent) return;
    const agent = currentAgent, wid = workspaceId();
    const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys`, {
      name: document.getElementById('api-key-name').value,
      rate_per_minute: Number(document.getElementById('api-key-rate').value) || 10,
    });
    if (result.status !== 201) { show('error', messageFor(result.body.error, '无法生成密钥。')); return; }
    const out = document.getElementById('api-key-token');
    out.hidden = false;
    out.textContent = `密钥只显示一次：${result.body.token}`;
    document.getElementById('api-key-name').value = '';
    loadApiKeys(agent, true);
  });

  async function loadWorkspace() {
    const id = workspaceId();
    if (!id) return;
    const seq = ++workspaceLoad;
    const user = currentUser?.id;
    currentAgent = null;
    agentSelection += 1;
    chatPanel.hidden = true;
    editForm.hidden = true;
    if (runtimePanel) runtimePanel.hidden = true;
    if (id !== loadedWorkspace) {
      directoryLoaded = false;
      directoryAgents = [];
      loadedWorkspace = '';
      createForm.hidden = true;
      document.getElementById('agent-list').replaceChildren();
      document.getElementById('agents-empty').hidden = true;
      document.getElementById('role-note').textContent = '';
      show('loading', '正在加载智能体…');
    }
    const unavailable = {status: 0, body: {}};
    const base = `/v1/workspaces/${id}`;
    const [detail, members, listed] = await Promise.all([
      request('GET', base).catch(() => unavailable),
      request('GET', base + '/members').catch(() => unavailable),
      request('GET', base + '/agents?limit=100').catch(() => unavailable),
    ]);
    if (seq !== workspaceLoad || id !== workspaceId() || user !== currentUser?.id) return;
    if (detail.status !== 200) {
      show('error', messageFor(detail.body.error, '无法打开工作区。'));
      return;
    }
    memberNames = new Map(members.status === 200
      ? (members.body.items || []).map(row => [row.user_id, row.username])
      : []);
    const self = members.status === 200
      ? (members.body.items || []).find(row => row.user_id === currentUser.id)
      : null;
    actor = self ? self.role : (detail.body.workspace && detail.body.workspace.owner_id === currentUser.id ? 'owner' : 'member');
    document.getElementById('role-note').textContent = actor === 'owner'
      ? '你是这个工作区的所有者，可以创建和归档智能体，并与自己的智能体对话。'
      : actor === 'admin'
        ? '你是管理员，可以创建和归档智能体，并与自己的智能体对话。'
        : '你是成员，可以查看目录并与自己的智能体对话，但不能改目录。';
    createForm.hidden = !canManage(actor);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return;
    }
    directoryAgents = listed.body.items || [];
    loadedWorkspace = id;
    directoryLoaded = true;
    fillCreatorOptions(creatorFilter, directoryAgents, memberNames, document);
    selectedCreator = creatorFilter ? creatorFilter.value : '';
    renderDirectory();
    show('', '');
  }

  function fillEdit(agent) {
    currentAgent = agent;
    editForm.hidden = false;
    editForm.elements.id.value = agent.id;
    editForm.elements.revision.value = String(agent.revision);
    editForm.elements.name.value = agent.name;
    editForm.elements.summary.value = agent.summary || '';
    editForm.elements.instructions.value = agent.instructions || '';
    if (editForm.elements.category) {
      editForm.elements.category.value = AGENT_CATEGORY_SLUGS.has(agent.category) ? agent.category : '';
    }
    const starts = editForm.elements.quick_starts;
    if (starts) starts.value = (agent.quick_starts || []).join('\n');
    const writable = canManage(actor);
    for (const field of ['name', 'summary', 'instructions', 'category', 'quick_starts']) {
      if (editForm.elements[field]) editForm.elements[field].disabled = !writable;
    }
    document.getElementById('archive-button').hidden = !writable;
    editForm.querySelector('button[type="submit"]').hidden = !writable;
    document.getElementById('chat-title').textContent = '与 ' + agent.name + ' 的对话';
    chatPanel.hidden = false;
    const drawer = document.getElementById('manage-drawer');
    if (drawer) drawer.hidden = false;
    const openChat = document.getElementById('open-in-chat');
    if (openChat) {
      openChat.href = '/chat#workspace=' + encodeURIComponent(workspaceId()) + '&agent=' + encodeURIComponent(agent.id);
    }
    const homepage = document.getElementById('homepage-panel');
    const manageHome = document.getElementById('manage-public-homepage');
    if (homepage) homepage.hidden = !writable;
    if (manageHome) manageHome.href = '/discover?' + new URLSearchParams({
      tab:'agents', workspace:workspaceId(), agent:agent.id,
    }) + '#catalog-manage';
    if (runtimePanel) loadRuntime();
    loadApiKeys(agent, writable);
  }

  async function loadApiKeys(agent, writable) {
    const panel = document.getElementById('api-key-panel');
    if (!panel) return;
    panel.hidden = !writable || Boolean(agent.archived);
    document.getElementById('api-key-token').hidden = true;
    if (panel.hidden) return;
    const wid = workspaceId();
    let listed;
    try {
      listed = await request('GET', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys`);
    } catch (error) {
      return;  // optional panel; never break the editor
    }
    if (workspaceId() !== wid || !currentAgent || currentAgent.id !== agent.id) return;
    const list = document.getElementById('api-key-list');
    list.replaceChildren(...(listed.status === 200 ? listed.body.items : []).map(key => {
      const li = document.createElement('li');
      const meta = document.createElement('span');
      meta.textContent = `${key.name} · ${key.rate_per_minute} 次/分钟 · ${key.revoked ? '已撤销' : '有效'}`
        + (key.last_used ? ' · 用过' : ' · 未使用');
      li.append(meta);
      if (!key.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys/${key.id}/revoke`, {});
          if (result.status !== 200) { show('error', messageFor(result.body.error, '无法撤销密钥。')); return; }
          show('ok', '已撤销密钥。');
          loadApiKeys(agent, writable);
        });
        li.append(revoke);
      }
      return li;
    }));
  }

  async function loadRuntime() {
    if (!currentAgent || !runtimePanel) return;
    const selected = agentSelection;
    const result = await request('GET', `${agentBase()}/runtime`).catch(() => ({status: 0, body: {}}));
    if (selected !== agentSelection) return;
    if (result.status !== 200) {
      runtimePanel.hidden = true;
      return;
    }
    runtimePanel.hidden = false;
    const bindable = canManage(actor);
    document.getElementById('bind-runtime').hidden = !bindable;
    document.getElementById('unbind-runtime').hidden = !bindable;
    document.getElementById('runtime-instance').disabled = !bindable;
    const listed = bindable ? await request('GET', `/v1/workspaces/${workspaceId()}/instances?limit=100`)
      .catch(() => ({status: 0, body: {}})) : {status: 200, body: {items: []}};
    if (selected !== agentSelection) return;
    const items = listed.status === 200 ? (listed.body.items || []) : [];
    const select = document.getElementById('runtime-instance');
    const current = result.body.runtime;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '选择一个容器实例';
    select.append(empty);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = (item.id || '').slice(0, 8) + (item.desired ? ' · ' + item.desired : '');
      select.append(option);
    }
    if (current && current.instance_id) select.value = current.instance_id;
    document.getElementById('runtime-status').textContent = current
      ? ('已绑定实例 ' + current.instance_id.slice(0, 8) + '（' + (current.status || '未知') + '）')
      : '尚未绑定容器。成员对话仍可回退到自己的已连接机器。';
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

  workspaceSelect.addEventListener('change', () => {
    syncTeamRunLink();
    return loadWorkspace();
  });

  document.getElementById('agent-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const workspace = workspaceId();
    const user = currentUser?.id;
    const selected = ++agentSelection;
    const result = await request('GET', `/v1/workspaces/${workspace}/agents/${button.dataset.id}`);
    if (selected !== agentSelection || workspace !== workspaceId() || user !== currentUser?.id) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开这个智能体。'));
      return;
    }
    fillEdit(result.body.agent);
  });

  const bindButton = document.getElementById('bind-runtime');
  if (bindButton) bindButton.addEventListener('click', async () => {
    const instanceId = document.getElementById('runtime-instance').value;
    if (!instanceId || !currentAgent) {
      show('error', '请选择一个实例。');
      return;
    }
    const current = await request('GET', `${agentBase()}/runtime`);
    const body = {instance_id: instanceId};
    if (current.status === 200 && current.body.runtime) body.revision = current.body.runtime.revision;
    const result = await request('POST', `${agentBase()}/runtime`, body);
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法绑定。'));
      return;
    }
    show('ok', '已绑定到工作区容器。');
    await loadRuntime();
  });
  const unbindButton = document.getElementById('unbind-runtime');
  if (unbindButton) unbindButton.addEventListener('click', async () => {
    const current = await request('GET', `${agentBase()}/runtime`);
    if (current.status !== 200 || !current.body.runtime) return;
    const result = await request('POST', `${agentBase()}/runtime/unbind`, {revision: current.body.runtime.revision});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法解除绑定。'));
      return;
    }
    show('ok', '已解除绑定。');
    await loadRuntime();
  });

  function invalidQuickStarts(starts) {
    if (!starts || (starts.length <= 5 && starts.every(line => line.length <= 80))) return false;
    show('error', '快捷开场最多 5 条，每条不超过 80 字。');
    return true;
  }

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    const form = event.currentTarget;
    const values = readAgentForm(form);
    if (invalidQuickStarts(values.quick_starts)) return;
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
    form.reset();
    show('ok', '已保存到目录。对话仍由已连接的运行时执行。');
    await loadWorkspace();
    if (result.body.agent && id === workspaceId()) fillEdit(result.body.agent);
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage(actor)) return;
    const id = workspaceId();
    const values = readAgentForm(event.currentTarget);
    if (invalidQuickStarts(values.quick_starts)) return;
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
    show('ok', '已更新。之后的对话会使用新的说明。');
    await loadWorkspace();
    if (id === workspaceId()) fillEdit(result.body.agent);
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
    show('ok', '已归档。如已公开，可在发现页的「发布管理」中取消发布。');
    const homepagePanel = document.getElementById('homepage-panel');
    if (homepagePanel) homepagePanel.hidden = true;
    await loadWorkspace();
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    editForm.hidden = true;
    chatPanel.hidden = true;
    const drawer = document.getElementById('manage-drawer');
    if (drawer && createForm.hidden) drawer.hidden = true;
    const homepagePanel = document.getElementById('homepage-panel');
    if (homepagePanel) homepagePanel.hidden = true;
    if (runtimePanel) runtimePanel.hidden = true;
    currentAgent = null;
    agentSelection += 1;
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

  const openCreate = document.getElementById('open-create');
  if (openCreate) openCreate.addEventListener('click', () => {
    const drawer = document.getElementById('manage-drawer');
    if (drawer) drawer.hidden = false;
    if (canManage(actor)) createForm.hidden = false;
  });
  const search = document.getElementById('agent-search');
  if (creatorFilter) creatorFilter.addEventListener('change', () => {
    selectedCreator = creatorFilter.value || '';
    renderDirectory();
  });
  if (search) {
    search.addEventListener('input', () => renderDirectory());
    search.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      search.value = '';
      renderDirectory();
      if (typeof search.focus === 'function') search.focus();
    });
  }
  const tabAgents = document.getElementById('tab-agents');
  const tabTeams = document.getElementById('tab-teams');
  if (tabAgents && tabTeams) {
    tabAgents.addEventListener('click', () => {
      tabAgents.setAttribute('aria-selected', 'true');
      tabTeams.setAttribute('aria-selected', 'false');
      document.getElementById('list-panel').hidden = false;
      document.getElementById('teams-panel').hidden = true;
    });
    tabTeams.addEventListener('click', async () => {
      tabAgents.setAttribute('aria-selected', 'false');
      tabTeams.setAttribute('aria-selected', 'true');
      document.getElementById('list-panel').hidden = true;
      document.getElementById('teams-panel').hidden = false;
      await loadTeamTemplates();
    });
  }

  return load();
}

if (globalThis.document && globalThis.document.getElementById('create-form')) {
  mount(globalThis.document);
}
