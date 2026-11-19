import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {mount, readWizard, step1Ready, validName, validSlug} from '../openteamily/static/team/app.mjs';

test('validName and validSlug match the contrast rules', () => {
  assert.equal(validName('团队'), true);
  assert.equal(validName('x' * 61), false);
  assert.equal(validSlug('desk-team'), true);
  assert.equal(validSlug('ab'), false);
  assert.equal(validSlug('-desk'), false);
  assert.equal(validSlug('desk-'), false);
});

test('readWizard omits workspace_id unless converting', () => {
  const values = {name: ' Desk ', slug: 'desk-team', mode: 'new', workspace_id: 'abc'};
  const fake = {get(name) { return values[name]; }};
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readWizard({}), {name: 'Desk', slug: 'desk-team', mode: 'new', workspace_id: undefined});
    values.mode = 'convert';
    assert.deepEqual(readWizard({}), {name: 'Desk', slug: 'desk-team', mode: 'convert', workspace_id: 'abc'});
  } finally {
    globalThis.FormData = original;
  }
});

test('step1Ready requires both a valid name and a valid Team ID', () => {
  assert.equal(step1Ready({name: '', slug: ''}), false);
  assert.equal(step1Ready({name: 'Desk', slug: ''}), false);
  assert.equal(step1Ready({name: '', slug: 'desk-team'}), false);
  assert.equal(step1Ready({name: 'Desk', slug: 'ab'}), false);
  assert.equal(step1Ready({name: 'Desk', slug: 'desk-team'}), true);
});

// --- Issue #246: the wizard's step 2 must really invite the first member. ---
// These tests import only symbols that exist on main today and drive the real
// mount() against a document parsed from the served HTML, so a control that the
// page does not ship cannot be invented here. On main step 2 is only a note and
// #next stays disabled, so the assertions fail as user-visible behaviour.

const teamHtml = readFileSync(new URL('../openteamily/static/team/index.html', import.meta.url), 'utf8');
const TEAM_TOKEN = 'tok_' + 'A'.repeat(40);
const INVITE_EXPIRES = Date.UTC(2026, 10, 26) / 1000;

// The wizard reads its fields through FormData; the fake document only needs the
// values a user would have typed, so one module-level stub serves every case.
const wizardFormValues = {name: '', slug: '', mode: 'new', workspace_id: undefined};
globalThis.FormData = class { constructor() { return {get: (name) => wizardFormValues[name]}; } };

class TeamNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.name = '';
    this.type = '';
    this.id = '';
    this.className = '';
    this.focused = false;
    this._text = '';
    this._named = {};
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) { if (!names().includes(name)) element.className = [...names(), name].join(' '); },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
      toggle(name, force) {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get elements() { return this._named; }
  get parentElement() { return this.parent; }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
      if (this.tagName === 'SELECT' && !this.value && node.value) this.value = node.value;
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  dispatch(type, event = {}) {
    const handlers = this.handlers[type] || [];
    return Promise.all(handlers.map((handler) => handler({
      type, target: this, preventDefault() {}, stopPropagation() {}, ...event,
    })));
  }
}

function fakeTeamDocument(html) {
  const byId = new Map();
  const forms = [];
  for (const match of html.matchAll(/<(\/?)([a-z0-9-]+)\b([^>]*)>/gi)) {
    const [, closing, rawTag, attrs] = match;
    const tag = rawTag.toUpperCase();
    if (closing) {
      if (tag === 'FORM' && forms.length) forms.pop();
      continue;
    }
    const id = /\bid="([^"]+)"/.exec(attrs);
    const name = /\bname="([^"]+)"/.exec(attrs);
    let node = null;
    if (id || name) {
      node = new TeamNode(tag);
      if (id) { node.id = id[1]; byId.set(id[1], node); }
      if (name) {
        node.name = name[1];
        const type = /\btype="([^"]+)"/.exec(attrs);
        if (type) node.type = type[1];
        if (forms.length) forms[forms.length - 1]._named[name[1]] = node;
      }
      for (const attr of attrs.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        node.attributes[attr[1]] = attr[2];
      }
      node.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      node.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
    }
    if (tag === 'FORM') {
      const form = node || new TeamNode('FORM');
      if (!form._named) form._named = {};
      if (id) { form.id = id[1]; byId.set(id[1], form); }
      forms.push(form);
    }
  }
  const body = new TeamNode('BODY');
  const doc = {
    cookie: '',
    body,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new TeamNode(tag); },
    createElementNS(_namespace, tag) { return new TeamNode(tag); },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function jsonResponse(status, body) { return {status, json: async () => body}; }

