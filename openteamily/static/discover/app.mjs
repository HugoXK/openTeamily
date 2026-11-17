import { csrfCookie } from '../agents/app.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function validSlug(value) {
  return typeof value === 'string' && SLUG.test(value);
}

export function catalogItems(body) {
  return Array.isArray(body && body.items) ? body.items : [];
}

export function agentDiscoverPairs(agents, statuses) {
  return (agents || []).map((agent, index) => ({
    agent,
    discover: (statuses || [])[index] || {listed: false},
  }));
}

export function catalogQuery(text = '', cursor = '') {
  const params = new URLSearchParams({limit: '12'});
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  return '/v1/discover/agents?' + params.toString();
}

export const FEED_CATEGORIES = [
  '热门', '网页', '小游戏', '图片', '音乐', '幻灯片', '视频', '3D 作品',
  '短剧', '文章', '教程', '看板', '行情', '小程序', '故事', '娱乐', 'AI 与科技', '美容',
];

export const CATALOG_CATEGORIES = [
  'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
  'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
  'Legal', 'Life', 'Marketing',
];

export const FEED_ACTIVITY_NOTE = '动态信息流还没有接口，所以这里不会列出作品卡片。也不会展示奖励活动或推荐内容。';
export const FEED_FOLLOWING_EMPTY_TITLE = '关注列表暂无动态';
export const FEED_FOLLOWING_EMPTY_BODY = '你关注的人发布动态后会显示在这里。';
export const FEED_FOLLOWING_NOTE = '关注关系还没有接口，所以这里保持对照里的空态，不会列出动态，也不会展示奖励活动。';
export const FEED_SEARCH_NOTE = '搜索动态和创作者尚未接通：没有对应的公开接口。';

