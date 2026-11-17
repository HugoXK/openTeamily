import { csrfCookie, canManage, idempotencyKey, statusLabel } from '../agents/app.mjs';
import { conversationLabel, memberChoices, validMessage } from '../messenger/app.mjs';

export const SEARCH_TABS = [
  ['all', '全部'],
  ['artifacts', 'Artifacts'],
  ['contacts', '联系人'],
  ['groups', '群组'],
  ['agents', '智能体'],
  ['messages', '消息'],
  ['files', '文件'],
  ['documents', '云文档'],
  ['media', '媒体'],
  ['links', '链接'],
];

export function mergeSessions(agentRows, socialRows, currentUserId) {
  const sessions = [];
  for (const row of agentRows || []) {
    sessions.push({
      source: 'agent',
      id: row.id,
      agent_id: row.agent_id || (row.agent && row.agent.id),
      agent: row.agent,
      kind: 'agent',
      title: (row.agent && row.agent.name) || row.title || '对话',
      preview: row.title || '',
      updated: row.updated || 0,
    });
  }
  for (const row of socialRows || []) {
    sessions.push({
      source: 'social',
      id: row.id,
      kind: row.kind,
      members: row.members,
      title: conversationLabel(row, currentUserId),
      preview: row.kind === 'group'
        ? '群聊 · ' + ((row.members || []).length) + ' 人'
        : '单聊 · ' + ((row.members || []).length) + ' 人',
      updated: row.updated || 0,
    });
  }
  sessions.sort((left, right) => (right.updated || 0) - (left.updated || 0));
  return sessions;
}

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
    social: params.get('social') || '',
  };
}

