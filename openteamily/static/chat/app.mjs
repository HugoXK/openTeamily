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

export function sessionPreview(row, fallback) {
  const text = typeof row.preview === 'string' ? row.preview.trim() : '';
  return text || fallback || '';
}

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
      preview: sessionPreview(row, row.title || ''),
      updated: row.updated || 0,
    });
  }
  for (const row of socialRows || []) {
    sessions.push({
      source: 'social',
      id: row.id,
      unread_count: Number(row.unread_count) || 0,
      pinned: Boolean(row.pinned),
      kind: row.kind,
      members: row.members,
      title: conversationLabel(row, currentUserId),
      preview: sessionPreview(row, row.kind === 'group'
        ? '群聊 · ' + ((row.members || []).length) + ' 人'
        : '单聊 · ' + ((row.members || []).length) + ' 人'),
      updated: row.updated || 0,
    });
  }
  sessions.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updated || 0) - (left.updated || 0));
  return sessions;
}


export function shouldSendOnShortcut(event, sendShortcut = 'enter') {
  if (!event || event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const modifier = Boolean(event.ctrlKey || event.metaKey);
  if (sendShortcut === 'mod_enter') return modifier && !event.shiftKey && !event.altKey;
  return !modifier && !event.shiftKey && !event.altKey;
}

export function messageSearchQuery(query, conversationId = '', cursor = '') {
  const params = new URLSearchParams({q: query, limit: '20'});
  if (conversationId) params.set('conversation_id', conversationId);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function homepageStartIndex(search) {
  const source = search === undefined
    ? ((typeof location !== 'undefined' && location.search) || '')
    : search;
  const params = new URLSearchParams(String(source).startsWith('?') ? String(source).slice(1) : source);
  const raw = params.get('start');
  if (!/^(0|[1-4])$/.test(raw || '')) return null;
  return Number(raw);
}

export function stripHomepageStartQuery(pathname, search, hash) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (!params.has('start')) {
    return {changed: false, href: (pathname || '') + (search || '') + (hash || '')};
  }
  params.delete('start');
  const next = params.toString();
  const href = (pathname || '') + (next ? '?' + next : '') + (hash || '');
  return {changed: true, href};
}

function searchHitKey(hit) {
  return [hit.kind || '', hit.conversationId || '', hit.messageId || hit.id || '', hit.preview || '']
    .join('\u0000');
}

export function searchHitFromItem(item) {
  return {
    type: item.kind === 'social' ? 'social' : 'agent-message',
    id: item.conversation_id,
    messageId: item.message_id || '',
    title: item.title || '消息',
    preview: item.snippet || '',
    conversationId: item.conversation_id,
    kind: item.kind,
  };
}

export function mergeSearchHits(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const hit of [...(existing || []), ...(incoming || [])]) {
    const key = searchHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

// The server pages message hits by keyset cursor. This controller keeps the
// rows already shown and appends the next page, so a failed or repeated page
// never drops what the user is already reading.
export function createMessageSearch(loadPage) {
  const state = {hits: [], cursor: '', loading: false, error: ''};
  let generation = 0;
  let pending = null;
  let activeKey = '';
  async function load(query, conversationId = '', {append = false} = {}) {
    const text = String(query || '').trim();
    const key = JSON.stringify([text, conversationId]);
    if (!text) {
      generation += 1;
      activeKey = '';
      pending = null;
      Object.assign(state, {hits: [], cursor: '', error: '', loading: false});
      return state;
    }
    // A tab switch during the same search must await the existing request,
    // not render its temporary empty state and invalidate the completing view.
    if (state.loading && key === activeKey) return pending;
    if (append && state.loading) return state;
    const token = ++generation;
    activeKey = key;
    if (!append) {
      state.hits = [];
      state.cursor = '';
    }
    state.loading = true;
    pending = (async () => {
      try {
        const page = await loadPage(text, conversationId, append ? state.cursor : '');
        if (token !== generation) return state;
        const incoming = ((page && page.items) || []).map(searchHitFromItem);
        state.hits = mergeSearchHits(append ? state.hits : [], incoming);
        state.cursor = (page && page.cursor) || '';
        state.error = '';
      } catch (failure) {
        if (token !== generation) return state;
        state.error = (failure && failure.message) || '无法搜索消息。';
        if (!append) {
          state.hits = [];
          state.cursor = '';
        }
      } finally {
        if (token === generation) state.loading = false;
      }
      return state;
    })();
    return pending;
  }
  return {state, load};
}

export function searchMoreVisible(state) {
  return Boolean(state && state.cursor && !state.loading);
}

export function applySearchMore(node, state) {
  if (!node) return;
  node.hidden = !searchMoreVisible(state);
  node.disabled = Boolean(state && state.loading);
}

export const GROUP_CREATE_INTRO = '添加名称，然后邀请好友并添加 AI 智能体。';
export const GROUP_CREATE_MODES = [
  ['custom', '自定义群组'],
  ['team', 'AI 智能体团队'],
];

export function composeSelectedLabel(count) {
  return '已选 ' + Number(count || 0);
}

export function filterMemberChoices(members, currentUserId, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const list = memberChoices(members, currentUserId);
  if (!needle) return list;
  return list.filter(member => String(member.username || '').toLocaleLowerCase().includes(needle));
}

export function groupPickerChoices(members, currentUserId, agents = []) {
  return [
    ...memberChoices(members, currentUserId).map(member => ({
      id: member.user_id, kind: 'human', label: member.username + ' · 成员',
    })),
    ...agents.filter(agent => !agent.archived).map(agent => ({
      id: agent.id, kind: 'agent', label: agent.name + ' · AI 智能体（自动回复未接通）',
    })),
  ];
}

export function groupAgentSummary(conversation) {
  const list = conversation && conversation.agent_members || [];
  return list.length ? '群内智能体：' + list.map(agent => agent.name).join('、')
    + '。可明确请求一次回复。未接通：群内自动回复、@Agent 和任务委派。' : '';
}

export function groupReplyStatus(reply) {
  const labels = {queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消'};
  const errors = {no_agent: '没有可用运行时连接', quota: '运行时任务容量已满', timeout: '执行超时',
    runtime_failed: '运行时执行失败', empty_reply: '运行时未返回正文', task_missing: '运行时任务丢失', cancelled: '已取消'};
  return (labels[reply.status] || '未知状态') + (reply.error_code ? '：' + (errors[reply.error_code] || '请求失败') : '');
}

export function composeCreateEnabled(options) {
  const mode = options && options.composeMode;
  const groupMode = (options && options.groupMode) || 'custom';
  const selectedCount = Number((options && options.selectedCount) || 0);
  if (mode === 'contact') return selectedCount === 1;
  if (mode === 'group') return groupMode === 'custom'
    && selectedCount <= 49 && Number(options.selectedHumanCount ?? selectedCount) >= 1;
  return false;
}

export function composeGroupPayload(memberIds, title, agentIds = []) {
  const body = {kind: 'group', member_ids: memberIds};
  const name = String(title || '').trim();
  if (name) body.title = name;
  if (agentIds.length) body.agent_ids = agentIds;
  return body;
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

export function sessionDisplayGroup(item) {
  return item.pinned ? '置顶' : (item.kind === 'group' ? '群聊' : '直聊');
}

export function groupSessionsForDisplay(items) {
  return ['置顶', '直聊', '群聊'].flatMap(group => items.filter(item => sessionDisplayGroup(item) === group));
}

export function formatSessionTime(value, now = Date.now()) {
  const timestamp = Number(value) * 1000;
  if (!value || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const day = ms => Math.floor((ms + 8 * 3600000) / 86400000);
  const days = day(now) - day(timestamp);
  if (days === 0) return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', weekday: 'short'}).format(date);
  return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'numeric', day: 'numeric'}).format(date);
}

export function initial(name) {
  const text = (name || '').trim();
  const match = text.match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : '?';
}

export function chatIdentity(name) {
  const title = (name || '').trim() || '聊天';
  const placeholder = title === '聊天';
  return {title, initial: placeholder ? '' : initial(title), showAvatar: !placeholder};
}

export function applyChatIdentity(document, name) {
  const identity = chatIdentity(name);
  const title = document.getElementById('chat-title');
  const avatar = document.getElementById('chat-avatar');
  if (title) title.textContent = identity.title;
  if (avatar) {
    avatar.textContent = identity.initial;
    avatar.hidden = !identity.showAvatar;
  }
  return identity;
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
  let searchConversation = '';
  let searchConversationTitle = '';
  let composeMode = 'group';
  let groupMode = 'custom';
  let groupReplyAttempt = null;
  let groupReplyBusy = false;
  let searchSeq = 0;
  let resourceCursor = '';
  let resourceItems = [];
  let sendShortcut = 'enter';

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

  const messageSearch = createMessageSearch(async (query, conversationId, cursor) => {
    const result = await request(
      'GET',
      `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`,
    );
    if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法搜索消息。'));
    return {items: result.body.items || [], cursor: result.body.cursor || ''};
  });

  function renderGroupReplyAction(requests) {
    const panel = document.getElementById('group-agent-action');
    const isGroup = currentSource === 'social' && currentConversation
      && currentConversation.kind === 'group';
    panel.hidden = !isGroup;
    if (!isGroup) return;
    const saved = currentConversation.agent_members || [];
    const active = new Set((requests || []).filter(item =>
      ['queued', 'running'].includes(item.status)).map(item => item.agent_id));
    const chips = document.getElementById('group-agent-chips');
    chips.replaceChildren();
    for (const agent of saved) {
      const li = document.createElement('li');
      li.className = 'agent-chip';
      const name = document.createElement('span');
      name.textContent = agent.name + (agent.archived ? '（已归档）' : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除';
      remove.dataset.removeAgent = agent.agent_id;
      li.append(name, remove);
      chips.append(li);
    }
    const add = document.getElementById('group-agent-add');
    add.replaceChildren();
    const joined = new Set(saved.map(agent => agent.agent_id));
    const available = agents.filter(agent => !agent.archived && !joined.has(agent.id));
    for (const agent of available) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      add.append(option);
    }
    add.disabled = !available.length;
    document.getElementById('group-agent-add-submit').disabled = !available.length;
    const holder = document.getElementById('group-agent-choices');
    holder.replaceChildren();
    for (const agent of saved.filter(item => !item.archived)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'group-agent';
      box.value = agent.agent_id;
      box.disabled = active.has(agent.agent_id);
      label.append(box, document.createTextNode(agent.name + (active.has(agent.agent_id) ? '（回复中）' : '')));
      holder.append(label);
    }
    const list = document.getElementById('group-agent-requests');
    list.replaceChildren();
    for (const request of requests || []) {
      const item = document.createElement('li');
      item.textContent = request.agent_name + ' · ' + request.prompt + ' · ' + groupReplyStatus(request);
      item.dataset.replyStatus = request.status;
      list.append(item);
    }
    document.getElementById('group-agent-submit').disabled = groupReplyBusy
      || !holder.querySelector('input:not(:disabled)');
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

  function setSessionsOpen(open) {
    if (open) document.body.classList.add('sessions-open');
    else document.body.classList.remove('sessions-open');
  }

  function narrowScreen() {
    return typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(max-width: 900px)').matches;
  }

  function renderSessions() {
    const list = document.getElementById('conversation-list');
    list.replaceChildren();
    document.getElementById('conversation-heading').textContent = '对话 · ' + sessions.length;
    document.getElementById('conversations-empty').hidden = sessions.length > 0;
    const filterNode = document.getElementById('session-filter-value');
    const filter = (filterNode && filterNode.value) || 'all';
    const visible = sessions.filter(item => filter === 'all'
      || (filter === 'pinned' && item.pinned)
      || (filter === 'unread' && item.source === 'social' && item.unread_count > 0)
      || (filter === 'read' && item.source === 'social' && !item.unread_count)
      || (filter === 'group' && item.kind === 'group') || (filter === 'dm' && item.kind === 'dm'));
    document.getElementById('conversations-empty').hidden = visible.length > 0;
    let lastGroup = '';
    for (const session of groupSessionsForDisplay(visible)) {
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
      title.textContent = (session.pinned ? '置顶 · ' : '') + session.title;
      const preview = document.createElement('span');
      preview.className = 'preview';
      preview.textContent = session.preview || '';
      copy.append(title, preview);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatSessionTime(session.updated);
      time.title = formatTime(session.updated);
      button.append(avatar, copy, time);
      if (session.unread_count > 0) {
        const unread = document.createElement('span');
        unread.className = 'unread-badge';
        unread.textContent = String(session.unread_count);
        unread.setAttribute('aria-label', session.unread_count + ' 条未读消息');
        time.append(unread);
      }

      const group = sessionDisplayGroup(session);
      if (group !== lastGroup) {
        li.className = 'session-divider'; li.dataset.section = group; lastGroup = group;
      }
      button.setAttribute('aria-label', group + '：' + session.title);
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
      role.textContent = item.role === 'agent' ? (item.agent_name + ' · AI 智能体 · 运行时回复')
        : (mine ? '我' : ((member && member.username) || '成员'));
      const body = document.createElement('p');
      body.className = 'body';
      body.textContent = item.retracted ? '此消息已撤回' : (item.body || '');
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(role, body, time);
      if (item.attachment && !item.retracted) {
        const file = document.createElement('a'); file.href = item.attachment.path;
        file.textContent = '下载附件：' + item.attachment.title; li.append(file);
      }
      if (mine && !item.retracted) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.textContent = '编辑';
        const retract = document.createElement('button');
        retract.type = 'button'; retract.textContent = '撤回';
        const controls = document.createElement('span');
        const change = async (operation, text) => {
          const payload = {revision: item.revision || 1};
          if (operation === 'edit') payload.body = text;
          const wid = workspaceId(), cid = currentConversation.id;
          const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/${operation}`, payload);
          if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
          if (result.status !== 200) { show('error', messageFor(result.body.error, '消息未更新，请重新打开后重试。')); return; }
          await loadSessions();
          await openSocialConversation(cid);
        };
        edit.addEventListener('click', () => {
          controls.replaceChildren();
          const input = document.createElement('textarea'); input.value = item.body || '';
          input.setAttribute('aria-label', '编辑消息'); input.maxLength = 4000;
          const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存修改';
          save.addEventListener('click', () => change('edit', input.value));
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          controls.append(input, save, cancel);
        });
        retract.addEventListener('click', () => {
          controls.replaceChildren();
          const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认撤回';
          confirm.addEventListener('click', () => change('retract'));
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          controls.append(confirm, cancel);
        });
        li.append(edit, retract, controls);
      }
      list.append(li);
    }
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    return false;
  }

  function setDirectoryLink(session) {
    if (!session || session.source !== 'social') {
      document.getElementById('social-agent-members').hidden = true;
      document.getElementById('group-agent-action').hidden = true;
    }
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
    const pin = document.getElementById('pin-conversation');
    if (pin) pin.hidden = true;
    const agent = agents.find(item => item.id === agentId);
    if (!agent) {
      show('error', '找不到这个智能体。');
      return;
    }
    currentAgent = agent;
    currentSource = 'agent';
    document.getElementById('social-agent-members').hidden = true;
    applyChatIdentity(document, agent.name);
    setDirectoryLink({source: 'agent'});
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/agents/${agentId}/conversations/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return;
    }
    if (!currentConversation || currentConversation.id !== result.body.conversation.id) {
      const panel = document.getElementById('conversation-search-panel'); if (panel) panel.hidden = true;
      const hits = document.getElementById('conversation-search-results'); if (hits) hits.replaceChildren();
    }
    currentConversation = result.body.conversation;
    writeHash({workspace: workspaceId(), agent: agentId, conversation: conversationId});
    setSessionsOpen(false);
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
    if (!currentConversation || currentConversation.id !== result.body.conversation.id) {
      const panel = document.getElementById('conversation-search-panel'); if (panel) panel.hidden = true;
      const hits = document.getElementById('conversation-search-results'); if (hits) hits.replaceChildren();
    }
    currentConversation = result.body.conversation;
    setSessionsOpen(false);
    const pin = document.getElementById('pin-conversation');
    if (pin) { pin.hidden = false; pin.textContent = sessions.find(item => item.id === conversationId && item.pinned) ? '取消置顶' : '置顶会话'; }
    const agentNote = document.getElementById('social-agent-members');
    agentNote.textContent = groupAgentSummary(currentConversation);
    agentNote.hidden = !agentNote.textContent;
    applyChatIdentity(document, conversationLabel(
      currentConversation, currentUser && currentUser.id));
    setDirectoryLink({source: 'social'});
    writeHash({workspace: workspaceId(), social: conversationId});
    renderSocialMessages(result.body.items);
    renderGroupReplyAction(result.body.agent_replies || []);
    // Acknowledge only the last message actually rendered, not messages that
    // arrived after this snapshot, and never consume unread in a hidden tab.
    const shown = result.body.items || [];
    if (currentConversation.unread_count > 0 && shown.length && document.visibilityState !== 'hidden') {
      const acknowledged = await request('POST', `${socialBase()}/${conversationId}/read`,
        {message_id: shown[shown.length - 1].id});
      if (acknowledged.status === 200) {
        const session = sessions.find(item => item.source === 'social' && item.id === conversationId);
        if (session) session.unread_count = acknowledged.body.unread_count;
      }
    }
    renderSessions();
    if ((result.body.agent_replies || []).some(item => ['queued', 'running'].includes(item.status))) schedulePoll();
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      if (currentConversation && currentAgent && currentSource === 'agent') {
        openAgentConversation(currentAgent.id, currentConversation.id);
      } else if (currentConversation && currentSource === 'social') {
        openSocialConversation(currentConversation.id);
      }
    }, 2000);
  }

  function closeComposeMenu() {
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function selectedMemberCount() {
    return document.querySelectorAll('#member-choices input:checked').length;
  }

  function syncComposeCreate() {
    const button = document.getElementById('compose-dialog-submit');
    button.disabled = !composeCreateEnabled({
      composeMode,
      groupMode,
      selectedCount: selectedMemberCount(),
      selectedHumanCount: document.querySelectorAll('#member-choices input[name="member"]:checked').length,
    });
  }

  function applyMemberFilter() {
    const input = document.getElementById('compose-member-search');
    const needle = (input.value || '').trim().toLocaleLowerCase();
    const labels = [...document.querySelectorAll('#member-choices label')];
    let visible = 0;
    for (const label of labels) {
      const show = !needle || label.textContent.trim().toLocaleLowerCase().includes(needle);
      label.hidden = !show;
      if (show) visible += 1;
    }
    const empty = document.getElementById('compose-members-empty');
    if (!labels.length) {
      empty.hidden = false;
      empty.textContent = '没有可邀请的工作区成员。';
    } else if (!visible) {
      empty.hidden = false;
      empty.textContent = '没有匹配的成员。';
    } else {
      empty.hidden = true;
    }
  }

  function syncSelectedCount() {
    document.getElementById('compose-selected-count').textContent = composeSelectedLabel(selectedMemberCount());
    syncComposeCreate();
  }

  function setGroupMode(mode) {
    groupMode = mode === 'team' ? 'team' : 'custom';
    for (const button of document.querySelectorAll('#compose-mode-switch [data-group-mode]')) {
      button.setAttribute('aria-selected', button.dataset.groupMode === groupMode ? 'true' : 'false');
    }
    const team = composeMode === 'group' && groupMode === 'team';
    document.getElementById('compose-team-note').hidden = !team;
    document.getElementById('compose-member-picker').hidden = team;
    if (composeMode === 'group') {
      document.getElementById('compose-title-label').hidden = team;
    }
    syncComposeCreate();
  }

  function closeComposeDialog() {
    document.getElementById('compose-dialog').hidden = true;
    document.getElementById('compose-social-form').reset();
    setGroupMode('custom');
    applyMemberFilter();
    syncSelectedCount();
  }

  function renderMemberChoices(single) {
    const holder = document.getElementById('member-choices');
    holder.replaceChildren();
    const choices = groupPickerChoices(members, currentUser && currentUser.id, single ? [] : agents);
    for (const member of choices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      box.name = member.kind === 'agent' ? 'agent-member' : 'member';
      box.value = member.id;
      label.append(box, document.createTextNode(member.label));
      holder.append(label);
    }
    applyMemberFilter();
    syncSelectedCount();
  }

  function openComposeDialog(mode) {
    closeComposeMenu();
    composeMode = mode;
    const dialog = document.getElementById('compose-dialog');
    dialog.hidden = false;
    const isGroup = mode === 'group';
    document.getElementById('compose-dialog-title').textContent = isGroup ? '新建群组' : '添加联系人';
    document.getElementById('compose-members-legend').textContent = isGroup ? '成员' : '选择一位成员，开始单聊';
    document.getElementById('compose-intro').hidden = !isGroup;
    document.getElementById('compose-mode-switch').hidden = !isGroup;
    document.getElementById('compose-title-label').hidden = !isGroup;
    document.getElementById('compose-member-tools').hidden = !isGroup;
    document.getElementById('compose-team-note').hidden = true;
    document.getElementById('compose-member-picker').hidden = false;
    if (!isGroup) document.getElementById('compose-title').value = '';
    document.getElementById('compose-member-search').value = '';
    setGroupMode('custom');
    renderMemberChoices(mode === 'contact');
  }

  function setSearchTab(name) {
    searchTab = name;
    if (name !== 'messages') searchConversation = '';
    for (const tab of document.querySelectorAll('#search-panel [data-search-tab]')) {
      tab.setAttribute('aria-selected', tab.dataset.searchTab === name ? 'true' : 'false');
    }
  }

  function openSearchPanel(tab, conversationId = '') {
    searchConversation = conversationId;
    searchConversationTitle = document.getElementById('chat-title').textContent;
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
    searchSeq++;
    searchConversation = '';
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

  async function renderSearch({reuseMessages = false, appendResources = false} = {}) {
    const query = (document.getElementById('session-search').value || '').trim();
    const results = document.getElementById('search-results');
    const empty = document.getElementById('search-empty');
    const note = document.getElementById('search-source-note');
    results.replaceChildren();
    empty.hidden = true;
    note.hidden = Boolean(query) && !searchConversation;
    note.textContent = searchConversation
      ? '仅搜索当前对话：' + searchConversationTitle
      : '以下是当前工作区里已有的内容，不是站外推荐。';
    const seq = ++searchSeq;

    if (searchTab === 'files' || searchTab === 'links') {
      const params = new URLSearchParams({kind: searchTab, q: query, limit: '20'});
      if (appendResources && resourceCursor) params.set('cursor', resourceCursor);
      const found = await request('GET', `/v1/workspaces/${workspaceId()}/search/resources?${params}`);
      if (seq !== searchSeq) return;
      if (found.status !== 200) { empty.hidden = false; empty.textContent = '无法加载搜索结果。'; return; }
      resourceItems = appendResources ? resourceItems.concat(found.body.items || []) : (found.body.items || []);
      resourceCursor = found.body.cursor || '';
      addSearchSection(results, searchTab === 'files' ? '文件' : '链接', resourceItems, () => {});
      empty.hidden = Boolean(resourceItems.length); empty.textContent = '没有匹配的结果。';
      const more = document.getElementById('search-more');
      if (more) { more.hidden = !resourceCursor; more.disabled = false; }
      return;
    }
    if (searchTab === 'messages' && !query) {
      empty.hidden = false;
      empty.textContent = searchConversation
        ? '输入关键词，搜索当前对话中你有权查看的消息。'
        : '输入关键词，搜索你在这个工作区里有权查看的消息。';
      return;
    }

    let messageItems = [];
    if ((searchTab === 'messages' || searchTab === 'all') && query) {
      if (!reuseMessages) await messageSearch.load(query, searchConversation);
      if (seq !== searchSeq) return;
      const state = messageSearch.state;
      if (state.error && searchTab === 'messages' && !state.hits.length) {
        empty.hidden = false;
        empty.textContent = state.error;
        applySearchMore(document.getElementById('search-more'), {cursor: '', loading: false});
        return;
      }
      messageItems = state.hits;
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
            if (currentAgent) applyChatIdentity(document, currentAgent.name);
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
    const paged = searchTab === 'messages' || searchTab === 'all';
    if (paged && query && messageSearch.state.error) {
      empty.hidden = false;
      empty.textContent = messageSearch.state.error;
    }
    applySearchMore(
      document.getElementById('search-more'),
      paged && query ? messageSearch.state : {cursor: '', loading: false},
    );
  }

  async function startHomepageConversation(index) {
    const result = await request('POST', '/v1/agent-homepages/start', {quick_start: index}, {
      'Idempotency-Key': idempotencyKey('home-start-'),
    });
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(
        result.body && result.body.error,
        result.status === 401
          ? '请先登录，再从公开主页发起对话。'
          : '无法从公开主页发起对话。只有工作区成员可以，且需要先打开该公开主页。',
      ));
      return false;
    }
    const conversation = result.body && result.body.conversation;
    if (!conversation || !conversation.id || !conversation.agent_id || !conversation.workspace_id) {
      show('error', '无法从公开主页发起对话。');
      return false;
    }
    if ([...workspaceSelect.options].some(option => option.value === conversation.workspace_id)) {
      workspaceSelect.value = conversation.workspace_id;
    }
    await loadSessions();
    await openAgentConversation(conversation.agent_id, conversation.id);
    return true;
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      document.getElementById('session-pane').hidden = true;
      document.body.classList.remove('chat-open');
      setSessionsOpen(false);
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('session-pane').hidden = false;
    document.body.classList.add('chat-open');
    setSessionsOpen(true);
    document.getElementById('whoami').textContent = currentUser.username;
    const onboarding = await request('GET', '/v1/onboarding');
    const banner = document.getElementById('onboarding-banner');
    if (banner && onboarding.status === 200) {
      banner.hidden = Boolean(onboarding.body.onboarding && onboarding.body.onboarding.completed);
    }

    const personal = await request('POST', '/v1/personal-agent');
    const personalWorkspace = personal.status === 200 && personal.body.personal_agent
      ? personal.body.personal_agent.workspace.id : '';
    const [listed, settings] = await Promise.all([
      request('GET', '/v1/workspaces?limit=100'),
      request('GET', '/v1/settings'),
    ]);
    const stored = settings.status === 200 && settings.body && settings.body.settings
      && settings.body.settings.values && settings.body.settings.values.send_shortcut;
    sendShortcut = stored === 'mod_enter' ? 'mod_enter' : 'enter';
    document.getElementById('chat-body').dataset.sendShortcut = sendShortcut;
    workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const wanted = hashParams().workspace || personalWorkspace || workspaceSelect.value;
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
    const homepageStart = homepageStartIndex();
    if (homepageStart !== null) {
      const started = await startHomepageConversation(homepageStart);
      const stripped = stripHomepageStartQuery(location.pathname, location.search, location.hash);
      if (stripped.changed) history.replaceState(null, '', stripped.href);
      if (started) {
        show('', '');
        return;
      }
    }
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
        if (currentAgent) applyChatIdentity(document, currentAgent.name);
        document.getElementById('chat-empty').hidden = false;
        writeHash({workspace: workspaceId(), agent: start.agent});
      }
    } else if (sessions.length && !narrowScreen()) {
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
    const inChatPanel = document.getElementById('conversation-search-panel'); if (inChatPanel) inChatPanel.hidden = true;
    writeHash({workspace: workspaceId()});
    applyChatIdentity(document, '聊天');
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    setDirectoryLink({source: 'agent'});
    await loadSessions();
  });

  document.getElementById('session-search').addEventListener('focus', () => {
    if (!isSearchOpen()) openSearchPanel();
  });
  document.getElementById('session-search').addEventListener('input', () => {
    if (!isSearchOpen()) openSearchPanel();
    else renderSearch();
  });
  const inChatSearch = createMessageSearch(async (query, conversationId, cursor) => {
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`);
    if (result.status !== 200) throw new Error('无法搜索当前会话。');
    return result.body;
  });
  async function searchCurrentConversation(append = false) {
    const conversation = currentConversation;
    const query = (document.getElementById('conversation-search-query').value || '').trim();
    if (!conversation || !query) return;
    const wid = workspaceId();
    const state = await inChatSearch.load(query, conversation.id, {append});
    if (workspaceId() !== wid || !currentConversation || currentConversation.id !== conversation.id) return;
    const list = document.getElementById('conversation-search-results'); list.replaceChildren();
    for (const hit of state.hits) {
      const li = document.createElement('li'); li.textContent = hit.snippet || hit.preview || ''; list.append(li);
    }
    document.getElementById('conversation-search-status').textContent = state.error || ('已显示 ' + state.hits.length + ' 条消息');
    document.getElementById('conversation-search-more').hidden = !state.cursor;
  }
  const inChatOpen = document.getElementById('conversation-search-open');
  if (inChatOpen) inChatOpen.addEventListener('click', () => {
    if (!currentConversation) { show('error', '请先打开一个会话。'); return; }
    document.getElementById('conversation-search-panel').hidden = false;
  });
  const inChatClose = document.getElementById('conversation-search-close');
  if (inChatClose) inChatClose.addEventListener('click', () => { document.getElementById('conversation-search-panel').hidden = true; });
  const inChatForm = document.getElementById('conversation-search-form');
  if (inChatForm) inChatForm.addEventListener('submit', async event => { event.preventDefault(); await searchCurrentConversation(); });
  const inChatMore = document.getElementById('conversation-search-more');
  if (inChatMore) inChatMore.addEventListener('click', () => searchCurrentConversation(true));
  const attachmentInput = document.getElementById('chat-attachment');
  if (attachmentInput) attachmentInput.addEventListener('change', async () => {
    const file = attachmentInput.files && attachmentInput.files[0];
    if (!file || !currentConversation || currentSource !== 'social') { show('error', '请先打开单聊或群聊。'); return; }
    const wid = workspaceId(), cid = currentConversation.id;
    attachmentInput.disabled = true;
    try {
      const form = new FormData(); form.append('kind', 'media'); form.append('title', file.name); form.append('file', file);
      const response = await fetcher(`/v1/workspaces/${wid}/artifacts`, {method: 'POST', credentials: 'same-origin',
        headers: {'X-CSRF-Token': csrfCookie(document.cookie), 'Idempotency-Key': idempotencyKey()}, body: form});
      const uploaded = await response.json();
      if (response.status !== 201) throw new Error(messageFor(uploaded.error, '附件未上传。'));
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/messages`,
        {body: '', artifact_id: uploaded.artifact.id}, {'Idempotency-Key': idempotencyKey()});
      if (result.status !== 201 && result.status !== 200) throw new Error('作品已上传，但附件消息未发送；文件仍在工作区作品库。');
      if (workspaceId() === wid && currentConversation && currentConversation.id === cid) {
        await loadSessions(); await openSocialConversation(cid);
      }
      show('ok', '附件已上传到工作区作品库并发送。');
    } catch (failure) { show('error', failure.message || '附件未发送。'); }
    finally { attachmentInput.disabled = false; attachmentInput.value = ''; }
  });
  const filterButton = document.getElementById('session-filter');
  if (filterButton) filterButton.addEventListener('click', () => {
    const label = document.getElementById('session-filter-label'); if (label) label.hidden = !label.hidden;
  });
  const filterValue = document.getElementById('session-filter-value');
  if (filterValue) filterValue.addEventListener('change', renderSessions);
  const pinButton = document.getElementById('pin-conversation');
  if (pinButton) pinButton.addEventListener('click', async () => {
    if (currentSource !== 'social' || !currentConversation) return;
    const id = currentConversation.id;
    const pinned = Boolean(sessions.find(item => item.id === id && item.pinned));
    const result = await request('POST', `${socialBase()}/${id}/preferences`, {pinned: !pinned});
    if (result.status !== 200) { show('error', '置顶未保存。'); return; }
    await loadSessions(); await openSocialConversation(id);
  });
  document.getElementById('search-close').addEventListener('click', closeSearchPanel);
  document.getElementById('chat-back').addEventListener('click', () => setSessionsOpen(true));
  document.getElementById('search-more').addEventListener('click', async () => {
    if (searchTab === 'files' || searchTab === 'links') { if (resourceCursor) await renderSearch({appendResources: true}); return; }
    const query = (document.getElementById('session-search').value || '').trim();
    if (!query || messageSearch.state.loading || !messageSearch.state.cursor) return;
    await messageSearch.load(query, searchConversation, {append: true});
    await renderSearch({reuseMessages: true});
  });
  document.getElementById('message-search').addEventListener('click', () => {
    if (!currentConversation) {
      show('error', '请先打开一个对话再搜索。');
      return;
    }
    document.getElementById('session-search').value = '';
    openSearchPanel('messages', currentConversation.id);
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
  document.getElementById('group-agent-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (groupReplyBusy || currentSource !== 'social' || !currentConversation) return;
    const cid = currentConversation.id;
    const agentIds = [...document.querySelectorAll('#group-agent-choices input[name="group-agent"]:checked')]
      .map(box => box.value);
    const prompt = document.getElementById('group-agent-prompt').value;
    if (!agentIds.length) {
      show('error', '请选择至少一个群内智能体。');
      return;
    }
    if (!prompt.trim()) return;
    const fingerprint = JSON.stringify([workspaceId(), cid, agentIds.slice().sort(), prompt]);
    if (!groupReplyAttempt || groupReplyAttempt.fingerprint !== fingerprint) {
      groupReplyAttempt = {fingerprint, key: idempotencyKey('group-reply-')};
    }
    groupReplyBusy = true;
    document.getElementById('group-agent-submit').disabled = true;
    try {
      const result = await request('POST', `${socialBase()}/${cid}/agent-replies`,
        {agent_ids: agentIds, prompt}, {'Idempotency-Key': groupReplyAttempt.key});
      if (![200, 201].includes(result.status)) {
        show('error', messageFor(result.body.error, '请求未确认；重试相同内容将复用请求标识。'));
        return;
      }
      groupReplyAttempt = null;
      if (currentSource === 'social' && currentConversation && currentConversation.id === cid) {
        await openSocialConversation(cid);
        const replies = result.body.replies || (result.body.reply ? [result.body.reply] : []);
        const failed = replies.filter(item => item.status === 'failed').length;
        show(failed ? 'error' : 'ok', failed
          ? (replies.length - failed) + ' 个已提交，' + failed + ' 个失败。'
          : '已请求 ' + replies.length + ' 个智能体回复。');
      }
    } finally {
      groupReplyBusy = false;
      if (currentSource === 'social' && currentConversation && currentConversation.id === cid) {
        await openSocialConversation(cid);
      }
    }
  });

  document.getElementById('group-agent-chips').addEventListener('click', async event => {
    const button = event.target.closest('button[data-remove-agent]');
    if (!button || currentSource !== 'social' || !currentConversation) return;
    const cid = currentConversation.id;
    const result = await request('POST',
      `${socialBase()}/${cid}/agents/${button.dataset.removeAgent}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法移除智能体。'));
      return;
    }
    await openSocialConversation(cid);
    show('ok', '已移除智能体。');
  });

  document.getElementById('group-agent-add-submit').addEventListener('click', async () => {
    if (currentSource !== 'social' || !currentConversation) return;
    const select = document.getElementById('group-agent-add');
    if (!select.value) return;
    const cid = currentConversation.id;
    const result = await request('POST', `${socialBase()}/${cid}/agents`, {agent_ids: [select.value]});
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法添加智能体。'));
      return;
    }
    await openSocialConversation(cid);
    show('ok', '已添加智能体。');
  });

  document.getElementById('compose-new-group').addEventListener('click', () => openComposeDialog('group'));
  document.getElementById('compose-add-contact').addEventListener('click', () => openComposeDialog('contact'));
  document.getElementById('compose-dialog-cancel').addEventListener('click', closeComposeDialog);
  document.getElementById('compose-mode-switch').addEventListener('click', event => {
    const button = event.target.closest('[data-group-mode]');
    if (!button || composeMode !== 'group') return;
    setGroupMode(button.dataset.groupMode);
  });
  document.getElementById('compose-member-search').addEventListener('input', applyMemberFilter);
  document.getElementById('member-choices').addEventListener('change', syncSelectedCount);

  document.getElementById('compose-social-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (composeMode === 'group' && groupMode !== 'custom') {
      show('error', '未接通：还不能从这里创建 AI 智能体团队。');
      return;
    }
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
    const body = composeMode === 'contact'
      ? {kind: 'dm', member_ids: memberIds.slice(0, 1)}
      : composeGroupPayload(memberIds, title,
        [...document.querySelectorAll('#member-choices input[name="agent-member"]:checked')].map(box => box.value));
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


  async function sendCurrentMessage() {
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
  }

  document.getElementById('chat-body').addEventListener('keydown', event => {
    if (!shouldSendOnShortcut(event, sendShortcut)) return;
    event.preventDefault();
    if (!(document.getElementById('chat-body').value || '').trim()) return;
    sendCurrentMessage();
  }, true);

  document.getElementById('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    sendCurrentMessage();
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
