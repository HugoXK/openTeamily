import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validSlug, catalogItems, agentDiscoverPairs, isAgentsCatalog, isTeamsCatalog, renderTeamCard, FEED_CATEGORIES, CATALOG_CATEGORIES, TEAM_CATEGORIES, FEED_ACTIVITY_NOTE, FEED_FOLLOWING_EMPTY_TITLE, FEED_FOLLOWING_EMPTY_BODY, FEED_FOLLOWING_NOTE, FEED_SEARCH_NOTE, TEAMS_NOTE, TEAMS_SEARCH_NOTE, TEAMS_SEARCH_PLACEHOLDER } from '../openteamily/static/discover/app.mjs';

test('validSlug mirrors the server slug rule', () => {
  assert.equal(validSlug('on-call'), true);
  assert.equal(validSlug('abc'), true);
  assert.equal(validSlug('a'), false);
  assert.equal(validSlug('On-call'), false);
  assert.equal(validSlug('-abc'), false);
  assert.equal(validSlug('abc-'), false);
  assert.equal(validSlug('a'.repeat(31)), false);
  assert.equal(validSlug(null), false);
});

test('isAgentsCatalog only matches the recorded tab=agents query', () => {
  assert.equal(isAgentsCatalog({search: ''}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents'}), true);
  assert.equal(isAgentsCatalog({search: '?tab=teams'}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents&section=groups'}), false);
  assert.equal(isAgentsCatalog(undefined), false);
});

test('isTeamsCatalog only matches the recorded tab=agents&section=groups query', () => {
  assert.equal(isTeamsCatalog({search: ''}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents'}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents&section=groups'}), true);
  assert.equal(isTeamsCatalog({search: '?section=groups'}), false);
  assert.equal(isTeamsCatalog(undefined), false);
});

test('recorded feed categories stay in the captured order', () => {
  assert.deepEqual(FEED_CATEGORIES, [
    '热门', '网页', '小游戏', '图片', '音乐', '幻灯片', '视频', '3D 作品',
    '短剧', '文章', '教程', '看板', '行情', '小程序', '故事', '娱乐', 'AI 与科技', '美容',
  ]);
});

test('feed all-filter shows the recorded 全部 label and keeps an empty canvas', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('class="feed-filters"')[1].split('id="feed-following-empty"')[0];
  assert.match(block, /class="feed-filter-all"[^>]*aria-current="true"[^>]*>全部</);
  assert.equal(/class="feed-filter-all"[^>]*><\/button>/.test(block), false);
  assert.equal(/aria-label="全部"/.test(block), false);
  assert.equal(/没有单独标出文字|圆形按钮/.test(block), false);
  const order = ['全部', ...FEED_CATEGORIES];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(html, /id="feed-activity-empty"/);
  assert.match(html, /id="feed-grid"[^>]*data-empty="true"/);
  const activity = html.split('id="feed-activity-empty"')[1].split('id="feed-note"')[0];
  assert.equal(/\bhidden\b/.test(activity.split('>')[0]), false);
  assert.equal(activity.includes('id="feed-note"'), false);
  assert.equal(/最多领取|CREDITS|积分中心/.test(html.split('id="feed-panel"')[1].split('id="catalog-view"')[0]), false);
});

test('recorded catalog categories stay in the captured order', () => {
  assert.deepEqual(CATALOG_CATEGORIES, [
    'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
    'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
    'Legal', 'Life', 'Marketing',
  ]);
});

test('catalog filter chrome is present, disabled, and does not copy Teamily branding', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('id="catalog-filters"')[1].split('id="teams-filters"')[0];
  assert.match(block, /aria-current="true"[^>]*>全部</);
  for (const label of CATALOG_CATEGORIES) {
    const encoded = label.replaceAll('&', '&amp;');
    assert.match(block, new RegExp(`disabled title="未接通：公共目录没有分类字段。">${encoded}<`));
  }
  const order = ['全部', ...CATALOG_CATEGORIES.map((label) => label.replaceAll('&', '&amp;'))];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(block, /id="catalog-filter-search"[^>]*disabled[^>]*aria-label="搜索分类"/);
  assert.match(block, /id="catalog-filter-more"[^>]*disabled[^>]*aria-label="更多分类"/);
  assert.match(block, /对照里可以看到搜索分类控件，但没有打开面板，所以这里不发明搜索弹层。/);
  assert.match(block, /对照里未展开其余分类，所以这里不发明更多分类。/);
  const creator = html.match(/id="catalog-creator"[\s\S]*?<\/button>/)[0];
  assert.match(creator, /disabled/);
  assert.match(creator, /创建者/);
  assert.equal(/teamily|积分|credits/i.test(creator), false);
  assert.match(html, /id="catalog-filter-note" class="visually-hidden"/);
  assert.match(html, /分类和创建者筛选未接通：公共目录没有对应字段。/);
});


test('recorded team categories stay in the captured order', () => {
  assert.deepEqual(TEAM_CATEGORIES, [
    'Marketing', 'Engineering', 'IT & Security', 'Content Creation',
    'Operations', 'Product', 'Data Analysis', 'Design', 'Research',
    'Investment', 'Education', 'Life', 'Sales',
  ]);
});

test('teams filter chrome is present, disabled, and does not copy Teamily branding', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="catalog-tab-teams" href="\/discover\?tab=agents&amp;section=groups">AI 团队</);
  assert.match(html, /id="catalog-create-team"[^>]*disabled[^>]*>\+ 创建我的 AI 团队</);
  assert.equal(/AI 团队（未接通）/.test(html), false);
  const block = html.split('id="teams-filters"')[1].split('id="catalog-creator"')[0];
  assert.match(block, /aria-current="true"[^>]*>All</);
  for (const label of TEAM_CATEGORIES) {
    const encoded = label.replaceAll('&', '&amp;');
    assert.match(block, new RegExp(`disabled title="未接通：没有公共 AI 团队目录接口。">${encoded}<`));
  }
  const order = ['All', ...TEAM_CATEGORIES.map((label) => label.replaceAll('&', '&amp;'))];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(block, /id="teams-filter-more"[^>]*disabled[^>]*aria-label="更多分类"/);
  assert.equal(/id="teams-filter-search"/.test(block), false);
  assert.equal(/Teamily AI|Full-Stack Delivery Guild|积分|credits/i.test(html), false);
  assert.match(html, /id="teams-filter-note" class="visually-hidden"/);
  assert.match(html, /也不会复制对照里的团队名称或创建者品牌/);
  assert.equal(TEAMS_SEARCH_PLACEHOLDER, '搜索 AI 团队......');
});

