import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SKILLS, filterSkills, mountSkills, readInstalled, skillButtonLabel, skillCountLabel,
  writeInstalled,
} from '../openteamily/static/skills/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.classList = {
      add: (name) => { if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim(); },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element(id === 'skills-search' ? 'input' : 'div'));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

function cardFor(el, id) {
  return el('skills-list').children.find((card) => card.children[2].dataset.skill === id);
}

function request(url, options) {
  return {url, options};
}

function reply(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('the catalogue has 8-12 unique self-written skills', () => {
  assert.ok(SKILLS.length >= 8 && SKILLS.length <= 12);
  assert.equal(new Set(SKILLS.map((item) => item.id)).size, SKILLS.length);
  for (const item of SKILLS) {
    assert.ok(item.id && item.name && item.description && item.mark);
  }
});

test('filterSkills matches names and descriptions without inventing data', () => {
  assert.equal(filterSkills(SKILLS, '').length, SKILLS.length);
  assert.deepEqual(filterSkills(SKILLS, '会议').map((item) => item.id), ['meeting-notes']);
  assert.deepEqual(filterSkills(SKILLS, '表格').map((item) => item.id), ['data-brief']);
  assert.deepEqual(filterSkills(SKILLS, '找不到的技能'), []);
  assert.deepEqual(filterSkills(SKILLS, '  邮件 ').map((item) => item.id), ['email-draft']);
});

test('skillButtonLabel and skillCountLabel stay the visible contract', () => {
  assert.equal(skillButtonLabel(false), '安装');
  assert.equal(skillButtonLabel(true), '已安装');
  assert.equal(skillCountLabel(SKILLS.length, SKILLS.length), `共 ${SKILLS.length} 个技能`);
  assert.equal(skillCountLabel(1, SKILLS.length), `显示 1 / ${SKILLS.length} 个技能`);
});

test('readInstalled asks the account endpoint with the session cookie', async () => {
  const calls = [];
  const installed = await readInstalled(async (url, options) => {
    calls.push(request(url, options));
    return reply(200, {installed: ['meeting-notes', 'trip-plan']});
  });
  assert.deepEqual([...installed], ['meeting-notes', 'trip-plan']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/skills/installed');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
});

test('writeInstalled posts an install and deletes an uninstall with the CSRF token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(request(url, options));
    return reply(200, {installed: options.method === 'POST' ? ['meeting-notes'] : []});
  };
  const cookie = '__Host-ot_csrf=token-value';

  const afterInstall = await writeInstalled('meeting-notes', true, {fetchImpl, cookie});
  assert.deepEqual([...afterInstall], ['meeting-notes']);
  assert.equal(calls[0].url, '/v1/skills/installed');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'token-value');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {skill: 'meeting-notes'});

  const afterRemoval = await writeInstalled('meeting-notes', false, {fetchImpl, cookie});
  assert.deepEqual([...afterRemoval], []);
  assert.equal(calls[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].options.body), {skill: 'meeting-notes'});
});

test('a refused write rejects with the server message instead of guessing', async () => {
  const fetchImpl = async () => reply(403, {error: {code: 'csrf', message: 'A valid CSRF token is required'}});
  await assert.rejects(
    () => writeInstalled('meeting-notes', true, {fetchImpl, cookie: ''}),
    /A valid CSRF token is required/,
  );
});

test('a signed-out read rejects with the server message and installs nothing', async () => {
  const fetchImpl = async () => reply(401, {error: {code: 'unauthorized', message: 'Sign in first'}});
  await assert.rejects(() => readInstalled(fetchImpl), /Sign in first/);
});

