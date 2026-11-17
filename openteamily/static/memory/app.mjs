export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function listQuery(needle, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function actionQuery(needle, status, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function dueDateValue(dueAt) {
  if (dueAt == null || dueAt === '') return '';
  const date = new Date(Number(dueAt) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function dueAtFromDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
}

export function parseTopics(value) {
  const names = [];
  const seen = new Set();
  for (const part of String(value || '').split(/[,，\n]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function formatTopics(topics) {
  return (topics || []).join('，');
}

export function memoryUpdatedLabel(updated) {
  if (updated == null || updated === '') return '';
  const date = new Date(Number(updated) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function topicKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

export function directoryGroups(pages, topicCatalog) {
  const rows = [...(pages || [])];
  const byId = new Map(rows.map((page) => [page.id, page]));
  const catalog = [];
  const seen = new Set();
  const addTopic = (name) => {
    const label = String(name || '').trim();
    const key = topicKey(label);
    if (!label || seen.has(key)) return;
    seen.add(key);
    catalog.push(label);
  };
  for (const topic of topicCatalog || []) {
    addTopic(topic && topic.name);
  }
  for (const page of rows) {
    for (const name of page.topics || []) addTopic(name);
  }
  const used = new Set();
  const groups = [];
  for (const name of catalog) {
    const key = topicKey(name);
    const items = [];
    const seenIds = new Set();
    const catalogTopic = (topicCatalog || []).find((topic) => topicKey(topic && topic.name) === key);
    const hinted = (catalogTopic && catalogTopic.pages ? catalogTopic.pages : []).map((page) => page && page.id);
    for (const page of rows) {
      const tagged = (page.topics || []).some((item) => topicKey(item) === key);
      const listed = hinted.includes(page.id);
      if (!tagged && !listed) continue;
      if (seenIds.has(page.id) || !byId.has(page.id)) continue;
      seenIds.add(page.id);
      items.push(page);
      used.add(page.id);
    }
    if (!items.length) continue;
    groups.push({name, count: items.length, pages: items});
  }
  return {groups, ungrouped: rows.filter((page) => !used.has(page.id))};
}

export function memoryPageFromSearch(search) {
  const value = new URLSearchParams(search || '').get('page');
  if (value === 'profile') return 'profile';
  if (value === 'todos') return 'actions';
  return 'overview';
}

export function queryForMemoryPage(view) {
  if (view === 'profile') return '?page=profile';
  if (view === 'actions') return '?page=todos';
  return '';
}

export function graphLayout(nodes, width = 640, height = 400, padding = 56) {
  const list = [...(nodes || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cx = width / 2;
  const cy = height / 2;
  if (list.length === 0) return [];
  if (list.length === 1) return [{id: list[0].id, x: cx, y: cy}];
  const radius = Math.max(0, Math.min(cx, cy) - padding);
  return list.map((node, index) => {
    const angle = ((Math.PI * 2 * index) / list.length) - (Math.PI / 2);
    return {
      id: node.id,
      x: Number((cx + radius * Math.cos(angle)).toFixed(2)),
      y: Number((cy + radius * Math.sin(angle)).toFixed(2)),
    };
  });
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function applyTheme(settings) {
  const appearance = settings && settings.appearance;
  document.body.dataset.theme = appearance === 'dark' || appearance === 'light' ? appearance : '';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const listEl = document.getElementById('memory-list');
  const emptyEl = document.getElementById('list-empty');
  const editor = document.getElementById('editor-form');
  const actionEditor = document.getElementById('action-editor-form');
  const listPanel = document.getElementById('list-panel');
  let currentUser = null;
  let workspaces = [];
  let currentPage = null;
  let currentAction = null;
  let pageChoices = [];
  let currentView = 'overview';
  let listFilter = 'all';
  let topicFilter = '';
  let sideTab = 'topics';
  let graphZoom = 1;
  let topicQuery = '';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
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

  function workspaceId() {
    return workspaceSelect.value;
  }

  function randomKey() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function visiblePages(items) {
    const rows = [...(items || [])];
    if (listFilter === 'updated') {
      rows.sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
      return rows;
    }
    if (listFilter === 'topics' && topicFilter) {
      const topic = (currentGraph.topics || []).find((item) => item.name === topicFilter);
      const allowed = new Set((topic && topic.pages ? topic.pages : []).map((page) => page.id));
      return rows.filter((item) => allowed.has(item.id));
    }
    return rows;
  }

  function pageButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memory-page-link';
    button.dataset.id = item.id;
    const title = document.createElement('span');
    title.className = 'memory-page-title';
    title.textContent = item.title;
    button.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'memory-page-meta';
    const parts = [memoryUpdatedLabel(item.updated), ...(item.topics || [])].filter(Boolean);
    meta.textContent = parts.join(' · ');
    if (meta.textContent) button.appendChild(meta);
    button.addEventListener('click', () => openPage(item.id));
    return button;
  }

  function appendPage(parent, item) {
    const li = document.createElement('li');
    li.appendChild(pageButton(item));
    parent.appendChild(li);
  }

  function renderList(items) {
    const rows = visiblePages(items);
    listEl.replaceChildren();
    if (listFilter === 'all') {
      const directory = directoryGroups(rows, currentGraph.topics);
      for (const item of directory.ungrouped) appendPage(listEl, item);
      for (const group of directory.groups) {
        const li = document.createElement('li');
        li.className = 'memory-topic-group';
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = `${group.name} ${group.count}`;
        details.appendChild(summary);
        const nested = document.createElement('ul');
        for (const item of group.pages) appendPage(nested, item);
        details.appendChild(nested);
        li.appendChild(details);
        listEl.appendChild(li);
      }
    } else {
      for (const item of rows) appendPage(listEl, item);
    }
    emptyEl.hidden = rows.length > 0;
    const count = document.getElementById('filter-all-count');
    if (count) count.textContent = String((items || []).length);
  }

  function renderRecent(items) {
    const list = document.getElementById('recent-list');
    const empty = document.getElementById('recent-empty');
    if (!list || !empty) return;
    const rows = [...(items || [])].sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
    list.replaceChildren();
    for (const item of rows) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const updated = item.updated ? new Date(Number(item.updated) * 1000) : null;
      const when = updated && !Number.isNaN(updated.getTime()) ? updated.toISOString().slice(0, 10) : '';
      button.textContent = when ? `${item.title} · ${when}` : item.title;
      button.addEventListener('click', () => openPage(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = rows.length > 0;
  }

  function renderTopicFilters() {
    const box = document.getElementById('topic-filter-chips');
    if (!box) return;
    box.replaceChildren();
    for (const topic of currentGraph.topics || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${topic.name} · ${topic.page_count}`;
      button.setAttribute('aria-pressed', topic.name === topicFilter ? 'true' : 'false');
      button.addEventListener('click', () => {
        topicFilter = topicFilter === topic.name ? '' : topic.name;
        renderTopicFilters();
        renderList(pageChoices);
      });
      box.appendChild(button);
    }
  }

  function syncPageUrl() {
    const view = document.defaultView;
    if (!view || !view.history || !view.history.replaceState) return;
    const path = (view.location && view.location.pathname) || '/memory';
    view.history.replaceState({}, '', path + queryForMemoryPage(currentView));
  }

  function showView(name, {sync = true} = {}) {
    currentView = name || 'overview';
    const workspace = document.getElementById('list-panel');
    if (workspace) workspace.dataset.view = currentView;
    const title = document.getElementById('view-title');
    const labels = {overview: '总览', profile: '我的资料', actions: '下一步行动', meetings: '我的会议'};
    if (title) title.textContent = labels[currentView] || '总览';
    const overview = document.getElementById('overview-panel');
    const side = document.getElementById('memory-side');
    const actions = document.getElementById('actions-panel');
    const profile = document.getElementById('profile-panel');
    const meetings = document.getElementById('meetings-panel');
    if (overview) overview.hidden = currentView !== 'overview';
    if (side) side.hidden = currentView !== 'overview';
    if (actions) actions.hidden = currentView !== 'actions';
    if (profile) profile.hidden = currentView !== 'profile';
    if (meetings) meetings.hidden = currentView !== 'meetings';
    for (const button of document.querySelectorAll('.memory-views [data-view]')) {
      if (button.getAttribute('data-view') === currentView) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (sync) syncPageUrl();
  }

  function unusedTitle(base) {
    const taken = new Set((pageChoices || []).map((item) => String(item.title || '').toLocaleLowerCase()));
    if (!taken.has(base.toLocaleLowerCase())) return base;
    for (let index = 2; index < 100; index += 1) {
      const title = `${base} ${index}`;
      if (!taken.has(title.toLocaleLowerCase())) return title;
    }
    return `${base} ${Date.now()}`;
  }

  function fillPageSelect(select, selected) {
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不关联';
    select.appendChild(empty);
    for (const page of pageChoices) {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title;
      select.appendChild(option);
    }
    select.value = selected || '';
  }

  function renderActions(items) {
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const due = dueDateValue(item.due_at);
      const linked = item.memory_page_title ? ` · ${item.memory_page_title}` : '';
      button.textContent = `${item.status === 'done' ? '已完成' : '未完成'} · ${item.title}${due ? ` · ${due}` : ''}${linked}`;
      button.dataset.id = item.id;
      button.addEventListener('click', () => openAction(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = items.length > 0;
    syncActionComposer(items.length > 0);
  }

  function syncActionComposer(hasItems) {
    const form = document.getElementById('new-action-form');
    const opener = document.getElementById('new-action-open');
    const filter = document.getElementById('action-filter-label');
    if (!form) return;
    const keep = form.dataset.open === 'true';
    form.hidden = !(hasItems || keep);
    if (opener) opener.hidden = hasItems || keep;
    if (filter) filter.hidden = !(hasItems || keep);
  }

  async function loadActions() {
    const id = workspaceId();
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    if (!id) {
      renderActions([]);
      return;
    }
    const status = document.getElementById('action-filter').value;
    const listed = await request('GET', `/v1/workspaces/${id}/memory/actions${actionQuery('', status)}`);
    if (listed.status !== 200) {
      if (list) list.replaceChildren();
      if (empty) empty.hidden = true;
      show('error', messageFor(listed.body.error, '无法加载下一步行动。'));
      return;
    }
    renderActions(listed.body.items || []);
  }


  function svgNode(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function truncateLabel(title) {
    const text = String(title || '');
    return text.length > 18 ? `${text.slice(0, 17)}…` : text;
  }

  function renderGraph(graph) {
    const canvas = document.getElementById('graph-canvas');
    const counts = document.getElementById('graph-counts');
    const topicList = document.getElementById('topic-list');
    const topicEmpty = document.getElementById('topic-empty');
    const payload = graph || {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
    const stats = payload.counts || {nodes: 0, edges: 0, topics: 0};
    if (counts) counts.textContent = `${stats.nodes} 节点 · ${stats.edges} 连接 · ${stats.topics} 话题`;
    if (canvas) {
      canvas.replaceChildren();
      const world = svgNode('g', {id: 'graph-world', transform: `translate(320 200) scale(${graphZoom}) translate(-320 -200)`});
      const placed = graphLayout(payload.nodes);
      const byId = new Map(placed.map((node) => [node.id, node]));
      const needle = topicQuery.trim().toLocaleLowerCase();
      const matches = (node) => {
        if (!needle) return true;
        if (String(node.title || '').toLocaleLowerCase().includes(needle)) return true;
        return (payload.topics || []).some((topic) => String(topic.name || '').toLocaleLowerCase().includes(needle)
          && (topic.pages || []).some((page) => page.id === node.id));
      };
      for (const edge of payload.edges || []) {
        const from = byId.get(edge.source);
        const to = byId.get(edge.target);
        if (!from || !to) continue;
        world.appendChild(svgNode('line', {
          class: 'graph-edge', x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        }));
      }
      for (const node of payload.nodes || []) {
        const point = byId.get(node.id);
        if (!point) continue;
        const group = svgNode('g', {'data-id': node.id, class: matches(node) ? 'graph-item' : 'graph-item is-muted'});
        const button = svgNode('circle', {class: 'graph-node', cx: point.x, cy: point.y, r: 8});
        const label = svgNode('text', {
          class: 'graph-label', x: point.x, y: point.y + 22, 'text-anchor': 'middle',
        });
        label.textContent = truncateLabel(node.title);
        group.appendChild(button);
        group.appendChild(label);
        group.addEventListener('click', () => openPage(node.id));
        world.appendChild(group);
      }
      canvas.appendChild(world);
    }
    if (topicList) {
      topicList.replaceChildren();
      for (const topic of payload.topics || []) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const pages = (topic.pages || []).map((page) => page.title).filter(Boolean);
        button.textContent = pages.length
          ? `${topic.name} · ${topic.page_count} · ${pages.slice(0, 3).join('，')}`
          : `${topic.name} · ${topic.page_count}`;
        button.addEventListener('click', () => {
          const first = topic.pages && topic.pages[0];
          if (first) openPage(first.id);
        });
        item.appendChild(button);
        topicList.appendChild(item);
      }
    }
    if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(payload.topics && payload.topics.length);
    renderTopicFilters();
  }

  let currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};

  async function loadGraph() {
    const id = workspaceId();
    if (!id) {
      currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
      renderGraph(currentGraph);
      return;
    }
    const seen = await request('GET', `/v1/workspaces/${id}/memory/graph`);
    if (seen.status !== 200) {
      currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
      renderGraph(currentGraph);
      show('error', messageFor(seen.body.error, '无法加载记忆图谱。'));
      return;
    }
    currentGraph = seen.body;
    renderGraph(currentGraph);
  }

  function renderPageLinks() {
    const box = document.getElementById('page-links');
    const select = document.getElementById('link-target');
    if (!box || !currentPage) return;
    box.replaceChildren();
    const edges = (currentGraph.edges || []).filter((edge) => edge.source === currentPage.id || edge.target === currentPage.id);
    for (const edge of edges) {
      const otherId = edge.source === currentPage.id ? edge.target : edge.source;
      const other = (currentGraph.nodes || []).find((node) => node.id === otherId);
      const row = document.createElement('p');
      row.className = 'note';
      const label = document.createElement('span');
      label.textContent = `${edge.kind === 'manual' ? '手动连接' : '正文提及'} · ${other ? other.title : otherId}`;
      row.appendChild(label);
      if (edge.kind === 'manual' && edge.id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '删除连接';
        button.addEventListener('click', () => removeLink(edge.id));
        row.appendChild(button);
      }
      box.appendChild(row);
    }
    if (select) {
      const used = new Set(edges.map((edge) => (edge.source === currentPage.id ? edge.target : edge.source)));
      used.add(currentPage.id);
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '选择记忆页';
      select.appendChild(empty);
      for (const page of currentGraph.nodes || pageChoices) {
        if (used.has(page.id)) continue;
        const option = document.createElement('option');
        option.value = page.id;
        option.textContent = page.title;
        select.appendChild(option);
      }
    }
  }

  async function removeLink(linkId) {
    const id = workspaceId();
    if (!id || !linkId) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/links/${linkId}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除连接。'));
      return;
    }
    show('ok', '已删除连接。');
    await loadGraph();
    renderPageLinks();
  }

  async function loadSession() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200 || !session.body.user) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      editor.hidden = true;
      if (actionEditor) actionEditor.hidden = true;
      await renderProviders();
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录：' + currentUser.username;
    const prefs = await request('GET', '/v1/settings');
    if (prefs.status === 200) applyTheme(prefs.body.settings);
    const listed = await request('GET', '/v1/workspaces');
    workspaces = listed.status === 200 && listed.body.items ? listed.body.items : [];
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.appendChild(option);
    }
    if (!workspaceSelect.value && workspaces[0]) workspaceSelect.value = workspaces[0].id;
    await loadWorkspace();
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

  async function loadWorkspace() {
    const id = workspaceId();
    currentPage = null;
    currentAction = null;
    editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    listPanel.hidden = false;
    if (!id) {
      pageChoices = [];
      renderList([]);
      renderRecent([]);
      fillPageSelect(document.getElementById('new-action-page'), '');
      renderActions([]);
      renderGraph({nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
      showView(currentView);
      return;
    }
    const needle = document.getElementById('search').value.trim();
    const listed = await request('GET', `/v1/workspaces/${id}/memory${listQuery(needle)}`);
    if (listed.status !== 200) {
      pageChoices = [];
      renderList([]);
      renderActions([]);
      renderGraph({nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
      show('error', messageFor(listed.body.error, '无法加载记忆页。'));
      return;
    }
    pageChoices = listed.body.items || [];
    renderList(pageChoices);
    renderRecent(pageChoices);
    fillPageSelect(document.getElementById('new-action-page'), '');
    await loadActions();
    await loadGraph();
    renderList(pageChoices);
    renderRecent(pageChoices);
    showView(currentView);
  }

  async function openPage(pageId) {
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/${pageId}`);
    if (seen.status !== 200 || !seen.body.page) {
      show('error', messageFor(seen.body.error, '无法打开记忆页。'));
      return;
    }
    currentPage = seen.body.page;
    currentAction = null;
    listPanel.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    editor.hidden = false;
    editor.elements.title.value = currentPage.title;
    editor.elements.body.value = currentPage.body || '';
    editor.elements.topics.value = formatTopics(currentPage.topics);
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
    renderPageLinks();
  }

  async function openAction(actionId) {
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/actions/${actionId}`);
    if (seen.status !== 200 || !seen.body.action) {
      show('error', messageFor(seen.body.error, '无法打开下一步行动。'));
      return;
    }
    currentAction = seen.body.action;
    currentPage = null;
    listPanel.hidden = true;
    editor.hidden = true;
    actionEditor.hidden = false;
    actionEditor.elements.title.value = currentAction.title;
    actionEditor.elements.notes.value = currentAction.notes || '';
    actionEditor.elements.status.value = currentAction.status;
    actionEditor.elements.due.value = dueDateValue(currentAction.due_at);
    fillPageSelect(actionEditor.elements.memory_page_id, currentAction.memory_page_id || '');
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
  }

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    show('ok', '已登录。');
    await loadSession();
  });

  document.getElementById('logout-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法退出登录。'));
      return;
    }
    currentUser = null;
    currentPage = null;
    currentAction = null;
    show('ok', '已退出登录。');
    await loadSession();
  });

  workspaceSelect.addEventListener('change', () => loadWorkspace());
  document.getElementById('search').addEventListener('input', () => loadWorkspace());
  document.getElementById('action-filter').addEventListener('change', () => loadActions());

  for (const button of document.querySelectorAll('.memory-views [data-view]')) {
    button.addEventListener('click', (event) => {
      if (button.tagName === 'A') event.preventDefault();
      showView(button.getAttribute('data-view'));
    });
  }
  const memoryWindow = document.defaultView;
  if (memoryWindow && memoryWindow.addEventListener) {
    memoryWindow.addEventListener('popstate', () => {
      showView(memoryPageFromSearch(memoryWindow.location.search), {sync: false});
    });
  }
  for (const button of document.querySelectorAll('.memory-filters [data-filter]')) {
    button.addEventListener('click', () => {
      listFilter = button.getAttribute('data-filter') || 'all';
      const box = document.getElementById('topic-filter-box');
      if (box) box.hidden = listFilter !== 'topics';
      for (const item of document.querySelectorAll('.memory-filters [data-filter]')) {
        item.setAttribute('aria-pressed', item.getAttribute('data-filter') === listFilter ? 'true' : 'false');
      }
      renderList(pageChoices);
    });
  }
  for (const button of document.querySelectorAll('.side-tabs [data-side]')) {
    button.addEventListener('click', () => {
      sideTab = button.getAttribute('data-side') || 'topics';
      for (const item of document.querySelectorAll('.side-tabs [data-side]')) {
        item.setAttribute('aria-selected', item.getAttribute('data-side') === sideTab ? 'true' : 'false');
      }
      const topics = document.getElementById('topic-list');
      const topicEmpty = document.getElementById('topic-empty');
      const recent = document.getElementById('recent-list');
      const recentEmpty = document.getElementById('recent-empty');
      if (topics) topics.hidden = sideTab !== 'topics';
      if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(currentGraph.topics && currentGraph.topics.length);
      if (recent) recent.hidden = sideTab !== 'recent';
      if (recentEmpty) recentEmpty.hidden = sideTab !== 'recent' || pageChoices.length > 0;
    });
  }
  const dirToggle = document.getElementById('toggle-dir');
  if (dirToggle) {
    dirToggle.addEventListener('click', () => {
      const workspace = document.getElementById('list-panel');
      if (!workspace) return;
      const collapsed = workspace.classList.toggle('dir-collapsed');
      dirToggle.textContent = collapsed ? '展开目录' : '收起目录';
    });
  }
  const topicSearch = document.getElementById('topic-search');
  if (topicSearch) {
    topicSearch.addEventListener('input', () => {
      topicQuery = topicSearch.value;
      renderGraph(currentGraph);
    });
  }
  const zoomIn = document.getElementById('graph-zoom-in');
  const zoomOut = document.getElementById('graph-zoom-out');
  const zoomReset = document.getElementById('graph-zoom-reset');
  if (zoomIn) zoomIn.addEventListener('click', () => { graphZoom = Math.min(2.4, graphZoom + 0.2); renderGraph(currentGraph); });
  if (zoomOut) zoomOut.addEventListener('click', () => { graphZoom = Math.max(0.6, graphZoom - 0.2); renderGraph(currentGraph); });
  if (zoomReset) zoomReset.addEventListener('click', () => { graphZoom = 1; renderGraph(currentGraph); });

  const initialSearch = document.defaultView && document.defaultView.location
    ? document.defaultView.location.search
    : '';
  showView(memoryPageFromSearch(initialSearch), {sync: false});

  document.getElementById('new-page').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id) return;
    const title = unusedTitle('未命名页面');
    const created = await fetcher(`/v1/workspaces/${id}/memory`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({title, body: ''}),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建记忆页。'));
      return;
    }
    show('ok', '已创建记忆页。');
    await openPage(parsed.page.id);
  });

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentPage) return;
    const saved = await request('POST', `/v1/workspaces/${id}/memory/${currentPage.id}`, {
      revision: currentPage.revision,
      changes: {
        title: editor.elements.title.value,
        body: editor.elements.body.value,
        topics: parseTopics(editor.elements.topics.value),
      },
    });
    if (saved.status !== 200 || !saved.body.page) {
      show('error', messageFor(saved.body.error, '无法保存记忆页。'));
      return;
    }
    currentPage = saved.body.page;
    editor.elements.topics.value = formatTopics(currentPage.topics);
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
    await loadGraph();
    renderPageLinks();
    show('ok', '已保存。');
  });

  document.getElementById('delete-page').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id || !currentPage) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/${currentPage.id}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除记忆页。'));
      return;
    }
    show('ok', '已删除。');
    await loadWorkspace();
  });

  const addLink = document.getElementById('add-link');
  if (addLink) {
    addLink.addEventListener('click', async () => {
      const id = workspaceId();
      const target = document.getElementById('link-target');
      if (!id || !currentPage || !target || !target.value) return;
      const created = await fetcher(`/v1/workspaces/${id}/memory/links`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfCookie(document.cookie),
          'Idempotency-Key': randomKey(),
        },
        credentials: 'same-origin',
        body: JSON.stringify({source: currentPage.id, target: target.value}),
      });
      let parsed = {};
      try { parsed = await created.json(); } catch { parsed = {}; }
      if (created.status !== 201 && created.status !== 200) {
        show('error', messageFor(parsed.error, '无法添加连接。'));
        return;
      }
      show('ok', '已添加连接。');
      await loadGraph();
      renderPageLinks();
    });
  }

  document.getElementById('close-editor').addEventListener('click', () => loadWorkspace());

  const newActionOpen = document.getElementById('new-action-open');
  if (newActionOpen) {
    newActionOpen.addEventListener('click', () => {
      const form = document.getElementById('new-action-form');
      if (form) form.dataset.open = 'true';
      syncActionComposer(false);
    });
  }
  document.getElementById('new-action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) return;
    const title = document.getElementById('new-action-title').value.trim();
    const notes = document.getElementById('new-action-notes').value;
    const dueAt = dueAtFromDate(document.getElementById('new-action-due').value);
    const pageId = document.getElementById('new-action-page').value || null;
    const payload = {title, notes};
    if (dueAt != null) payload.due_at = dueAt;
    if (pageId) payload.memory_page_id = pageId;
    const created = await fetcher(`/v1/workspaces/${id}/memory/actions`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建下一步行动。'));
      return;
    }
    document.getElementById('new-action-title').value = '';
    document.getElementById('new-action-notes').value = '';
    document.getElementById('new-action-due').value = '';
    document.getElementById('new-action-page').value = '';
    show('ok', '已创建下一步行动。');
    await openAction(parsed.action.id);
  });

  actionEditor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentAction) return;
    const saved = await request('POST', `/v1/workspaces/${id}/memory/actions/${currentAction.id}`, {
      revision: currentAction.revision,
      changes: {
        title: actionEditor.elements.title.value,
        notes: actionEditor.elements.notes.value,
        status: actionEditor.elements.status.value,
        due_at: dueAtFromDate(actionEditor.elements.due.value),
        memory_page_id: actionEditor.elements.memory_page_id.value || null,
      },
    });
    if (saved.status !== 200 || !saved.body.action) {
      show('error', messageFor(saved.body.error, '无法保存下一步行动。'));
      return;
    }
    currentAction = saved.body.action;
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
    show('ok', '已保存。');
  });

  document.getElementById('delete-action').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id || !currentAction) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/actions/${currentAction.id}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除下一步行动。'));
      return;
    }
    show('ok', '已删除。');
    await loadWorkspace();
  });

  document.getElementById('close-action-editor').addEventListener('click', () => loadWorkspace());

  loadSession();
}

if (typeof document !== 'undefined' && document.getElementById('login-form')) {
  mount(document);
}
