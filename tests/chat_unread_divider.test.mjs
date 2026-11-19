import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { unreadDividerIndex, unreadDividerText } from '../openteamily/static/chat/app.mjs';

const rows = [
  {id: 'm1', body: 'first'},
  {id: 'm2', body: 'second'},
  {id: 'm3', body: 'third'},
];

test('unreadDividerIndex puts the divider on the first unread row', () => {
  assert.equal(unreadDividerIndex(rows, 'm2'), 1);
  assert.equal(unreadDividerIndex(rows, 'm1'), 0);
});

test('a fully read or empty conversation draws no divider', () => {
  assert.equal(unreadDividerIndex(rows, ''), -1);
  assert.equal(unreadDividerIndex(rows, null), -1);
  // The boundary may have fallen out of the loaded window; drawing it nowhere is
  // better than drawing it in the wrong place.
  assert.equal(unreadDividerIndex(rows, 'm9'), -1);
  assert.equal(unreadDividerIndex([], 'm1'), -1);
  assert.equal(unreadDividerIndex(null, 'm1'), -1);
});

test('unreadDividerText counts the messages the reader has not seen', () => {
  assert.equal(unreadDividerText(3), '以下是新消息 · 3 条');
  assert.equal(unreadDividerText(1), '以下是新消息 · 1 条');
  assert.equal(unreadDividerText(0), '以下是新消息');
  assert.equal(unreadDividerText(undefined), '以下是新消息');
});

test('the conversation render inserts the divider and starts the view there', () => {
  const source = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /unreadDividerIndex\(items, unreadFrom\)/);
  assert.match(source, /unreadFrom/);
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.unread-divider\s*\{/);
});