test('renderTeamCard lays out recorded fields and keeps create unconnected', () => {
  const doc = fakeDocument();
  const card = renderTeamCard(doc, {
    category: 'engineering',
    name: 'Fixture Delivery Room',
    summary: 'An OpenTeamily fixture card, not a copied template.',
    tags: ['fixture', 'delivery'],
    members: ['alpha', 'beta'],
    extra: '+1',
  });
  assert.equal(card.children[0].textContent, 'engineering');
  assert.equal(card.children[1].textContent, 'Fixture Delivery Room');
  assert.equal(card.children[2].textContent, 'An OpenTeamily fixture card, not a copied template.');
  assert.equal(card.children[3].children[0].textContent, 'fixture');
  assert.equal(card.children[4].children[0].children[0].textContent, 'A');
  assert.equal(card.children[4].children[1].textContent, '+1');
  const create = card.children[4].children[2];
  assert.equal(create.disabled, true);
  assert.equal(create.textContent, '创建');
  assert.match(create.title, /未接通/);
});

test('catalogItems tolerates missing bodies', () => {
  assert.deepEqual(catalogItems({items: [{slug: 'a'}]}), [{slug: 'a'}]);
  assert.deepEqual(catalogItems(null), []);
  assert.deepEqual(catalogItems({}), []);
});

test('agentDiscoverPairs aligns statuses by index and defaults to unlisted', () => {
  const agents = [{id: 'a'}, {id: 'b'}];
  const pairs = agentDiscoverPairs(agents, [{listed: true, slug: 'a'}]);
  assert.deepEqual(pairs[0].discover, {listed: true, slug: 'a'});
  assert.deepEqual(pairs[1].discover, {listed: false});
});