export function isAgentsCatalog(location) {
  const search = location && typeof location.search === 'string' ? location.search : '';
  return new URLSearchParams(search).get('tab') === 'agents';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, { fetcher = globalThis.fetch.bind(globalThis), location = globalThis.location } = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let catalog = [];
  let cursor = '';
  let activeQuery = '';
  let catalogRequest = 0;
  const agentsView = isAgentsCatalog(location);

  function showDiscoverView() {
    const feed = document.getElementById('feed-panel');
    const catalog = document.getElementById('catalog-view');
    if (feed) feed.hidden = agentsView;
    if (catalog) catalog.hidden = !agentsView;
  }

  function setFeedTab(tab) {
    const following = tab === 'following';
    const followingBtn = document.getElementById('feed-tab-following');
    const activityBtn = document.getElementById('feed-tab-activity');
    if (followingBtn) followingBtn.setAttribute('aria-selected', following ? 'true' : 'false');
    if (activityBtn) activityBtn.setAttribute('aria-selected', following ? 'false' : 'true');
    const note = document.getElementById('feed-note');
    if (note) note.textContent = following ? FEED_FOLLOWING_NOTE : FEED_ACTIVITY_NOTE;
    const empty = document.getElementById('feed-following-empty');
    if (empty) empty.hidden = !following;
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body) {
    const headers = { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { status: response.status, body: parsed };
  }

  function renderCatalog(items) {
    const list = document.getElementById('discover-list');
    list.replaceChildren();
    document.getElementById('discover-empty').hidden = items.length > 0;
    for (const item of items) {
      const li = document.createElement('li');
      const card = document.createElement('article');
      const avatar = document.createElement('span');
      avatar.className = 'catalog-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = (item.name || item.slug || '?').slice(0, 1).toUpperCase();
      const copy = document.createElement('div');
      copy.className = 'catalog-copy';
      const name = document.createElement('h3');
      name.textContent = item.name || item.slug;
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = item.summary || '没有简介。';
      const chat = document.createElement('button');
      chat.type = 'button';
      chat.disabled = true;
      chat.textContent = '聊天';
      chat.title = '未接通：公共目录没有发起聊天的接口';
      chat.setAttribute('aria-label', (item.name || item.slug) + '：聊天未接通');
      copy.append(name, summary);
      card.append(avatar, copy, chat);
      // Slugs are public identifiers, not links: no public detail route exists.
      card.title = '/d/' + item.slug;
      li.append(card);
      list.append(li);
    }
  }

  async function loadCatalog(append = false) {
    const seq = ++catalogRequest;
    if (!append) {
      activeQuery = document.getElementById('catalog-query').value.trim();
      catalog = [];
      cursor = '';
      renderCatalog([]);
      document.getElementById('discover-empty').hidden = true;
    }
    const more = document.getElementById('catalog-more');
    const count = document.getElementById('catalog-count');
    const error = document.getElementById('catalog-error');
    error.hidden = true;
    more.disabled = true;
    count.textContent = append ? '正在加载更多…' : '正在加载…';
    document.getElementById('catalog-panel').setAttribute('aria-busy', 'true');
    try {
      const listed = await request('GET', catalogQuery(activeQuery, cursor));
      if (seq !== catalogRequest) return;
      if (listed.status !== 200) throw new Error(messageFor(listed.body.error, '无法加载公共目录。'));
      const incoming = catalogItems(listed.body);
      const known = new Set(catalog.map(item => item.slug));
      catalog.push(...incoming.filter(item => !known.has(item.slug)));
      cursor = listed.body.cursor || '';
      renderCatalog(catalog);
      more.hidden = !cursor;
      document.getElementById('discover-empty').textContent = activeQuery
        ? '没有匹配的智能体。试试其他关键词。' : '还没有收录任何智能体。';
      count.textContent = '已显示 ' + catalog.length + ' 个智能体' + (cursor ? '，还有更多' : '');
    } catch (failure) {
      if (seq !== catalogRequest) return;
      error.hidden = false;
      error.textContent = failure.message || '无法加载公共目录。';
      count.textContent = '目录加载失败，请重试搜索。';
      more.hidden = !cursor;
      document.getElementById('discover-empty').hidden = true;
    } finally {
      if (seq === catalogRequest) {
        more.disabled = false;
        document.getElementById('catalog-panel').setAttribute('aria-busy', 'false');
      }
    }
  }

  function renderManage(pairs) {
    const list = document.getElementById('manage-list');
    list.replaceChildren();
    document.getElementById('manage-empty').hidden = pairs.length > 0;
    for (const {agent, discover} of pairs) {
      const li = document.createElement('li');
      li.className = 'manage-row';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = agent.name;
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = discover.listed ? '已收录：' + discover.slug : '未收录';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = 'slug';
      input.value = discover.slug || '';
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.textContent = '收录 / 更新';
      publish.addEventListener('click', async () => {
        if (!validSlug(input.value.trim())) {
          show('error', 'slug 需为 3–30 个字符的小写字母、数字或连字符。');
          return;
        }
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover`,
          {slug: input.value.trim()});
        if (result.status !== 201 && result.status !== 200) {
          show('error', messageFor(result.body.error, '无法收录。'));
          return;
        }
        show('ok', '已收录。');
        await loadCatalog();
        await loadManage();
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = '取消收录';
      revoke.disabled = !discover.listed;
      revoke.addEventListener('click', async () => {
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover/revoke`, {});
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法取消收录。'));
          return;
        }
        show('ok', '已取消收录。');
        await loadCatalog();
        await loadManage();
      });
      li.append(title, state, input, publish, revoke);
      list.append(li);
    }
  }

  async function loadManage() {
    const id = workspaceSelect.value;
    if (!id) {
      renderManage([]);
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (listed.status !== 200) {
      renderManage([]);
      return;
    }
    const agents = listed.body.items || [];
    const statuses = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/discover`)
        .then(result => (result.status === 200 ? result.body.discover : {listed: false}))));
    renderManage(agentDiscoverPairs(agents, statuses));
  }

  async function load() {
    showDiscoverView();
    if (agentsView) await loadCatalog();
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = false;
      document.getElementById('catalog-manage').hidden = true;
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('catalog-manage').hidden = !agentsView;
    document.getElementById('whoami').textContent = currentUser.username;
    if (agentsView) {
      const listed = await request('GET', '/v1/workspaces?limit=100');
      const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
      workspaceSelect.replaceChildren();
      for (const space of workspaces) {
        const option = document.createElement('option');
        option.value = space.id;
        option.textContent = space.name;
        workspaceSelect.append(option);
      }
      await loadManage();
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

  workspaceSelect.addEventListener('change', loadManage);
  document.getElementById('catalog-search').addEventListener('submit', event => {
    event.preventDefault();
    if (agentsView) return loadCatalog();
  });
  document.getElementById('catalog-clear').addEventListener('click', () => {
    document.getElementById('catalog-query').value = '';
    if (agentsView) return loadCatalog();
  });
  document.getElementById('catalog-more').addEventListener('click', () => {
    if (agentsView) return loadCatalog(true);
  });
  const feedSearch = document.getElementById('feed-search');
  if (feedSearch) {
    feedSearch.addEventListener('submit', event => {
      event.preventDefault();
      const note = document.getElementById('feed-search-note');
      if (note) {
        note.hidden = false;
        note.textContent = FEED_SEARCH_NOTE;
      }
    });
  }
  for (const tab of ['following', 'activity']) {
    const button = document.getElementById(tab === 'following' ? 'feed-tab-following' : 'feed-tab-activity');
    if (button) button.addEventListener('click', () => setFeedTab(tab));
  }
  if (!agentsView) setFeedTab('activity');

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('manage-list')) {
  mount(globalThis.document);
}
