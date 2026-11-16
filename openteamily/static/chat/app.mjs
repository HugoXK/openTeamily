import { csrfCookie, canManage, idempotencyKey, statusLabel } from '../agents/app.mjs';

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function hashParams() {
  const text = (location.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(text);
  return {
    workspace: params.get('workspace') || '',
    agent: params.get('agent') || '',
    conversation: params.get('conversation') || '',
  };
}

function writeHash(values) {
  const params = new URLSearchParams();
  if (values.workspace) params.set('workspace', values.workspace);
  if (values.agent) params.set('agent', values.agent);
  if (values.conversation) params.set('conversation', values.conversation);
  const next = params.toString();
  const hash = next ? '#' + next : '';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function initial(name) {
  const text = (name || '').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let workspaces = [];
  let agents = [];
  let sessions = [];
  let currentAgent = null;
  let currentConversation = null;
  let pollTimer = 0;

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

  function workspaceId() {
    return workspaceSelect.value;
  }

  function agentBase() {
    return `/v1/workspaces/${workspaceId()}/agents/${currentAgent && currentAgent.id}`;
  }

  function stopPolling() {
    if (pollTimer) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function matchesQuery(session, query) {
    if (!query) return true;
    const hay = ((session.agent && session.agent.name) || '') + ' ' + (session.title || '');
    return hay.toLowerCase().includes(query.toLowerCase());
  }

  function renderSessions() {
    const query = (document.getElementById('session-search').value || '').trim();
    const list = document.getElementById('conversation-list');
    list.replaceChildren();
    const visible = sessions.filter(session => matchesQuery(session, query));
    document.getElementById('conversation-heading').textContent = '对话 · ' + visible.length;
    document.getElementById('conversations-empty').hidden = visible.length > 0;
    for (const session of visible) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      button.dataset.conversation = session.id;
      button.dataset.agent = session.agent_id;
      if (currentConversation && currentConversation.id === session.id) {
        button.setAttribute('aria-current', 'true');
      }
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initial(session.agent && session.agent.name);
      const copy = document.createElement('span');
      copy.className = 'copy';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = (session.agent && session.agent.name) || session.title || '对话';
      const preview = document.createElement('span');
      preview.className = 'preview';
      preview.textContent = session.title || '';
      copy.append(title, preview);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(session.updated);
      button.append(avatar, copy, time);
      li.append(button);
      list.append(li);
    }
  }

  function renderMessages(items) {
    const list = document.getElementById('message-list');
    list.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    let pending = false;
    for (const item of items || []) {
      const li = document.createElement('li');
      li.className = item.role === 'user' ? 'user' : 'assistant';
      const role = document.createElement('p');
      role.className = 'role';
      role.textContent = item.role === 'user' ? '你' : '智能体';
      const body = document.createElement('p');
      const waiting = item.role === 'assistant' && (item.status === 'queued' || item.status === 'running');
      const failed = item.role === 'assistant' && (item.status === 'failed' || item.status === 'cancelled');
      body.className = waiting ? 'pending' : (failed ? 'failed' : '');
      body.textContent = item.role === 'user' ? (item.body || '') : statusLabel(item);
      li.append(role, body);
      if (item.role === 'assistant' && item.status === 'succeeded' && item.body) {
        const save = document.createElement('button');
        save.type = 'button';
        save.dataset.save = item.id;
        save.textContent = '保存到作品库';
        li.append(save);
      }
      list.append(li);
      if (waiting) pending = true;
    }
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    return pending;
  }

  async function loadAgentsAndSessions() {
    const id = workspaceId();
    sessions = [];
    agents = [];
    if (!id) return;
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return;
    }
    agents = listed.body.items || [];
    const results = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/conversations?limit=100`)
        .then(result => ({agent, result}))));
    for (const {agent, result} of results) {
      if (result.status !== 200) continue;
      for (const row of result.body.items || []) {
        sessions.push({...row, agent});
      }
    }
    sessions.sort((left, right) => (right.updated || 0) - (left.updated || 0));
    renderSessions();
  }

  async function openConversation(agentId, conversationId) {
    const agent = agents.find(item => item.id === agentId);
    if (!agent) {
      show('error', '找不到这个智能体。');
      return;
    }
    currentAgent = agent;
    document.getElementById('chat-title').textContent = agent.name;
    document.getElementById('open-agent-dir').href = '/agents';
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/agents/${agentId}/conversations/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return;
    }
    currentConversation = result.body.conversation;
    writeHash({workspace: workspaceId(), agent: agentId, conversation: conversationId});
    const pending = renderMessages(result.body.items);
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      if (currentConversation && currentAgent) {
        openConversation(currentAgent.id, currentConversation.id);
      }
    }, 2000);
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      document.getElementById('session-pane').hidden = true;
      document.body.classList.remove('chat-open');
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('session-pane').hidden = false;
    document.body.classList.add('chat-open');
    document.getElementById('whoami').textContent = currentUser.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const wanted = hashParams().workspace || workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (wanted && [...workspaceSelect.options].some(option => option.value === wanted)) {
      workspaceSelect.value = wanted;
    }
    if (!workspaces.length) {
      document.getElementById('conversations-empty').hidden = false;
      document.getElementById('chat-empty').hidden = false;
      show('', '');
      return;
    }
    await loadAgentsAndSessions();
    const start = hashParams();
    if (start.agent && start.conversation) {
      await openConversation(start.agent, start.conversation);
    } else if (start.agent) {
      const first = sessions.find(row => row.agent_id === start.agent);
      if (first) await openConversation(start.agent, first.id);
      else {
        currentAgent = agents.find(item => item.id === start.agent) || null;
        if (currentAgent) document.getElementById('chat-title').textContent = currentAgent.name;
        document.getElementById('chat-empty').hidden = false;
        writeHash({workspace: workspaceId(), agent: start.agent});
      }
    } else if (sessions.length) {
      await openConversation(sessions[0].agent_id, sessions[0].id);
    }
    show('', '');
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

  workspaceSelect.addEventListener('change', async () => {
    currentAgent = null;
    currentConversation = null;
    stopPolling();
    writeHash({workspace: workspaceId()});
    document.getElementById('chat-title').textContent = '聊天';
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    await loadAgentsAndSessions();
  });

  document.getElementById('session-search').addEventListener('input', renderSessions);

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (!button) return;
    await openConversation(button.dataset.agent, button.dataset.conversation);
  });

  document.getElementById('new-conversation').addEventListener('click', async () => {
    if (!currentAgent) {
      show('error', '请先选择一个智能体，或到目录里开始对话。');
      return;
    }
    const result = await request('POST', `${agentBase()}/conversations`, {title: '新对话'}, {
      'Idempotency-Key': idempotencyKey('chat-'),
    });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建对话。'));
      return;
    }
    currentConversation = result.body.conversation;
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    show('ok', '已开始新对话。');
    await loadAgentsAndSessions();
    await openConversation(currentAgent.id, currentConversation.id);
  });

  document.getElementById('chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = document.getElementById('chat-body').value;
    if (!text.trim()) {
      show('error', '请填写消息。');
      return;
    }
    if (!currentAgent) {
      show('error', '请先选择一个智能体。');
      return;
    }
    if (!currentConversation) {
      const created = await request('POST', `${agentBase()}/conversations`, {title: '新对话'}, {
        'Idempotency-Key': idempotencyKey('chat-'),
      });
      if (created.status !== 201 && created.status !== 200) {
        show('error', messageFor(created.body.error, '无法创建对话。'));
        return;
      }
      currentConversation = created.body.conversation;
    }
    const result = await request(
      'POST',
      `${agentBase()}/conversations/${currentConversation.id}/messages`,
      {body: text},
      {'Idempotency-Key': idempotencyKey('msg-')},
    );
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法发送。'));
      return;
    }
    document.getElementById('chat-body').value = '';
    show(result.body.reply && result.body.reply.error_code === 'no_agent' ? 'error' : 'ok',
         result.body.reply && result.body.reply.error_code === 'no_agent'
           ? '消息已保存，正在等待已连接的运行时。'
           : '已发送。');
    await loadAgentsAndSessions();
    await openConversation(currentAgent.id, currentConversation.id);
  });

  document.getElementById('message-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-save]');
    if (!button || !currentConversation || !currentAgent) return;
    const result = await request(
      'POST',
      `${agentBase()}/conversations/${currentConversation.id}/messages/${button.dataset.save}/artifact`,
      {},
    );
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存到作品库。'));
      return;
    }
    show('ok', '已保存到作品库。');
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

  globalThis.addEventListener('hashchange', () => load());
  return load();
}

if (globalThis.document && globalThis.document.getElementById('session-pane')) {
  mount(globalThis.document);
}

export { canManage };