function teamFetcher({inviteStatus = 201} = {}) {
  const requests = [];
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    requests.push({method, path, body: options.body ? JSON.parse(options.body) : undefined});
    if (path === '/v1/auth/session') return jsonResponse(200, {user: {id: 'u1', username: 'alice'}});
    if (path === '/v1/auth/providers') return jsonResponse(200, {items: []});
    if (path === '/v1/workspaces?limit=100') {
      return jsonResponse(200, {items: [{id: 'ws1', name: 'Desk', owner_id: 'u1', kind: 'personal'}]});
    }
    if (path === '/v1/teams' && method === 'POST') {
      return jsonResponse(201, {workspace: {id: 'wsnew', name: 'Desk Team', slug: 'desk-team', kind: 'team'}});
    }
    if (path === '/v1/workspaces/wsnew/invites' && method === 'POST') {
      if (inviteStatus !== 201) return jsonResponse(inviteStatus, {error: {code: 'quota', message: 'Invite capacity reached'}});
      return jsonResponse(201, {
        invite: {
          id: 'inv1', workspace_id: 'wsnew', role: 'member', created: 1763600000,
          expires: INVITE_EXPIRES, created_by: 'u1', max_uses: 1, use_count: 0,
          revoked: 0, requires_approval: false, frozen: false,
        },
        token: TEAM_TOKEN,
      });
    }
    return jsonResponse(404, {error: {message: 'Not found'}});
  };
  return {requests, fetcher};
}

async function mountWizard(values, options) {
  const {doc, el} = fakeTeamDocument(teamHtml);
  const fake = teamFetcher(options);
  Object.assign(wizardFormValues, {name: '', slug: '', mode: 'new', workspace_id: undefined}, values);
  await mount(doc, {fetcher: fake.fetcher});
  return {doc, el, requests: fake.requests};
}

const posted = (requests) => requests.filter((item) => item.method !== 'GET').map((item) => `${item.method} ${item.path}`);

test('the wizard ships a real invite step and an honest placeholder for step 3', () => {
  const {el} = fakeTeamDocument(teamHtml);
  assert.ok(el('step-2'), 'the wizard must ship a #step-2 invite step');
  assert.ok(el('invite-role'), 'step 2 must offer a role for the invited member');
  assert.ok(el('invite-expiry'), 'step 2 must offer an invite expiry');
  assert.ok(el('invite-skip'), 'step 2 must let the user skip inviting for now');
  assert.ok(el('invite-email'), 'step 2 must accept the invited colleague address');
  assert.ok(el('invite-mailto'), 'a created invite must offer a message the user can send');
  assert.ok(el('step-3'), 'the wizard must keep an honest placeholder for step 3');
  assert.match(teamHtml, /id="submit"[^>]*>[^<]*邀请/, 'the step 2 submit must say it also invites');
  assert.match(teamHtml, /id="invite-expiry"[\s\S]*?value="604800"/, 'the seven-day expiry must be offered');
  assert.doesNotMatch(teamHtml, /第 2 步和第 3 步还没有截图/, 'the page must stop claiming step 2 was never opened');
  assert.match(teamHtml, /id="step-3"[\s\S]*?还没有对照/, 'step 3 must stay an honest placeholder');
});

test('step one advances to the invite step without touching the server', async () => {
  const {el, requests} = await mountWizard({name: 'Desk Team', slug: 'desk-team', mode: 'new'});
  assert.equal(el('next').disabled, false, 'a filled step 1 must enable 继续');
  await el('next').dispatch('click');
  assert.ok(el('step-2'), '继续 must reveal a real #step-2 invite step');
  assert.equal(el('step-1').hidden, true);
  assert.equal(el('step-2').hidden, false, '继续 must reveal the invite step');
  assert.equal(el('wizard-step-label').textContent, '第 2 / 3 步');
  assert.deepEqual(posted(requests), [], 'moving to step 2 must not post anything');
});

