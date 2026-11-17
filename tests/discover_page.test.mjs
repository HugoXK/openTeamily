import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validSlug, catalogItems, agentDiscoverPairs, isAgentsCatalog, FEED_CATEGORIES, CATALOG_CATEGORIES, FEED_ACTIVITY_NOTE, FEED_FOLLOWING_EMPTY_TITLE, FEED_FOLLOWING_EMPTY_BODY, FEED_FOLLOWING_NOTE, FEED_SEARCH_NOTE } from '../openteamily/static/discover/app.mjs';

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
  assert.equal(isAgentsCatalog(undefined), false);
});

test('recorded feed categories stay in the captured order', () => {
  assert.deepEqual(FEED_CATEGORIES, [
    '热门', '网页', '小游戏', '图片', '音乐', '幻灯片', '视频', '3D 作品',
    '短剧', '文章', '教程', '看板', '行情', '小程序', '故事', '娱乐', 'AI 与科技', '美容',
  ]);
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
  const block = html.split('class="catalog-filters"')[1].split('id="catalog-panel"')[0];
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
  const creator = block.match(/id="catalog-creator"[\s\S]*?<\/button>/)[0];
  assert.match(creator, /disabled/);
  assert.match(creator, /创建者/);
  assert.equal(/teamily|积分|credits/i.test(creator), false);
  assert.match(block, /id="catalog-filter-note" class="visually-hidden"/);
  assert.match(block, /分类和创建者筛选未接通：公共目录没有对应字段。/);
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
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  el('feed-tab-following').handlers.click();
  assert.equal(el('feed-note').textContent, FEED_FOLLOWING_NOTE);
  assert.equal(el('feed-following-empty').hidden, false);
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
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_NOTE);
});