function writeHash(values) {
  const params = new URLSearchParams();
  if (values.workspace) params.set('workspace', values.workspace);
  if (values.agent) params.set('agent', values.agent);
  if (values.social) params.set('social', values.social);
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

function matchesQuery(item, query) {
  if (!query) return true;
  const hay = ((item.title || '') + ' ' + (item.preview || '') + ' ' + (item.snippet || '')).toLowerCase();
  return hay.includes(query.toLowerCase());
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let workspaces = [];
  let agents = [];
  let members = [];
  let artifacts = [];
  let socialConversations = [];
  let sessions = [];
  let currentAgent = null;
  let currentConversation = null;
  let currentSource = 'agent';
  let pollTimer = 0;
  let searchTab = 'all';
  let composeMode = 'group';
  let searchSeq = 0;

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

  function socialBase() {
    return `/v1/workspaces/${workspaceId()}/social/conversations`;
  }

  function stopPolling() {
    if (pollTimer) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function isSearchOpen() {
    return !document.getElementById('search-panel').hidden;
  }

  function renderSessions() {
    const list = document.getElementById('conversation-list');
    list.replaceChildren();
    document.getElementById('conversation-heading').textContent = '对话 · ' + sessions.length;
    document.getElementById('conversations-empty').hidden = sessions.length > 0;
    for (const session of sessions) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      button.dataset.conversation = session.id;
      button.dataset.source = session.source;
      if (session.agent_id) button.dataset.agent = session.agent_id;
      if (currentConversation && currentConversation.id === session.id && currentSource === session.source) {
        button.setAttribute('aria-current', 'true');
      }
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initial(session.title);
      const copy = document.createElement('span');
      copy.className = 'copy';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = session.title;
      const preview = document.createElement('span');
      preview.className = 'preview';
      preview.textContent = session.preview || '';
      copy.append(title, preview);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(session.updated);
      button.append(avatar, copy, time);
      li.append(button);
      list.append(li);
    }
  }

  function renderAgentMessages(items) {
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

  function renderSocialMessages(items) {
    const list = document.getElementById('message-list');
    list.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    const people = currentConversation && currentConversation.members || members;
    for (const item of items || []) {
      const li = document.createElement('li');
      const mine = item.user_id === (currentUser && currentUser.id);
      li.className = mine ? 'mine' : 'other';
      const role = document.createElement('p');
      role.className = 'role';
      const member = people.find(entry => entry.user_id === item.user_id);
      role.textContent = mine ? '我' : ((member && member.username) || '成员');
      const body = document.createElement('p');
      body.className = 'body';
      body.textContent = item.body || '';
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(role, body, time);
      list.append(li);
    }
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    return false;
  }

  function setDirectoryLink(session) {
    const link = document.getElementById('open-agent-dir');
    if (session && session.source === 'social') {
      link.href = '/members';
      link.textContent = '成员';
    } else {
      link.href = '/agents';
      link.textContent = '资料';
    }
  }

  async function loadSessions() {
    const id = workspaceId();
    sessions = [];
    agents = [];
    members = [];
    artifacts = [];
    socialConversations = [];
    if (!id) return;
    const [listed, social, people, works] = await Promise.all([
      request('GET', `/v1/workspaces/${id}/agents?limit=100`),
      request('GET', `/v1/workspaces/${id}/social/conversations?limit=100`),
      request('GET', `/v1/workspaces/${id}/members`),
      request('GET', `/v1/workspaces/${id}/artifacts?limit=100`),
    ]);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return;
    }
    agents = listed.body.items || [];
    if (people.status === 200) members = people.body.items || [];
    if (works.status === 200) artifacts = works.body.items || [];
    if (social.status === 200) socialConversations = social.body.items || [];
    const results = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/conversations?limit=100`)
        .then(result => ({agent, result}))));
    const agentRows = [];
    for (const {agent, result} of results) {
      if (result.status !== 200) continue;
      for (const row of result.body.items || []) {
        agentRows.push({...row, agent});
      }
    }
    sessions = mergeSessions(agentRows, socialConversations, currentUser && currentUser.id);
    renderSessions();
  }

  async function openAgentConversation(agentId, conversationId) {
    const agent = agents.find(item => item.id === agentId);
    if (!agent) {
      show('error', '找不到这个智能体。');
      return;
    }
    currentAgent = agent;
    currentSource = 'agent';
    document.getElementById('chat-title').textContent = agent.name;
    setDirectoryLink({source: 'agent'});
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/agents/${agentId}/conversations/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return;
    }
    currentConversation = result.body.conversation;
    writeHash({workspace: workspaceId(), agent: agentId, conversation: conversationId});
    const pending = renderAgentMessages(result.body.items);
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
  }

  async function openSocialConversation(conversationId) {
    currentAgent = null;
    currentSource = 'social';
    stopPolling();
    const result = await request('GET', `${socialBase()}/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开会话。'));
      return;
    }
    currentConversation = result.body.conversation;
    document.getElementById('chat-title').textContent = conversationLabel(
      currentConversation, currentUser && currentUser.id);
    setDirectoryLink({source: 'social'});
    writeHash({workspace: workspaceId(), social: conversationId});
    renderSocialMessages(result.body.items);
    renderSessions();
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      if (currentConversation && currentAgent && currentSource === 'agent') {
        openAgentConversation(currentAgent.id, currentConversation.id);
      }
    }, 2000);
  }

  function closeComposeMenu() {
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function closeComposeDialog() {
    document.getElementById('compose-dialog').hidden = true;
    document.getElementById('compose-social-form').reset();
  }

  function renderMemberChoices(single) {
    const holder = document.getElementById('member-choices');
    holder.replaceChildren();
    for (const member of memberChoices(members, currentUser && currentUser.id)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      box.name = 'member';
      box.value = member.user_id;
      label.append(box, document.createTextNode(member.username));
      holder.append(label);
    }
  }

  function openComposeDialog(mode) {
    closeComposeMenu();
    composeMode = mode;
    const dialog = document.getElementById('compose-dialog');
    dialog.hidden = false;
    const titleLabel = document.getElementById('compose-title-label');
    const titleInput = document.getElementById('compose-title');
    if (mode === 'group') {
      document.getElementById('compose-dialog-title').textContent = '新建群组';
      document.getElementById('compose-members-legend').textContent = '成员';
      titleLabel.hidden = false;
      titleInput.required = false;
    } else {
      document.getElementById('compose-dialog-title').textContent = '添加联系人';
      document.getElementById('compose-members-legend').textContent = '选择一位成员，开始单聊';
      titleLabel.hidden = true;
      titleInput.value = '';
    }
    renderMemberChoices(mode === 'contact');
  }

  function setSearchTab(name) {
    searchTab = name;
    for (const tab of document.querySelectorAll('#search-panel [data-search-tab]')) {
      tab.setAttribute('aria-selected', tab.dataset.searchTab === name ? 'true' : 'false');
    }
  }

  function openSearchPanel(tab) {
    document.getElementById('search-panel').hidden = false;
    document.getElementById('search-close').hidden = false;
    document.getElementById('conversation-group').hidden = true;
    document.getElementById('pinned-group').hidden = true;
    document.getElementById('compose-dialog').hidden = true;
    closeComposeMenu();
    if (tab) setSearchTab(tab);
    renderSearch();
  }

  function closeSearchPanel() {
    document.getElementById('search-panel').hidden = true;
    document.getElementById('search-close').hidden = true;
    document.getElementById('conversation-group').hidden = false;
    document.getElementById('session-search').value = '';
    setSearchTab('all');
  }

  function addSearchSection(root, title, items, onPick) {
    if (!items.length) return;
    const section = document.createElement('section');
    section.className = 'search-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement(item.href ? 'a' : 'button');
      if (item.href) button.href = item.href;
      else button.type = 'button';
      const name = document.createElement('span');
      name.className = 'title';
      name.textContent = item.title;
      button.append(name);
      if (item.preview) {
        const preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = item.preview;
        button.append(preview);
      }
      if (!item.href) button.addEventListener('click', () => onPick(item));
      li.append(button);
      list.append(li);
    }
    section.append(heading, list);
    root.append(section);
  }

  function artifactKind(item) {
    return item.kind || item.public_kind || '';
  }

  function artifactItems(kind) {
    return artifacts.filter(item => !kind || artifactKind(item) === kind).map(item => ({
      type: 'artifact',
      id: item.id,
      title: item.title || '未命名',
      preview: artifactKind(item) || '作品',
      href: '/space',
    }));
  }

  function contactItems() {
    return memberChoices(members, currentUser && currentUser.id).map(member => ({
      type: 'contact',
      id: member.user_id,
      title: member.username,
      preview: '工作区成员',
    }));
  }

  function groupItems() {
    return socialConversations.filter(row => row.kind === 'group').map(row => ({
      type: 'social',
      id: row.id,
      title: conversationLabel(row, currentUser && currentUser.id),
      preview: '群聊',
    }));
  }

  function agentItems() {
    return agents.map(agent => ({
      type: 'agent',
      id: agent.id,
      title: agent.name,
      preview: agent.summary || '智能体',
    }));
  }

  async function renderSearch() {
    const query = (document.getElementById('session-search').value || '').trim();
    const results = document.getElementById('search-results');
    const empty = document.getElementById('search-empty');
    const note = document.getElementById('search-source-note');
    results.replaceChildren();
    empty.hidden = true;
    note.hidden = Boolean(query);
    const seq = ++searchSeq;

    const unimplemented = {
      files: '文件搜索还没有独立接口。',
      links: '链接搜索还没有接口。',
    };
    if (unimplemented[searchTab]) {
      empty.hidden = false;
      empty.textContent = unimplemented[searchTab];
      return;
    }
    if (searchTab === 'messages' && !query) {
      empty.hidden = false;
      empty.textContent = '输入关键词，搜索你在这个工作区里自己的消息。';
      return;
    }

    let messageItems = [];
    if ((searchTab === 'messages' || searchTab === 'all') && query) {
      const result = await request(
        'GET',
        `/v1/workspaces/${workspaceId()}/search/messages?q=${encodeURIComponent(query)}&limit=20`,
      );
      if (seq !== searchSeq) return;
      if (result.status === 200) {
        messageItems = (result.body.items || []).map(item => ({
          type: item.kind === 'social' ? 'social' : 'agent-message',
          id: item.conversation_id,
          title: item.title || '消息',
          preview: item.snippet || '',
          conversationId: item.conversation_id,
          kind: item.kind,
        }));
      } else if (searchTab === 'messages') {
        empty.hidden = false;
        empty.textContent = messageFor(result.body.error, '无法搜索消息。');
        return;
      }
    }

    const filtered = (items) => items.filter(item => matchesQuery(item, query));
    const sections = [];
    if (searchTab === 'all' || searchTab === 'agents') {
      sections.push(['智能体', filtered(agentItems())]);
    }
    if (searchTab === 'all' || searchTab === 'contacts') {
      sections.push(['联系人', filtered(contactItems())]);
    }
    if (searchTab === 'all' || searchTab === 'groups') {
      sections.push(['群组', filtered(groupItems())]);
    }
    if (searchTab === 'all' || searchTab === 'artifacts') {
      sections.push(['Artifacts', filtered(artifactItems())]);
    }
    if (searchTab === 'documents') {
      sections.push(['云文档', filtered(artifactItems('document'))]);
    }
    if (searchTab === 'media') {
      sections.push(['媒体', filtered(artifactItems('media'))]);
    }
    if (searchTab === 'all' || searchTab === 'messages') {
      sections.push(['消息', messageItems]);
    }

    let total = 0;
    for (const [title, items] of sections) {
      total += items.length;
      addSearchSection(results, title, items, async (item) => {
        closeSearchPanel();
        if (item.type === 'agent') {
          const first = sessions.find(row => row.source === 'agent' && row.agent_id === item.id);
          if (first) await openAgentConversation(item.id, first.id);
          else {
            currentAgent = agents.find(entry => entry.id === item.id) || null;
            currentConversation = null;
            currentSource = 'agent';
            if (currentAgent) document.getElementById('chat-title').textContent = currentAgent.name;
            document.getElementById('chat-empty').hidden = false;
            document.getElementById('message-list').replaceChildren();
            writeHash({workspace: workspaceId(), agent: item.id});
          }
        } else if (item.type === 'social' || item.kind === 'social') {
          await openSocialConversation(item.conversationId || item.id);
        } else if (item.type === 'agent-message' || item.kind === 'agent') {
          const session = sessions.find(row => row.source === 'agent' && row.id === item.conversationId);
          if (session) await openAgentConversation(session.agent_id, session.id);
        } else if (item.type === 'contact') {
          openComposeDialog('contact');
          const box = document.querySelector(`#member-choices input[value="${item.id}"]`);
          if (box) box.checked = true;
        }
      });
    }
    if (!total) {
      empty.hidden = false;
      empty.textContent = query ? '当前工作区里没有匹配的结果。' : '当前工作区里还没有可列出的内容。';
    }
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
    await loadSessions();
    const start = hashParams();
    if (start.social) {
      await openSocialConversation(start.social);
    } else if (start.agent && start.conversation) {
      await openAgentConversation(start.agent, start.conversation);
    } else if (start.agent) {
      const first = sessions.find(row => row.source === 'agent' && row.agent_id === start.agent);
      if (first) await openAgentConversation(start.agent, first.id);
      else {
        currentAgent = agents.find(item => item.id === start.agent) || null;
        currentSource = 'agent';
        if (currentAgent) document.getElementById('chat-title').textContent = currentAgent.name;
        document.getElementById('chat-empty').hidden = false;
        writeHash({workspace: workspaceId(), agent: start.agent});
      }
    } else if (sessions.length) {
      const first = sessions[0];
      if (first.source === 'social') await openSocialConversation(first.id);
      else await openAgentConversation(first.agent_id, first.id);
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
    currentSource = 'agent';
    stopPolling();
    closeSearchPanel();
    closeComposeDialog();
    writeHash({workspace: workspaceId()});
    document.getElementById('chat-title').textContent = '聊天';
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    setDirectoryLink({source: 'agent'});
    await loadSessions();
  });

  document.getElementById('session-search').addEventListener('focus', () => openSearchPanel());
  document.getElementById('session-search').addEventListener('input', () => {
    if (!isSearchOpen()) openSearchPanel();
    else renderSearch();
  });
  document.getElementById('search-close').addEventListener('click', closeSearchPanel);
  document.getElementById('message-search').addEventListener('click', () => {
    openSearchPanel('messages');
    document.getElementById('session-search').focus();
  });
  document.getElementById('search-panel').addEventListener('click', event => {
    const tab = event.target.closest('[data-search-tab]');
    if (!tab) return;
    setSearchTab(tab.dataset.searchTab);
    renderSearch();
  });

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (!button) return;
    if (button.dataset.source === 'social') await openSocialConversation(button.dataset.conversation);
    else await openAgentConversation(button.dataset.agent, button.dataset.conversation);
  });

  document.getElementById('new-conversation').addEventListener('click', event => {
    event.stopPropagation();
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('compose-new-group').addEventListener('click', () => openComposeDialog('group'));
  document.getElementById('compose-add-contact').addEventListener('click', () => openComposeDialog('contact'));
  document.getElementById('compose-dialog-cancel').addEventListener('click', closeComposeDialog);

  document.getElementById('compose-social-form').addEventListener('submit', async event => {
    event.preventDefault();
    const memberIds = [...document.querySelectorAll('#member-choices input[name="member"]:checked')]
      .map(box => box.value);
    if (!memberIds.length) {
      show('error', '至少选择一位成员。');
      return;
    }
    const title = document.getElementById('compose-title').value.trim();
    if (composeMode === 'contact' && memberIds.length !== 1) {
      show('error', '请选择一位成员。');
      return;
    }
    if (composeMode === 'group' && !title) {
      show('error', '请填写群名称。');
      return;
    }
    const body = composeMode === 'contact'
      ? {kind: 'dm', member_ids: memberIds.slice(0, 1)}
      : {kind: 'group', member_ids: memberIds, title};
    const result = await request('POST', socialBase(), body, {'Idempotency-Key': idempotencyKey('social-')});
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建会话。'));
      return;
    }
    closeComposeDialog();
    await loadSessions();
    await openSocialConversation(result.body.conversation.id);
    show('ok', '会话已创建。');
  });

  document.getElementById('chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = document.getElementById('chat-body').value;
    if (!text.trim()) {
      show('error', '请填写消息。');
      return;
    }
    if (currentSource === 'social') {
      if (!validMessage(text)) {
        show('error', '请输入 1–4000 字符的消息。');
        return;
      }
      if (!currentConversation) {
        show('error', '请先打开或创建一个会话。');
        return;
      }
      const result = await request('POST', `${socialBase()}/${currentConversation.id}/messages`, {body: text}, {
        'Idempotency-Key': idempotencyKey('socialmsg-'),
      });
      if (result.status !== 201 && result.status !== 200) {
        show('error', messageFor(result.body.error, '发送失败。'));
        return;
      }
      document.getElementById('chat-body').value = '';
      await openSocialConversation(currentConversation.id);
      show('ok', '已发送。');
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
    await loadSessions();
    await openAgentConversation(currentAgent.id, currentConversation.id);
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

  document.addEventListener('click', event => {
    const menu = document.getElementById('compose-menu');
    if (menu.hidden) return;
    if (event.target.closest('.compose-menu')) return;
    closeComposeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeComposeMenu();
    if (isSearchOpen()) closeSearchPanel();
    closeComposeDialog();
  });

  globalThis.addEventListener('hashchange', () => load());
  return load();
}

if (globalThis.document && globalThis.document.getElementById('session-pane')) {
  mount(globalThis.document);
}

export { canManage, conversationLabel };