test('catalogQuery encodes search and cursor on the existing public allowlist', async () => {
  const {catalogQuery} = await import('../openteamily/static/discover/app.mjs');
  assert.equal(catalogQuery(), '/v1/discover/agents?limit=12');
  assert.equal(catalogQuery('  a & 中文  ', 'ci-helper-01'),
    '/v1/discover/agents?limit=12&q=a+%26+%E4%B8%AD%E6%96%87&cursor=ci-helper-01');
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
}
function fakeDocument() {
  const elements = new Map();
  return {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('anonymous catalog search/clear/paging use public GETs and never publish on browse', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    const url = new URL(path, 'https://management.test');
    const query = url.searchParams.get('q');
    const cursor = url.searchParams.get('cursor');
    return {status: 200, json: async () => query
      ? {items: []}
      : {items: [{name: 'Fixture', slug: cursor ? 'fixture-two' : 'fixture-one', summary: '<script>not HTML</script>'}],
        cursor: cursor ? null : 'fixture-one'}};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('catalog-more').hidden, false);
  const card = el('discover-list').children[0].children[0];
  assert.equal(card.children[1].children[1].textContent, '<script>not HTML</script>');
  assert.equal(card.children[2].disabled, true);
  await el('catalog-more').handlers.click();
  assert.equal(el('discover-list').children.length, 2);
  assert.equal(el('catalog-more').hidden, true);
  el('catalog-query').value = 'nothing & 中文';
  el('catalog-search').handlers.submit({preventDefault() {}});
  await flush();
  assert.equal(el('discover-list').children.length, 0);
  assert.match(el('discover-empty').textContent, /没有匹配/);
  el('catalog-clear').handlers.click();
  await flush();
  assert.equal(el('catalog-query').value, '');
  assert.equal(el('discover-list').children.length, 1);
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
  assert.equal(requests.some(([path]) => path.includes('cursor=fixture-one')), true);
  assert.equal(requests.some(([path]) => path.includes('q=nothing+%26+%E4%B8%AD%E6%96%87')), true);
});

test('catalog failure displays an error and leaves loading state', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  await mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    throw new Error('fixture unavailable');
  }});
  assert.equal(doc.getElementById('catalog-error').hidden, false);
  assert.match(doc.getElementById('catalog-error').textContent, /fixture unavailable/);
  assert.equal(doc.getElementById('catalog-panel').attributes['aria-busy'], 'false');
  assert.equal(doc.getElementById('discover-empty').hidden, true);
});

test('default discover view is the unconnected feed and does not load the catalog API', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('feed-panel').hidden, false);
  assert.equal(el('catalog-view').hidden, true);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_NOTE);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  el('feed-tab-following').handlers.click();
  assert.equal(el('feed-note').textContent, FEED_FOLLOWING_NOTE);
  assert.equal(el('feed-following-empty').hidden, false);
  assert.equal(el('feed-activity-empty').hidden, true);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(FEED_FOLLOWING_EMPTY_TITLE, '关注列表暂无动态');
  assert.equal(FEED_FOLLOWING_EMPTY_BODY, '你关注的人发布动态后会显示在这里。');
  assert.equal(FEED_FOLLOWING_NOTE.includes('没有对照截图'), false);
  assert.match(FEED_FOLLOWING_NOTE, /关注关系还没有接口/);
  el('feed-search').handlers.submit({preventDefault() {}});
  assert.equal(el('feed-search-note').hidden, false);
  assert.equal(el('feed-search-note').textContent, FEED_SEARCH_NOTE);
  el('feed-tab-activity').handlers.click();
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_NOTE);
});

test('teams catalog shows recorded chrome and does not load the agent catalog API', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-view').hidden, false);
  assert.equal(el('feed-panel').hidden, true);
  assert.equal(el('catalog-filters').hidden, true);
  assert.equal(el('teams-filters').hidden, false);
  assert.equal(el('catalog-create-agent').hidden, true);
  assert.equal(el('catalog-create-team').hidden, false);
  assert.equal(el('catalog-query').placeholder, TEAMS_SEARCH_PLACEHOLDER);
  assert.equal(el('catalog-tab-teams').attributes['aria-current'], 'page');
  assert.equal(el('catalog-tab-agents').attributes['aria-current'], undefined);
  assert.equal(el('teams-note').hidden, false);
  assert.equal(el('teams-note').textContent, TEAMS_NOTE);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('discover-list').children.length, 0);
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  el('catalog-query').value = 'anything';
  el('catalog-search').handlers.submit({preventDefault() {}});
  assert.equal(el('teams-search-note').hidden, false);
  assert.equal(el('teams-search-note').textContent, TEAMS_SEARCH_NOTE);
  el('catalog-clear').handlers.click();
  assert.equal(el('catalog-query').value, '');
  assert.equal(el('teams-search-note').hidden, true);
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
});