test('creating the team and inviting posts once each with the chosen role and expiry', async () => {
  const {el, requests} = await mountWizard({name: 'Desk Team', slug: 'desk-team', mode: 'new'});
  await el('next').dispatch('click');
  if (el('invite-role')) el('invite-role').value = 'member';
  if (el('invite-expiry')) el('invite-expiry').value = '604800';
  if (el('invite-email')) el('invite-email').value = 'bob@example.com';
  await el('wizard-form').dispatch('submit');

  assert.deepEqual(
    posted(requests),
    ['POST /v1/teams', 'POST /v1/workspaces/wsnew/invites'],
    'the wizard must create the team and then really invite a member',
  );
  const [, invite] = requests.filter((item) => item.method === 'POST');
  assert.deepEqual(invite.body, {role: 'member', expires_in: 604800});
  assert.equal(el('invite-result').hidden, false, 'a created invite must be shown in place');
  assert.equal(el('invite-token').textContent, TEAM_TOKEN, 'the real one-time token must be shown verbatim');
  assert.match(el('invite-summary').textContent, /成员/);
  assert.match(el('invite-summary').textContent, /2026-11-26/);
  assert.match(el('invite-summary').textContent, /1 次/);
  assert.equal(el('finish-members').getAttribute('href'), '/members');
  assert.match(el('status').textContent, /团队已创建/);
  const mail = el('invite-mailto');
  assert.equal(mail.hidden, false, 'a valid address must offer a ready-to-send message');
  assert.match(mail.getAttribute('href'), /^mailto:bob@example\.com\?/);
  assert.match(decodeURIComponent(mail.getAttribute('href')), new RegExp(TEAM_TOKEN), 'the message must carry the real token');
  assert.equal(invite.body.email, undefined, 'the invite body must not invent an email field');
});

test('a failed invite keeps the invite step, shows the server error and shows no token', async () => {
  const {el, requests} = await mountWizard({name: 'Desk Team', slug: 'desk-team', mode: 'new'}, {inviteStatus: 429});
  await el('next').dispatch('click');
  await el('wizard-form').dispatch('submit');

  assert.equal(posted(requests).length, 2, 'one team post and one invite attempt, no retry storm');
  assert.match(el('status').textContent, /Invite capacity reached/, 'the server error must reach the page');
  assert.equal(el('step-2').hidden, false, 'a failed invite must not advance');
  assert.equal(el('step-3').hidden, true);
  assert.equal(el('invite-result').hidden, true, 'no invite panel without a created invite');
  assert.equal(el('invite-token').textContent, '');
  assert.equal(el('invite-mailto').hidden, true);
});

test('skipping the invite creates the team only and lands on step 3', async () => {
  const {el, requests} = await mountWizard({name: 'Desk Team', slug: 'desk-team', mode: 'new'});
  await el('next').dispatch('click');
  if (el('invite-skip')) await el('invite-skip').dispatch('click');
  else await el('wizard-form').dispatch('submit');

  assert.deepEqual(posted(requests), ['POST /v1/teams'], 'skipping must not create an invite');
  assert.ok(el('step-3'), 'skipping must land on the honest step 3 placeholder');
  assert.equal(el('step-3').hidden, false);
  assert.equal(el('step-2').hidden, true);
  assert.match(el('status').textContent, /团队已创建/);
});

test('going back from the invite step keeps the typed team and posts nothing', async () => {
  const {el, requests} = await mountWizard({name: 'Desk Team', slug: 'desk-team', mode: 'new'});
  await el('next').dispatch('click');
  await el('back').dispatch('click');

  assert.ok(el('step-2'), '继续 must reveal a real #step-2 invite step');
  assert.equal(el('step-1').hidden, false);
  assert.equal(el('step-2').hidden, true);
  assert.equal(el('next').disabled, false, 'the filled step 1 must stay valid after going back');
  assert.deepEqual(posted(requests), []);
});
