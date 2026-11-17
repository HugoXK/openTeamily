import assert from 'node:assert/strict';
import test from 'node:test';
import {actionQuery, applyDirectoryCollapsed, csrfCookie, directoryGroups, dueAtFromDate, dueDateValue, formatTopics, graphLayout, listQuery, memoryPageFromSearch, memoryPageMeta, memoryPagePreview, memoryUpdatedLabel, parseTopics, queryForMemoryPage, topicTag} from '../openteamily/static/memory/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery and actionQuery encode filters and omit empty values', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('brief'), '?q=brief');
  assert.equal(actionQuery('', 'open'), '?status=open');
  assert.equal(actionQuery('跟进', 'done'), '?q=%E8%B7%9F%E8%BF%9B&status=done');
  assert.equal(actionQuery('', ''), '');
});

test('due date helpers convert UTC calendar days', () => {
  assert.equal(dueAtFromDate(''), null);
  assert.equal(dueAtFromDate('2027-01-15'), Date.UTC(2027, 0, 15) / 1000);
  assert.equal(dueDateValue(Date.UTC(2027, 0, 15) / 1000), '2027-01-15');
  assert.equal(dueDateValue(null), '');
  assert.equal(dueDateValue('bad'), '');
});

test('parseTopics splits unique names and formatTopics joins them', () => {
  assert.deepEqual(parseTopics('Getting Started, wiki，Getting started'), ['Getting Started', 'wiki']);
  assert.equal(formatTopics(['Getting Started', 'wiki']), 'Getting Started，wiki');
  assert.equal(formatTopics([]), '');
});

test('graphLayout places a single node at the center and sorts a circle by id', () => {
  assert.deepEqual(graphLayout([]), []);
  assert.deepEqual(graphLayout([{id: 'b'}], 200, 100), [{id: 'b', x: 100, y: 50}]);
  const placed = graphLayout([{id: 'm2'}, {id: 'm1'}], 200, 200, 50);
  assert.equal(placed[0].id, 'm1');
  assert.equal(placed[1].id, 'm2');
  assert.equal(placed[0].x, 100);
  assert.equal(placed[0].y, 50);
  assert.equal(placed[1].x, 100);
  assert.equal(placed[1].y, 150);
});

test('memoryPageFromSearch and queryForMemoryPage stay on the recorded allowlist', () => {
  assert.equal(memoryPageFromSearch(''), 'overview');
  assert.equal(memoryPageFromSearch('?page=profile'), 'profile');
  assert.equal(memoryPageFromSearch('?page=todos'), 'actions');
  assert.equal(memoryPageFromSearch('?page=unknown'), 'overview');
  assert.equal(queryForMemoryPage('overview'), '');
  assert.equal(queryForMemoryPage('profile'), '?page=profile');
  assert.equal(queryForMemoryPage('actions'), '?page=todos');
  assert.equal(queryForMemoryPage('meetings'), '');
});

test('memoryUpdatedLabel uses a UTC calendar date and ignores bad values', () => {
  assert.equal(memoryUpdatedLabel(''), '');
  assert.equal(memoryUpdatedLabel(null), '');
  assert.equal(memoryUpdatedLabel('bad'), '');
  assert.equal(memoryUpdatedLabel(Date.UTC(2026, 10, 17) / 1000), '2026-11-17');
});

test('topicTag and memoryPageMeta render date plus hash tags without inventing a 新 badge', () => {
  assert.equal(topicTag(''), '');
  assert.equal(topicTag('  wiki  '), '#wiki');
  assert.equal(topicTag('#already'), '#already');
  assert.equal(memoryPageMeta({}), '');
  assert.equal(
    memoryPageMeta({updated: Date.UTC(2026, 10, 17) / 1000, topics: ['CI fixture', '#keep']}),
    '2026-11-17 · #CI fixture · #keep',
  );
  assert.equal(memoryPagePreview({}), '');
  assert.equal(memoryPagePreview({preview: '  First line of the page.  '}), 'First line of the page.');
});

test('directoryGroups clusters real topics and leaves untagged pages loose', () => {
  const pages = [
    {id: 'a', title: 'Alpha notes', topics: ['Work notes']},
    {id: 'b', title: 'Beta plan', topics: ['Work notes', 'Planning']},
    {id: 'c', title: 'Loose page', topics: []},
    {id: 'd', title: 'Planner', topics: ['Planning']},
  ];
  const grouped = directoryGroups(pages, [
    {name: 'Work notes', pages: [{id: 'a'}, {id: 'b'}], page_count: 2},
    {name: 'Planning', pages: [{id: 'b'}, {id: 'd'}], page_count: 2},
    {name: 'Empty leftover', pages: [{id: 'missing'}], page_count: 1},
  ]);
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['c']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Work notes', 2, ['a', 'b']],
    ['Planning', 2, ['b', 'd']],
  ]);
  assert.equal(grouped.groups.some((group) => group.name === 'Getting Started' || group.name === 'Empty leftover'), false);
});

test('directoryGroups still groups from page topics when the catalog is empty', () => {
  const grouped = directoryGroups(
    [{id: 'n1', title: 'Solo', topics: ['Planning']}, {id: 'n2', title: 'Other'}],
    [],
  );
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['n2']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Planning', 1, ['n1']],
  ]);
});

test('applyDirectoryCollapsed hides the directory in session only', () => {
  const nodes = {};
  const el = (id, extra = {}) => {
    const node = {
      id,
      hidden: false,
      className: '',
      attributes: {},
      classList: {
        toggle(name, on) {
          const parts = new Set((node.className || '').split(/\s+/).filter(Boolean));
          if (on) parts.add(name);
          else parts.delete(name);
          node.className = [...parts].join(' ');
        },
      },
      setAttribute(key, value) {
        node.attributes[key] = value;
      },
      getAttribute(key) {
        return node.attributes[key];
      },
    };
    Object.assign(node, extra);
    nodes[id] = node;
    return node;
  };
  el('list-panel');
  el('memory-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['memory-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['memory-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});
