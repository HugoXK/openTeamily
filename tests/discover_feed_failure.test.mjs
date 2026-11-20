import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mount, FEED_ACTIVITY_EMPTY_NOTE, FEED_ACTIVITY_LISTED_NOTE, FEED_FOLLOWING_NOTE,
  FEED_SEARCH_EMPTY_NOTE,
} from '../openteamily/static/discover/app.mjs';

// The exact sentence a failed read must show. It is a literal here on purpose:
// the point of this slice is that the page stops saying "nothing is published"
// when the only thing that happened is that the request did not work.
const FAILED_NOTE = '作品列表没读出来，这不代表没有作品。稍后重试。';

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

function feedFetcher(session, works) {
  return async (path, options) => {
    if (path === '/v1/auth/session') return {status: session.status, json: async () => session.body};
    if (path.startsWith('/v1/discover/me/works?') || path.startsWith('/v1/discover/works?')) {
      return works(path, options);
    }
    throw new Error('unexpected ' + path);
  };
}

test('a plain feed that fails to load does not claim nothing is published', async () => {
  const doc = fakeDocument();
  const fetcher = feedFetcher({status: 401, body: {}}, () => ({
    status: 500, json: async () => ({error: {message: '后台暂时读不到作品。'}}),
  }));
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-note').textContent, FAILED_NOTE);
  assert.notEqual(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
  assert.equal(el('feed-error').hidden, false);
  assert.match(el('feed-error').textContent, /后台暂时读不到作品/);
});

test('a failed search says the list failed instead of claiming nothing matched', async () => {
  const doc = fakeDocument();
  const fetcher = feedFetcher({status: 401, body: {}}, () => ({status: 0, json: async () => ({})}));
  await mount(doc, {fetcher, location: {search: '?q=nothing-matches'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-note').textContent, FAILED_NOTE);
  assert.notEqual(el('feed-note').textContent, FEED_SEARCH_EMPTY_NOTE);
  assert.equal(el('feed-error').hidden, false);
});

test('a failed category load keeps the failure sentence, not the no-match one', async () => {
  const doc = fakeDocument();
  const fetcher = feedFetcher({status: 401, body: {}}, () => ({
    status: 503, json: async () => ({error: {message: '分类暂时不可用。'}}),
  }));
  await mount(doc, {fetcher, location: {search: '?kind=image'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-note').textContent, FAILED_NOTE);
  assert.notEqual(el('feed-note').textContent, FEED_SEARCH_EMPTY_NOTE);
});

test('a signed-in following feed that fails does not show the empty following block', async () => {
  const doc = fakeDocument();
  const fetcher = feedFetcher(
    {status: 200, body: {user: {username: 'alice'}}},
    () => ({status: 500, json: async () => ({error: {message: '读不到关注的动态。'}})}),
  );
  await mount(doc, {fetcher, location: {search: '?feed=following'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-note').textContent, FAILED_NOTE);
  assert.notEqual(el('feed-note').textContent, FEED_FOLLOWING_NOTE);
  // The dedicated "关注列表暂无动态" block must stay hidden: nothing was read,
  // so there is no evidence that the people followed published nothing.
  assert.equal(el('feed-following-empty').hidden, true);
});

test('an empty successful read is still reported as empty, not as a failure', async () => {
  const doc = fakeDocument();
  const fetcher = feedFetcher({status: 401, body: {}}, () => ({
    status: 200, json: async () => ({items: [], cursor: null}),
  }));
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
  assert.equal(el('feed-error').hidden, true);
});

test('the failure sentence is exported once and reused by the note helper', async () => {
  const page = await import('../openteamily/static/discover/app.mjs');
  assert.equal(page.FEED_LOAD_FAILED_NOTE, FAILED_NOTE);
  assert.equal(page.feedNoteFor({tab: 'activity', query: '', kind: '', items: [], loading: false, failed: true}, false).note, FAILED_NOTE);
  assert.equal(page.feedNoteFor({tab: 'activity', query: 'zzz', kind: '', items: [], loading: false, failed: false}, false).note, FEED_SEARCH_EMPTY_NOTE);
  assert.equal(page.feedNoteFor({tab: 'activity', query: '', kind: '', items: [{slug: 'a'}], loading: false, failed: false}, false).note, FEED_ACTIVITY_LISTED_NOTE);
  assert.equal(page.feedNoteFor({tab: 'following', query: '', kind: '', items: [], loading: false, failed: false}, true).followingEmpty, true);
  assert.equal(page.feedNoteFor({tab: 'following', query: '', kind: '', items: [], loading: false, failed: true}, true).followingEmpty, false);
});