test('a reload shows the account list instead of resetting every card', async () => {
  const {doc, el} = fakeDocument();
  const mounted = mountSkills(doc, {
    read: async () => new Set(['meeting-notes']),
    write: async () => new Set(),
  });
  assert.equal(el('skills-list').children.length, SKILLS.length);
  assert.equal(el('skills-list').attributes['aria-busy'], 'true');
  await mounted.ready;
  assert.equal(el('skills-list').attributes['aria-busy'], 'false');
  const installed = cardFor(el, 'meeting-notes');
  assert.equal(installed.children[2].textContent, '已安装');
  assert.equal(installed.children[2].attributes['aria-pressed'], 'true');
  assert.equal(installed.className.includes('is-installed'), true);
  assert.equal(cardFor(el, 'web-summary').children[2].textContent, '安装');
  assert.equal(el('skills-error').hidden, true);
});

test('installing writes to the server and only then flips the card', async () => {
  const {doc, el} = fakeDocument();
  const writes = [];
  let granted = new Set();
  const mounted = mountSkills(doc, {
    read: async () => new Set(),
    write: async (id, wanted) => {
      writes.push([id, wanted]);
      granted = wanted ? new Set([...granted, id]) : new Set([...granted].filter((value) => value !== id));
      return new Set(granted);
    },
  });
  await mounted.ready;
  const button = cardFor(el, 'meeting-notes').children[2];
  assert.equal(button.textContent, '安装');
  const click = button.handlers.click();
  assert.equal(button.disabled, true);
  await click;
  assert.deepEqual(writes, [['meeting-notes', true]]);
  assert.equal(cardFor(el, 'meeting-notes').children[2].textContent, '已安装');

  const installedButton = cardFor(el, 'meeting-notes').children[2];
  await installedButton.handlers.click();
  assert.deepEqual(writes, [['meeting-notes', true], ['meeting-notes', false]]);
  assert.equal(cardFor(el, 'meeting-notes').children[2].textContent, '安装');
  assert.equal(mounted.installed.has('meeting-notes'), false);
});

test('a failed install shows the server reason and leaves the card uninstalled', async () => {
  const {doc, el} = fakeDocument();
  const mounted = mountSkills(doc, {
    read: async () => new Set(),
    write: async () => { throw new Error('Unknown skill id'); },
  });
  await mounted.ready;
  await cardFor(el, 'meeting-notes').children[2].handlers.click();
  assert.equal(el('skills-error').hidden, false);
  assert.equal(el('skills-error').textContent, 'Unknown skill id');
  assert.equal(mounted.installed.size, 0);
  const card = cardFor(el, 'meeting-notes');
  assert.equal(card.children[2].textContent, '安装');
  assert.equal(card.children[2].attributes['aria-pressed'], 'false');
  assert.equal(card.className.includes('is-installed'), false);
});

test('signed out, the page explains why and never writes a local install', async () => {
  const {doc, el} = fakeDocument();
  const mounted = mountSkills(doc, {
    read: async () => { throw new Error('Sign in first'); },
    write: async () => { throw new Error('Sign in first'); },
  });
  await mounted.ready;
  assert.equal(el('skills-error').textContent, 'Sign in first');
  assert.equal(mounted.installed.size, 0);
  await cardFor(el, 'meeting-notes').children[2].handlers.click();
  assert.equal(mounted.installed.size, 0);
  assert.equal(cardFor(el, 'meeting-notes').children[2].textContent, '安装');
  assert.equal(el('skills-error').textContent, 'Sign in first');
});

test('mountSkills still filters, counts and shows the empty state', async () => {
  const {doc, el} = fakeDocument();
  const mounted = mountSkills(doc, {
    read: async () => new Set(),
    write: async () => new Set(),
  });
  await mounted.ready;
  assert.equal(el('skills-count').textContent, `共 ${SKILLS.length} 个技能`);
  assert.equal(el('skills-empty').hidden, true);

  el('skills-search').value = '会议';
  el('skills-search').handlers.input();
  assert.equal(el('skills-list').children.length, 1);
  assert.equal(el('skills-count').textContent, `显示 1 / ${SKILLS.length} 个技能`);
  assert.equal(el('skills-list').children[0].children[1].children[0].textContent, '会议纪要');

  el('skills-search').value = '找不到的技能';
  el('skills-search').handlers.input();
  assert.equal(el('skills-list').children.length, 0);
  assert.equal(el('skills-empty').hidden, false);
});
