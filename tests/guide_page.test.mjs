import assert from 'node:assert/strict';
import test from 'node:test';
import * as guideModule from '../openteamily/static/guide/app.mjs';
import {CATALOG, CATEGORIES, countByCategory, filterCatalog, formatPath, groupCatalog, guideHref, guideInitialQuery} from '../openteamily/static/guide/app.mjs';

test('catalog only contains known categories and no Teamily guide prose', () => {
  const ids = new Set(CATEGORIES.map((item) => item.id));
  assert.ok(ids.has('calls'));
  assert.equal(CATALOG.some((item) => item.title.includes('折叠会话列表') || (item.body || '').includes('再次点击')), false);
  for (const item of CATALOG) {
    assert.ok(ids.has(item.category), item.category);
    assert.ok(item.title);
    assert.ok(item.body);
    assert.ok(Array.isArray(item.path) && item.path.length > 0);
  }
});

test('countByCategory totals every item and keeps an empty calls category', () => {
  const counts = countByCategory(CATALOG);
  assert.equal(counts.all, CATALOG.length);
  assert.equal(counts.calls, 0);
  assert.ok(counts.chat >= 1);
  const named = CATEGORIES.filter((item) => item.id !== 'all').reduce((sum, item) => sum + (counts[item.id] || 0), 0);
  assert.equal(named, counts.all);
});

test('filterCatalog matches title, body, path and category', () => {
  assert.deepEqual(filterCatalog(CATALOG, {category: 'calls'}).map((item) => item.id), []);
  const chat = filterCatalog(CATALOG, {category: 'chat'});
  assert.ok(chat.every((item) => item.category === 'chat'));
  const found = filterCatalog(CATALOG, {query: 'flybot.pyz'});
  assert.deepEqual(found.map((item) => item.id), ['download-runtime']);
  const pathHit = filterCatalog(CATALOG, {query: '收起侧边栏'});
  assert.ok(pathHit.some((item) => item.id === 'memory-dir-collapse'));
  assert.ok(filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'}).length === 0);
});

test('groupCatalog preserves category order and formatPath joins crumbs', () => {
  const grouped = groupCatalog(filterCatalog(CATALOG, {category: 'all'}));
  assert.equal(grouped[0].id, CATALOG[0].category);
  assert.ok(grouped.every((group) => group.items.length > 0));
  assert.equal(formatPath(['设置', '外观']), '设置 › 外观');
  assert.equal(formatPath([]), '');
});

test('the guide deep link round-trips the keyword through the query string', () => {
  assert.equal(guideHref('外观'), '/guide?q=%E5%A4%96%E8%A7%82');
  assert.equal(guideHref('  '), '/guide');
  assert.equal(guideHref(''), '/guide');
  assert.equal(guideInitialQuery('?q=%E5%A4%96%E8%A7%82'), '外观');
  assert.equal(guideInitialQuery('?x=1'), '');
  assert.equal(guideInitialQuery(''), '');
  assert.deepEqual(filterCatalog(CATALOG, {category: 'settings', query: '外观'}).map((item) => item.id), ['settings-hub', 'settings-appearance']);
  assert.deepEqual(filterCatalog(CATALOG, {query: '日出日落'}).map((item) => item.id), ['settings-appearance']);
});

test('the empty state names an empty category instead of blaming a search', () => {
  const {emptyGuideMessage} = guideModule;
  assert.equal(typeof emptyGuideMessage, 'function', 'the guide page cannot tell an empty category from a fruitless search');
  const emptyCategory = filterCatalog(CATALOG, {category: 'calls'});
  assert.deepEqual(emptyCategory, []);
  assert.equal(emptyGuideMessage(emptyCategory, ''), '这一类还没有指引。');
  assert.equal(emptyGuideMessage(emptyCategory, '   '), '这一类还没有指引。');
  const noHits = filterCatalog(CATALOG, {category: 'memory', query: 'xyz-not-a-feature'});
  assert.deepEqual(noHits, []);
  assert.equal(emptyGuideMessage(noHits, 'xyz-not-a-feature'), '没有匹配的指引。');
  assert.equal(emptyGuideMessage(filterCatalog(CATALOG, {category: 'chat'}), ''), '');
});
