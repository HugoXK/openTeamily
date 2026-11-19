import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');

test('the group info card offers a real 1–500 character announcement form', () => {
  assert.match(html, /id="group-announce-form"/);
  assert.match(html, /id="group-announce-body"[^>]*maxlength="500"/);
  assert.match(html, /id="group-announce-publish"[^>]*>发布</);
  assert.doesNotMatch(html, /还没有群公告接口/);
  assert.doesNotMatch(html, /group-info-link" disabled/);
});

test('the chat app loads and saves the announcement through the social API', () => {
  assert.match(app, /\$\{socialBase\(\)\}\/\$\{cid\}\/announcement/);
  assert.match(app, /settleAnnouncement|announcement/);
});
