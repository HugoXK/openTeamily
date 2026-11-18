import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResolvedTheme, ensureOnboardingMenuItem, ONBOARDING_MENU_HREF, ONBOARDING_MENU_LABEL, resolveTheme } from '../openteamily/static/shell/app.mjs';

function at(hours, minutes = 0) {
  return new Date(2026, 10, 16, hours, minutes, 0);
}

test('resolveTheme keeps explicit light and dark', () => {
  assert.equal(resolveTheme({appearance: 'light'}), 'light');
  assert.equal(resolveTheme({appearance: 'dark'}), 'dark');
});

test('resolveTheme follows the system preference when appearance is system', () => {
  assert.equal(resolveTheme({appearance: 'system'}, at(12), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'system'}, at(12), {matches: false}), 'light');
  assert.equal(resolveTheme({}, at(12), {matches: false}), 'light');
});

test('resolveTheme uses a custom auto window, including ranges that wrap midnight', () => {
  const values = {appearance: 'auto', appearance_schedule: 'custom',
                  appearance_start: '22:00', appearance_end: '06:30'};
  assert.equal(resolveTheme(values, at(22, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(23, 15), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 29), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 30), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(12, 0), {matches: true}), 'light');
  const daytime = {appearance: 'auto', appearance_schedule: 'custom',
                   appearance_start: '09:00', appearance_end: '17:00'};
  assert.equal(resolveTheme(daytime, at(9, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(daytime, at(16, 59), {matches: false}), 'dark');
  assert.equal(resolveTheme(daytime, at(17, 0), {matches: false}), 'light');
});

/*「自动」has no location to work from, so sunset_sunrise resolves to a fixed night window
instead of silently handing the answer to prefers-color-scheme: 22:00 inclusive to 06:00
exclusive is night, the rest of the day is light. Every call passes `media` explicitly, so a
light answer proves the window decided rather than the device. */
test('resolveTheme reads sunset_sunrise as the fixed 22:00-06:00 night window', () => {
  const values = {appearance: 'auto', appearance_schedule: 'sunset_sunrise',
                  appearance_start: '22:00', appearance_end: '06:30'};
  assert.equal(resolveTheme(values, at(21, 59), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(22, 0), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(5, 59), {matches: false}), 'dark');
  assert.equal(resolveTheme(values, at(6, 0), {matches: false}), 'light');
  assert.equal(resolveTheme(values, at(12, 0), {matches: true}), 'light');
});

test('the night window is the same block of hours on either side of midnight', () => {
  const night = {appearance: 'auto', appearance_schedule: 'sunset_sunrise'};
  for (const now of [at(22, 0), at(23, 30), at(0, 0), at(3, 0), at(5, 59)]) {
    assert.equal(resolveTheme(night, now, {matches: false}), 'dark', now.toTimeString());
  }
  for (const now of [at(6, 0), at(9, 0), at(12, 0), at(18, 0), at(21, 59)]) {
    assert.equal(resolveTheme(night, now, {matches: true}), 'light', now.toTimeString());
  }
});

test('following the system still follows prefers-color-scheme, night or not', () => {
  assert.equal(resolveTheme({appearance: 'system'}, at(23, 30), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'system'}, at(23, 30), {matches: false}), 'light');
  assert.equal(resolveTheme({}, at(23, 30), {matches: false}), 'light');
});

test('resolveTheme falls back when a custom window is incomplete', () => {
  const values = {appearance: 'auto', appearance_schedule: 'custom',
                  appearance_start: '22:00'};
  assert.equal(resolveTheme(values, at(23, 0), {matches: true}), 'dark');
  assert.equal(resolveTheme({appearance: 'auto', appearance_schedule: 'custom',
                             appearance_start: '08:00', appearance_end: '08:00'},
                            at(8, 0), {matches: false}), 'light');
});

test('applyResolvedTheme records the resolved theme on the document', () => {
  const doc = {documentElement: {dataset: {}}, body: {dataset: {}}};
  assert.equal(applyResolvedTheme(doc, {appearance: 'dark'}), 'dark');
  assert.equal(doc.documentElement.dataset.themeResolved, 'dark');
  assert.equal(doc.body.dataset.themeResolved, 'dark');
});


class MenuNode {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {...attrs};
    this.className = attrs.class || '';
    this.href = attrs.href || '';
    this.textContent = attrs.text || '';
  }
  getAttribute(key) { return this.attributes[key]; }
  setAttribute(key, value) {
    this.attributes[key] = value;
    if (key === 'href') this.href = value;
    if (key === 'class') this.className = value;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
  insertBefore(node, reference) {
    if (!reference) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.children.indexOf(reference);
    if (index === -1) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(index, 0, node);
    return node;
  }
}

function accountMenu(items) {
  const menu = new MenuNode('div', {id: 'account-menu'});
  for (const item of items) {
    if (item.kind === 'sub') {
      const sub = new MenuNode('div', {class: 'account-sub'});
      menu.appendChild(sub);
    } else {
      const link = new MenuNode('a', {href: item.href, role: 'menuitem', text: item.text});
      link.textContent = item.text;
      menu.appendChild(link);
    }
  }
  const doc = {
    getElementById(id) { return id === 'account-menu' ? menu : null; },
    createElement(tag) { return new MenuNode(tag); },
  };
  return {doc, menu};
}

function labels(menu) {
  return menu.children.map((node) => node.textContent || node.className);
}

test('ensureOnboardingMenuItem does nothing when the account menu is missing', () => {
  assert.equal(ensureOnboardingMenuItem({getElementById() { return null; }}), null);
});

test('ensureOnboardingMenuItem inserts 工作背景 before help, after 创建团队', () => {
  const {doc, menu} = accountMenu([
    {href: '/profile', text: '查看我的资料'},
    {href: '/team', text: '创建团队'},
    {kind: 'sub'},
    {href: '/settings', text: '所有设置'},
  ]);
  const link = ensureOnboardingMenuItem(doc);
  assert.equal(link.getAttribute('href'), ONBOARDING_MENU_HREF);
  assert.equal(link.getAttribute('role'), 'menuitem');
  assert.equal(link.textContent, ONBOARDING_MENU_LABEL);
  assert.match(link.getAttribute('title'), /新手引导/);
  assert.deepEqual(labels(menu), ['查看我的资料', '创建团队', '工作背景', 'account-sub', '所有设置']);
});

test('ensureOnboardingMenuItem moves an existing link into the recorded slot and does not duplicate it', () => {
  const {doc, menu} = accountMenu([
    {href: '/profile', text: '查看我的资料'},
    {href: '/onboarding', text: '新手引导'},
    {href: '/team', text: '创建团队'},
    {kind: 'sub'},
    {href: '/settings', text: '所有设置'},
  ]);
  ensureOnboardingMenuItem(doc);
  const again = ensureOnboardingMenuItem(doc);
  const matches = menu.children.filter((node) => node.getAttribute && node.getAttribute('href') === '/onboarding');
  assert.equal(matches.length, 1);
  assert.equal(matches[0], again);
  assert.equal(again.textContent, '工作背景');
  assert.deepEqual(labels(menu), ['查看我的资料', '创建团队', '工作背景', 'account-sub', '所有设置']);
});
