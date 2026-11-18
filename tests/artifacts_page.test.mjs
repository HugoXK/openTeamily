import assert from 'node:assert/strict';
import test from 'node:test';
import {
  csrfCookie, listQuery, visibleArtifacts, artifactMatchesType,
  artifactMatchesModified, viewFromSearch, queryForView, FILE_TYPE_LABELS,
  sessionFilterChoices, applyDirectoryCollapsed,
} from '../openteamily/static/artifacts/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
});

test('visibleArtifacts filters by kind, saved messages and creator', () => {
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice'},
    {title: 'Site', kind: 'website', created_by: 'bob'},
    {title: 'Clip', kind: 'document', created_by: 'alice', source: {kind: 'agent_message', id: 'm1'}},
  ];
  assert.deepEqual(visibleArtifacts(items, {kind: 'website'}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'messages'}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'meetings'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'mine', username: 'alice'}).map((item) => item.title), ['Doc', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'favorites'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), []);
});

test('visibleArtifacts maps recorded filters onto existing fields', () => {
  const now = Date.parse('2026-11-17T02:30:00Z');
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice', updated: now / 1000 - 60},
    {title: 'Site', kind: 'website', created_by: 'bob', updated: now / 1000 - 60},
    {title: 'Photo', kind: 'media', created_by: 'alice', updated: now / 1000 - 60, media: {mime: 'image/png'}},
    {title: 'Old', kind: 'document', created_by: 'alice', updated: now / 1000 - 40 * 24 * 60 * 60},
    {title: 'Task', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_task', conversation_id: 'c1'}},
    {title: 'Clip', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_message', conversation_id: 'c2'}},
  ];
  assert.equal(FILE_TYPE_LABELS.length, 13);
  assert.equal(artifactMatchesType(items[0], '云文档'), true);
  assert.equal(artifactMatchesType(items[5], '云文档'), false);
  assert.equal(artifactMatchesType(items[2], '图片'), true);
  assert.equal(artifactMatchesType(items[0], 'Markdown'), false);
  assert.equal(artifactMatchesType({kind: 'slides'}, '幻灯片'), true);
  assert.equal(artifactMatchesType({kind: 'document'}, '幻灯片'), false);
  assert.deepEqual(visibleArtifacts(items, {types: ['网页']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {types: ['消息']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {types: ['Markdown']}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {modified: 'today', now}).map((item) => item.title),
                   ['Doc', 'Site', 'Photo', 'Task', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {modified: 'custom', now}).map((item) => item.title),
                   items.map((item) => item.title));
  assert.deepEqual(visibleArtifacts(items, {creators: ['bob']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {sessions: ['c2']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), ['Task']);
  assert.equal(artifactMatchesModified(items[3], 'd30', now), false);
  assert.equal(artifactMatchesModified(items[3], 'd90', now), true);
});

test('sessionFilterChoices uses conversation titles instead of raw ids', () => {
  const choices = sessionFilterChoices([
    {title: 'Clip', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Again', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Other', source: {kind: 'agent_message', conversation_id: 'c1'}},
    {title: 'Plain', kind: 'document'},
  ]);
  assert.deepEqual(choices, [
    {id: 'c1', label: '对话'},
    {id: 'c2', label: '晨会'},
  ]);
  assert.equal(choices.some((row) => row.label === 'c1' || row.label === 'c2'), false);
});

test('viewFromSearch and queryForView stay on the recorded allowlist', () => {
  assert.deepEqual(viewFromSearch(''), {kind: 'all', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=created'), {kind: 'all', scope: 'mine'});
  assert.deepEqual(viewFromSearch('?view=starred'), {kind: 'all', scope: 'favorites'});
  assert.deepEqual(viewFromSearch('?view=memory'), {kind: 'all', scope: 'memory'});
  assert.deepEqual(viewFromSearch('?view=meetings'), {kind: 'meetings', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=unknown'), {kind: 'all', scope: 'all'});
  assert.equal(queryForView('all', 'all'), '');
  assert.equal(queryForView('all', 'mine'), '?view=created');
  assert.equal(queryForView('all', 'favorites'), '?view=starred');
  assert.equal(queryForView('all', 'memory'), '?view=memory');
  assert.equal(queryForView('meetings', 'all'), '?view=meetings');
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
  el('artifact-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['artifact-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['artifact-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});
