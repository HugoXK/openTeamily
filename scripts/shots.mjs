#!/usr/bin/env node
/**
 * One-command before/after screenshots for the OpenTeamily management UI.
 *
 *   # two already-running servers
 *   ot=... node scripts/shots.mjs --slug help-center \
 *     --before http://127.0.0.1:8101 --after http://127.0.0.1:8102 \
 *     --routes /chat --states account-menu-open
 *
 *   # two commits: each side gets its own worktree + seeded fixture app
 *   node scripts/shots.mjs --slug help-center \
 *     --before 310d468 --after <pr-tip> --routes /chat --states account-menu-open
 *
 * Writes .shots/<slug>/<before|after>/<locale>__<theme>__<viewport>__<route>.png
 * plus .shots/<slug>/diff.json (changed-pixel ratio and bounding box per pair).
 *
 * The browser driving is deliberately thin. Server startup and fixture seeding
 * reuse the existing scripts/ci_ui_screenshots.py --serve harness; this script
 * only adds the two-arm orchestration, state actions and the pixel diff.
 *
 * Read-only towards the checkout: it writes only .shots/, worktrees under
 * ../.shots-servers/ and state under ../.shots-state/. Credentials come from
 * ready.json (ref mode), --login-file, or OT_USERNAME/OT_PASSWORD; never printed.
 */
import fs from 'node:fs';
// Owner rule (2026-11-20): the product is a dsh plugin, so reuse dsh mechanisms
// instead of inventing a parallel set. The app's own client (runtime/ds-bot-upstream/
// ds-bot/src/client/themes.js) emits --dsw-alias-* tokens and switches dark by
// body[data-ds-dark-theme]; we read exactly those two signals rather than a new one.
const REUSE = {
  theme: 'dsh-client-ui-theme — token names only: the page maps --dsw-alias-* (shellTokens in themes.js) and resolves our dark arm to documentElement.dataset.themeResolved=dark; body[data-ds-dark-theme] is set by the dsh host, absent in these standalone pages (fact darkAttr), so no parallel palette is invented',
  viewports: 'none — dsh ships no px breakpoint constant (only prefers-reduced-motion/transparency); 1440x900 + 390x844 are the owner rule, kept as-is',
  hmr: 'none — not needed for static before/after shots',
};
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORK_ROOT = path.resolve(REPO_ROOT, '..');
const SERVER_ROOT = path.join(WORK_ROOT, '.shots-servers');
const STATE_ROOT = path.join(WORK_ROOT, '.shots-state');

function die(message) {
  process.stderr.write(`shots: ${message}\n`);
  process.exit(2);
}

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function argList(name, fallback) {
  const raw = argValue(name, '');
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function safePart(text) {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function readLoginFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const username = /(?:^|\n)username=([^\n]+)/.exec(text)?.[1];
  const password = /(?:^|\n)password=([^\n]+)/.exec(text)?.[1];
  if (!username || !password) die(`login file ${file} is missing username= or password=`);
  return { username: username.trim(), password: password.trim() };
}

function envLogin() {
  const username = process.env.OT_USERNAME || argValue('--username');
  const password = process.env.OT_PASSWORD || argValue('--password');
  if (!username || !password) {
    die('no credentials: pass --login-file, or set OT_USERNAME and OT_PASSWORD (or use a git ref, which seeds its own login)');
  }
  return { username, password };
}

function routeToName(route) {
  const cleaned = route.split('?')[0].split('#')[0];
  if (cleaned === '/' || cleaned === '') return 'index';
  return cleaned.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function viewportFrom(text) {
  const match = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!match) die(`viewport must look like 1440x900, got ${text}`);
  return { width: Number(match[1]), height: Number(match[2]), label: text.trim() };
}

function csrfFromCookies(cookies) {
  return cookies.find((item) => /_csrf$/.test(item.name))?.value || '';
}

function waitForFile(file, timeoutMs, since = 0) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fs.statSync(file).mtimeMs >= since) return resolve();
      } catch { /* not written yet */ }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${file}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function isHttpUrl(value) {
  return /^https?:\/\//.test(value);
}

const children = new Set();
const worktrees = new Set();

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  for (const tree of worktrees) {
    spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' });
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

/**
 * A side is either an already-running server URL or a git ref. In ref mode the
 * side gets a detached worktree plus the existing seeded fixture app, exactly
 * like scripts/ci_ui_screenshots.py starts it for CI.
 */
function assertPortFree(port, name) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', (error) => reject(new Error(
      `port ${port} is busy (${error.code}); free it or pass --${name}-port`)));
    socket.once('listening', () => socket.close(() => resolve()));
    socket.listen(port, '127.0.0.1');
  });
}

async function ensureWorktree(name, ref) {
  const tree = path.join(SERVER_ROOT, `${name}-${safePart(ref)}`);
  fs.mkdirSync(SERVER_ROOT, { recursive: true });
  if (fs.existsSync(tree)) {
    spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' });
  }
  const add = spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', tree, ref], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`git worktree add ${ref} failed: ${add.stderr.trim()}`);
  worktrees.add(tree);
  return tree;
}

/**
 * Seed the synthetic fixtures ONCE with the existing CI harness. Both sides
 * then run against a byte-identical copy of that database: the fixture picks
 * random workspace/conversation ids, and an independently seeded pair would
 * land on different default workspaces, drowning the real UI change in noise.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

// Extra synthetic rows on top of the stock CI fixture, written by this harness
// only. They land in the ONE seed database before it is copied to both sides,
// so the two arms still see byte-identical data.
const EXTRA_PASSWORD = 'ci-fixture-extra-2026';
const EXTRA_CREATORS = [
  ['alice', ['[CI FIXTURE] Alice design brief', '[CI FIXTURE] Alice design review']],
  ['bob', ['[CI FIXTURE] Bob research notes', '[CI FIXTURE] Bob research summary']],
];
let OWNER_LOGIN = null;
let OWNER_COOKIES = null;
const ONBOARDING_COOKIES = {};
const PAGING_TOKEN = '翻页探针';
const PAGING_COUNT = 25;
// #239: the catalog card that already exists in the owner workspace (clicks
// must answer 409) and the creator-owned card that does not (clicks must 201).
const CATALOG_CONFLICT_NAME = '[CI FIXTURE] 目录甲';
const CATALOG_CREATE_NAME = '[CI FIXTURE] 目录乙';
// One row per wording the list must prove: 立即运行 / 每天 09:00（Asia/Shanghai）/
// 每天 18:00（UTC）/ 单次 2026-11-20 09:00（Asia/Shanghai）.
const SCHEDULE_AUTOMATIONS = [
  ['[CI FIXTURE] Daily Shanghai', {kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}],
  ['[CI FIXTURE] Daily UTC', {kind: 'daily', time: '18:00', time_zone: 'UTC'}],
  ['[CI FIXTURE] One-off', {kind: 'once', time: '09:00', time_zone: 'Asia/Shanghai', date: '2026-11-20'}],
];

async function apiJson(context, base, csrf, method, route, body, extra = {}) {
  const headers = { Origin: base, Accept: 'application/json', ...extra };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const response = await context.request.fetch(base + route, { method, data: body, headers });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status(), body: parsed, text };
}

async function seedCreator(browser, origin, owner, ownerCsrf, workspaceId, username, agentNames) {
  const context = await browser.newContext();
  let response = await apiJson(context, origin, '', 'POST', '/v1/auth/register',
    { username, password: EXTRA_PASSWORD });
  if (response.status !== 200 && response.status !== 201) {
    response = await apiJson(context, origin, '', 'POST', '/v1/auth/login',
      { username, password: EXTRA_PASSWORD });
  }
  if (response.status !== 200 && response.status !== 201) {
    await context.close();
    throw new Error(`seed-extra: cannot register ${username}: HTTP ${response.status} ${response.text.slice(0, 160)}`);
  }
  let csrf = csrfFromCookies(await context.cookies());
  if (!csrf) {
    const signedIn = await apiJson(context, origin, '', 'POST', '/v1/auth/login',
      { username, password: EXTRA_PASSWORD });
    if (signedIn.status !== 200) {
      await context.close();
      throw new Error(`seed-extra: cannot sign in ${username}: HTTP ${signedIn.status} ${signedIn.text.slice(0, 160)}`);
    }
    csrf = csrfFromCookies(await context.cookies());
  }
  if (!csrf) {
    await context.close();
    throw new Error(`seed-extra: no CSRF cookie for ${username}`);
  }
  const added = await apiJson(owner, origin, ownerCsrf, 'POST',
    `/v1/workspaces/${workspaceId}/members`, { username, role: 'admin' });
  if (added.status !== 200 && added.status !== 201) {
    await context.close();
    throw new Error(`seed-extra: add ${username}: HTTP ${added.status} ${added.text.slice(0, 160)}`);
  }
  for (const [index, name] of agentNames.entries()) {
    const created = await apiJson(context, origin, csrf, 'POST',
      `/v1/workspaces/${workspaceId}/agents`,
      { name, summary: 'Synthetic CI fixture creator-filter entry.', instructions: 'Fixture only.' },
      { 'Idempotency-Key': `ci-creator-${username}-${index}-0001` });
    if (created.status !== 200 && created.status !== 201) {
      await context.close();
      throw new Error(`seed-extra: ${username} agent ${name}: HTTP ${created.status} ${created.text.slice(0, 160)}`);
    }
    // #239: publish the first creator agent so the public catalog has a card
    // whose name does NOT exist in the owner's workspace (the 201/create path).
    if (index === 0 && username === 'alice') {
      const id = created.body?.agent?.id;
      if (!id) {
        await context.close();
        throw new Error(`seed-extra: ${username} agent ${name} has no id in ${created.text.slice(0, 160)}`);
      }
      const published = await apiJson(context, origin, csrf, 'POST',
        `/v1/workspaces/${workspaceId}/agents/${id}/discover`,
        {slug: `ci-catalog-${username}`});
      if (published.status !== 200 && published.status !== 201) {
        await context.close();
        throw new Error(`seed-extra: publish ${name}: HTTP ${published.status} ${published.text.slice(0, 160)}`);
      }
    }
  }
  await context.close();
}

async function seedStandalonePublisher(browser, origin, username, agentName, slug) {
  const context = await browser.newContext();
  try {
    let response = await apiJson(context, origin, '', 'POST', '/v1/auth/register',
      { username, password: EXTRA_PASSWORD });
    if (response.status !== 200 && response.status !== 201) {
      response = await apiJson(context, origin, '', 'POST', '/v1/auth/login',
        { username, password: EXTRA_PASSWORD });
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`seed-extra: cannot register publisher ${username}: HTTP ${response.status} ${response.text.slice(0, 160)}`);
    }
    const csrf = csrfFromCookies(await context.cookies());
    if (!csrf) throw new Error(`seed-extra: no CSRF cookie for ${username}`);
    const listed = await apiJson(context, origin, csrf, 'GET', '/v1/workspaces?limit=100');
    const items = listed.body?.workspaces || listed.body?.items || [];
    let space = items[0]?.id;
    if (!space) {
      const made = await apiJson(context, origin, csrf, 'POST', '/v1/workspaces',
        {name: `CI 目录工作区 ${username}`},
        {'Idempotency-Key': `ci-catalog-workspace-${username}-0001`});
      if (made.status !== 200 && made.status !== 201) {
        throw new Error(`seed-extra: ${username} workspace: HTTP ${made.status} ${made.text.slice(0, 160)}`);
      }
      space = made.body?.workspace?.id || made.body?.id;
    }
    if (!space) throw new Error(`seed-extra: ${username} has no workspace: ${listed.text.slice(0, 160)}`);
    const created = await apiJson(context, origin, csrf, 'POST', `/v1/workspaces/${space}/agents`,
      {name: agentName, summary: 'CI fixture: public catalog entry from another workspace.',
        instructions: 'Fixture only.'},
      {'Idempotency-Key': `ci-catalog-publisher-${username}-0001`});
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`seed-extra: publisher agent: HTTP ${created.status} ${created.text.slice(0, 160)}`);
    }
    const id = created.body?.agent?.id;
    if (!id) throw new Error(`seed-extra: publisher agent has no id in ${created.text.slice(0, 160)}`);
    const published = await apiJson(context, origin, csrf, 'POST',
      `/v1/workspaces/${space}/agents/${id}/discover`, {slug});
    if (published.status !== 200 && published.status !== 201) {
      throw new Error(`seed-extra: publish ${agentName}: HTTP ${published.status} ${published.text.slice(0, 160)}`);
    }
  } finally {
    await context.close();
  }
}


// #237: two extra accounts with their own empty workspace — one stays empty
// (ob-fresh), one gets a single agent (ob-partial). ob-ready uses the stock
// fixture account, which already has agents, an online runtime and a run.
async function seedOnboardingAccount(browser, origin, username, withAgent) {
  const context = await browser.newContext();
  try {
    let response = await apiJson(context, origin, '', 'POST', '/v1/auth/register',
      { username, password: EXTRA_PASSWORD });
    if (response.status !== 200 && response.status !== 201) {
      response = await apiJson(context, origin, '', 'POST', '/v1/auth/login',
        { username, password: EXTRA_PASSWORD });
    }
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`seed-extra: cannot register ${username}: HTTP ${response.status} ${response.text.slice(0, 160)}`);
    }
    const csrf = csrfFromCookies(await context.cookies());
    if (!csrf) throw new Error(`seed-extra: no CSRF cookie for ${username}`);
    const made = await apiJson(context, origin, csrf, 'POST', '/v1/workspaces',
      {name: `CI 新账号工作区 ${username}`},
      {'Idempotency-Key': `ci-onboarding-workspace-${username}-0001`});
    if (made.status !== 200 && made.status !== 201) {
      throw new Error(`seed-extra: ${username} workspace: HTTP ${made.status} ${made.text.slice(0, 160)}`);
    }
    const space = made.body?.workspace?.id || made.body?.id;
    if (!space) throw new Error(`seed-extra: ${username} workspace has no id: ${made.text.slice(0, 160)}`);
    if (withAgent) {
      const agent = await apiJson(context, origin, csrf, 'POST', `/v1/workspaces/${space}/agents`,
        {name: '[CI FIXTURE] 新账号智能体', summary: 'CI fixture: the one agent of a partial account.',
          instructions: 'Fixture only.'},
        {'Idempotency-Key': `ci-onboarding-agent-${username}-0001`});
      if (agent.status !== 200 && agent.status !== 201) {
        throw new Error(`seed-extra: ${username} agent: HTTP ${agent.status} ${agent.text.slice(0, 160)}`);
      }
    }
    ONBOARDING_COOKIES[username] = (await context.cookies()).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expires,
    }));
  } finally {
    await context.close();
  }
}

async function seedExtra(browser, { origin, ready, login }) {
  OWNER_LOGIN = {username: login.username, password: login.password};
  const note = (line) => process.stdout.write(`seed-extra: ${line}\n`);
  const owner = await browser.newContext();
  try {
    const ownerCsrf = await signIn(owner, origin, login, false);
    OWNER_COOKIES = (await owner.cookies()).map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expires,
    }));
    const workspaceId = ready.workspace_id;
    for (const [username, agentNames] of EXTRA_CREATORS) {
      await seedCreator(browser, origin, owner, ownerCsrf, workspaceId, username, agentNames);
    }
    note(`creators ${EXTRA_CREATORS.map(([name]) => name).join(', ')} own ${EXTRA_CREATORS[0][1].length} agents each`);
    await seedStandalonePublisher(browser, origin, 'carol', CATALOG_CREATE_NAME, 'ci-catalog-carol');
    note(`catalog create entry "${CATALOG_CREATE_NAME}" published from carol's own workspace`);
    // #211: four schedule kinds in one list. The stock fixture already makes the
    // `now` row; these three add daily (two zones) and once, all enabled and all
    // listing themselves under the owner's 我的自动化 tab.
    for (const [index, [title, schedule]] of SCHEDULE_AUTOMATIONS.entries()) {
      const created = await apiJson(owner, origin, ownerCsrf, 'POST',
        `/v1/workspaces/${workspaceId}/automations`,
        {title, prompt: 'CI fixture: schedule row wording only.', template_id: 'custom',
          schedule, participants: [login.username]},
        {'Idempotency-Key': `ci-schedule-automation-${index}-0001`});
      if (created.status !== 201) {
        throw new Error(`seed-extra: automation ${title}: HTTP ${created.status} ${created.text.slice(0, 160)}`);
      }
      const made = created.body.automation;
      const enabled = await apiJson(owner, origin, ownerCsrf, 'POST',
        `/v1/workspaces/${workspaceId}/automations/${made.id}`,
        {revision: made.revision, changes: {enabled: true}});
      if (enabled.status !== 200) {
        throw new Error(`seed-extra: enable ${title}: HTTP ${enabled.status} ${enabled.text.slice(0, 160)}`);
      }
    }
    note(`automations ${SCHEDULE_AUTOMATIONS.length} schedule rows added (now row comes from the fixture)`);
    // #239: one catalog entry published FROM the owner's own workspace, so
    // clicking 用这个智能体 on it must answer 409 (same name already there).
    const conflictAgent = await apiJson(owner, origin, ownerCsrf, 'POST',
      `/v1/workspaces/${workspaceId}/agents`,
      { name: CATALOG_CONFLICT_NAME, summary: 'CI fixture: catalog card that already exists here.',
        instructions: 'Fixture only.' },
      { 'Idempotency-Key': 'ci-catalog-conflict-0001' });
    if (conflictAgent.status !== 200 && conflictAgent.status !== 201) {
      throw new Error(`seed-extra: catalog conflict agent: HTTP ${conflictAgent.status} ${conflictAgent.text.slice(0, 160)}`);
    }
    const conflictId = conflictAgent.body?.agent?.id;
    if (!conflictId) throw new Error(`seed-extra: catalog conflict agent has no id in ${conflictAgent.text.slice(0, 160)}`);
    const publishedConflict = await apiJson(owner, origin, ownerCsrf, 'POST',
      `/v1/workspaces/${workspaceId}/agents/${conflictId}/discover`,
      {slug: 'ci-catalog-conflict'});
    if (publishedConflict.status !== 200 && publishedConflict.status !== 201) {
      throw new Error(`seed-extra: publish conflict agent: HTTP ${publishedConflict.status} ${publishedConflict.text.slice(0, 160)}`);
    }
    note(`catalog conflict entry "${CATALOG_CONFLICT_NAME}" published from the owner workspace`);
    await seedOnboardingAccount(browser, origin, 'obfresh', false);
    await seedOnboardingAccount(browser, origin, 'obpartial', true);
    note('onboarding accounts obfresh (empty workspace) and obpartial (one agent) seeded');
    // One token repeated in a single conversation: 25 hits page as 20 + 5, so
    // 加载更多 has a second page to append and then runs out of cursor.
    for (let index = 1; index <= PAGING_COUNT; index += 1) {
      const sent = await apiJson(owner, origin, ownerCsrf, 'POST',
        `/v1/workspaces/${workspaceId}/social/conversations/${ready.social_group_id}/messages`,
        { body: `${PAGING_TOKEN} 第 ${String(index).padStart(2, '0')} 条` },
        { 'Idempotency-Key': `ci-paging-probe-${String(index).padStart(4, '0')}` });
      if (sent.status !== 200 && sent.status !== 201) {
        throw new Error(`seed-extra: paging message ${index}: HTTP ${sent.status} ${sent.text.slice(0, 160)}`);
      }
    }
    note(`${PAGING_COUNT} messages carrying "${PAGING_TOKEN}" in one conversation`);
  } finally {
    await owner.close();
  }
}

function stopSeedServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 15000);
    child.once('exit', done);
    try { child.kill('SIGTERM'); } catch { done(); }
  });
}

async function seedFixtures(tree, timeoutMs, browser) {
  const state = path.join(STATE_ROOT, 'seed');
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const readyPath = path.join(state, 'out', 'ready.json');
  const logPath = path.join(state, 'seed.log');
  const log = fs.openSync(logPath, 'w');
  const python = process.env.SHOTS_PYTHON || 'python3.11';
  // --serve keeps the seeded app up long enough to add the extra rows over its
  // own HTTP API; it is stopped before the database is copied to either side.
  const child = spawn(python, [
    path.join(tree, 'scripts', 'ci_ui_screenshots.py'),
    '--data-dir', path.join(state, 'data'),
    '--out', path.join(state, 'out'),
    '--port', String(await findFreePort()),
    '--serve',
  ], { cwd: tree, env: { ...process.env, PYTHONPATH: tree }, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  child.unref();
  child.on('exit', () => children.delete(child));
  const spawnAt = Date.now();
  try {
    await waitForFile(readyPath, timeoutMs, spawnAt);
  } catch (error) {
    throw new Error(`${error.message}; seed log tail: ${fs.readFileSync(logPath, 'utf8').slice(-600)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
  const login = readLoginFile(ready.login_file);
  if (hasFlag('--seed-extra')) {
    // The screenshot fixture server runs with registration closed, so the extra
    // accounts cannot be created through it. Stop it cleanly (releasing SQLite)
    // and bring the same data dir up once more with --open-registration.
    await stopSeedServer(child);
    const extraPort = await findFreePort();
    const extraOrigin = `http://127.0.0.1:${extraPort}`;
    const extraLogPath = path.join(state, 'seed-extra.log');
    const extraLog = fs.openSync(extraLogPath, 'w');
    const extra = spawn(python, [
      '-m', 'openteamily.server',
      '--data-dir', path.join(state, 'data', 'state'),
      '--origin', extraOrigin,
      '--port', String(extraPort),
      '--insecure-local',
      '--no-automation-worker',
      '--open-registration',
    ], { cwd: tree, env: { ...process.env, PYTHONPATH: tree }, stdio: ['ignore', extraLog, extraLog], detached: true });
    children.add(extra);
    extra.unref();
    extra.on('exit', () => children.delete(extra));
    try {
      await waitForHttp(`${extraOrigin}/settings`, timeoutMs);
      await seedExtra(browser, { origin: extraOrigin, ready, login });
    } catch (error) {
      throw new Error(`${error.message}; seed-extra log tail: ${fs.readFileSync(extraLogPath, 'utf8').slice(-600)}`);
    } finally {
      await stopSeedServer(extra);
    }
  }
  // The data dir is copied to both sides, so the seeding server must be gone
  // (SQLite closed, WAL checkpointed) before anything reads it.
  await stopSeedServer(child);
  process.stdout.write(`seeded fixtures once (workspace ${ready.workspace_id.slice(0, 8)}…), reused by both sides\n`);
  return { dataDir: path.join(state, 'data'), login, ready };
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const code = response.status;
      // Drain the body before returning: an unconsumed stream on a kept-alive
      // socket trips Node 22's undici `assert(!this.paused)` in Parser.finish.
      await response.arrayBuffer().catch(() => {});
      if (code === 200) return;
      last = `HTTP ${code}`;
    } catch (error) {
      last = String(error.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready: ${last}`);
}

async function startServerSide({ name, ref, port, tree, seedData, login, timeoutMs }) {
  const state = path.join(STATE_ROOT, `${name}-${safePart(ref)}`);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const dataDir = path.join(state, 'data');
  fs.cpSync(seedData, dataDir, { recursive: true });
  // Store fails closed unless the directory is private; cpSync is subject to umask.
  fs.chmodSync(dataDir, 0o700);
  fs.chmodSync(path.join(dataDir, 'state'), 0o700);
  await assertPortFree(port, name);
  const origin = `http://127.0.0.1:${port}`;
  const logPath = path.join(state, 'server.log');
  const log = fs.openSync(logPath, 'w');
  const python = process.env.SHOTS_PYTHON || 'python3.11';
  const child = spawn(python, [
    '-m', 'openteamily.server',
    '--data-dir', path.join(dataDir, 'state'),
    '--origin', origin,
    '--port', String(port),
    '--insecure-local',
    '--no-automation-worker',
    ...((process.env[`SHOTS_SERVER_FLAGS_${name.toUpperCase()}`] || process.env.SHOTS_SERVER_FLAGS || '')
      .split(' ').filter(Boolean)),
  ], { cwd: tree, env: { ...process.env, PYTHONPATH: tree }, stdio: ['ignore', log, log], detached: true });
  children.add(child);
  child.unref();
  child.on('exit', () => children.delete(child));
  try {
    await waitForHttp(`${origin}/settings`, timeoutMs);
  } catch (error) {
    throw new Error(`${name}: ${error.message}; server log: ${fs.readFileSync(logPath, 'utf8').slice(-500) || '<empty>'}`);
  }
  if (child.exitCode !== null) throw new Error(`${name}: server exited ${child.exitCode}`);
  process.stdout.write(`ready ${name}: ${origin} (${ref})\n`);
  return { name, ref, url: origin, login, child, tree, state, dataDir };
}

// GET /v1/workspaces orders by the random workspace id, so which workspace a
// page opens on is luck. Every state that reads workspace data pins the one the
// fixture was seeded into, by name, before it acts.
let preferredWorkspaceLabel = '';
let preferredWorkspaceId = '';

async function ensureWorkspace(page) {
  if (!preferredWorkspaceLabel) return;
  const select = page.locator('#workspace');
  if (!(await select.count())) return;
  const labels = await select.evaluate((el) => [...el.options].map((option) => option.textContent.trim())
    .filter((label) => label && label !== '全部'));
  const current = await select.evaluate(
    (el) => (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : '').trim());
  if (current === preferredWorkspaceLabel) return;
  if (!labels.includes(preferredWorkspaceLabel)) {
    throw new Error(`workspace ${JSON.stringify(preferredWorkspaceLabel)} not offered; select has ${JSON.stringify(labels)}`);
  }
  // The selector is not rendered at these widths, so force the change; its own
  // change handler reloads the page's data.
  await select.selectOption({ label: preferredWorkspaceLabel }, { force: true });
  await page.waitForTimeout(1200);
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function apiFetch(context, base, method, route, body) {
  return context.request.fetch(base + route, {
    method,
    data: body,
    headers: { Origin: base, Accept: 'application/json' },
  });
}

async function signIn(context, base, login, registerAllowed) {
  let response = await apiFetch(context, base, 'POST', '/v1/auth/login', login);
  if (response.status() === 401 && registerAllowed) {
    response = await apiFetch(context, base, 'POST', '/v1/auth/register', login);
  }
  if (response.status() !== 200 && response.status() !== 201) {
    throw new Error(`sign-in failed: HTTP ${response.status()} ${(await response.text()).slice(0, 200)}`);
  }
  const csrf = csrfFromCookies(await context.cookies());
  if (!csrf) throw new Error('sign-in did not yield a CSRF cookie');
  return csrf;
}

async function applyPreferences(context, base, csrf, { locale, theme }) {
  const current = await apiFetch(context, base, 'GET', '/v1/settings');
  if (current.status() !== 200) throw new Error(`GET /v1/settings HTTP ${current.status()}`);
  const payload = await current.json();
  const changes = { appearance: theme };
  if (locale === 'en' || locale === 'zh-CN') changes.language = locale;
  const response = await context.request.fetch(base + '/v1/settings', {
    method: 'POST',
    data: { revision: payload.settings.revision, changes },
    headers: { Origin: base, 'X-CSRF-Token': csrf, Accept: 'application/json' },
  });
  if (response.status() !== 200) {
    throw new Error(`POST /v1/settings HTTP ${response.status()}: ${(await response.text()).slice(0, 160)}`);
  }
}

// Readings printed per state run so the report can quote the DOM, not only the
// pixel ratio. The side name is attached to the page by the capture loop.
function noteReading(page, text) {
  process.stdout.write(`state[${page.__side || '?'}] ${text}\n`);
}

// At ≤50rem the app hides the whole session pane while a conversation is open
// (`body.chat-open > .session-pane {display:none}`), so #search-panel is display
// block yet has no box at all: playwright calls it invisible and the screenshot
// would not contain it. The stylesheet already ships `.sessions-open` to bring
// the pane back as an overlay, so both arms put the pane on screen the same way.
async function ensureSessionPane(page) {
  const shown = await page.evaluate(() => {
    const pane = document.querySelector('.session-pane');
    if (!pane) return false;
    if (getComputedStyle(pane).display !== 'none') return true;
    // ≤50rem: an open conversation hides the pane and the page ships no toggle
    // (`.sessions-open` has no code path that sets it). Fall back to the app's
    // own "no conversation open" layout, where the pane is on screen.
    document.body.classList.remove('chat-open');
    return getComputedStyle(pane).display !== 'none';
  });
  if (!shown) throw new Error('session pane stays display:none; #search-panel has no box');
  const box = await page.locator('.session-pane').boundingBox();
  if (!box || box.width < 120 || box.height < 300) {
    throw new Error(`session pane has no usable box: ${JSON.stringify(box)}`);
  }
}

// #182: workspace-wide search. Focusing the box opens the panel on the 全部 tab;
// the 搜索 button would scope the search to the open conversation instead.
async function openWorkspaceSearch(page) {
  await ensureSessionPane(page);
  await page.locator('#session-search').focus({ timeout: 8000 }).catch(() => {});
  await page.waitForSelector('#search-panel:not([hidden])', { timeout: 8000 });
}

// Typing through the DOM (value + input event) instead of fill(): at 390 the
// search box is not rendered, but the page's own input listener still opens the
// panel and runs the workspace-wide search.
// Plan A for the narrow viewport: press the page's own 搜索 button to open the
// panel, then type into the box — no Emulation tricks, the viewport stays 390.
async function openSearchViaButton(page) {
  const group = page.locator('#conversation-list button.session-row', { hasText: 'Group chat' }).first();
  if (await group.count()) {
    await group.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.locator('#message-search').click({ timeout: 8000 });
  await page.waitForSelector('#search-panel:not([hidden])', { state: 'attached', timeout: 8000 });
}

// Reads the panel's box plus the three ancestors it needs to be laid out in.
// A zero box here is a property of the base layout, so the reading is printed
// before anything is typed and the pair can quote it as a base-state fact.
async function readPanelBox(page) {
  const diag = await page.evaluate(() => {
    const panel = document.getElementById('search-panel');
    const results = document.getElementById('search-results');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const chain = [];
    let node = panel;
    for (let level = 1; level <= 3 && node; level += 1) {
      node = node.parentElement;
      if (!node) break;
      const css = getComputedStyle(node);
      chain.push({
        level,
        tag: `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : ''}`,
        display: css.display,
        height: css.height,
        overflow: css.overflow,
      });
    }
    return { panel: box(panel), results: box(results), chain, vp: `${innerWidth}x${innerHeight}` };
  });
  noteReading(page, `panel bbox=${JSON.stringify(diag.panel)} results bbox=${JSON.stringify(diag.results)} vp=${diag.vp}`);
  for (const level of diag.chain) {
    noteReading(page, `parent L${level.level} ${level.tag} display=${level.display} height=${level.height} overflow=${level.overflow}`);
  }
  return diag;
}

async function searchFor(page, text) {
  await openSearchViaButton(page);
  const diag = await readPanelBox(page);
  if (!diag.panel || diag.panel.w <= 0 || diag.panel.h <= 0) {
    throw new Error(`#search-panel zero box at ${diag.vp}: ${JSON.stringify(diag.panel)}; results ${JSON.stringify(diag.results)}`);
  }
  await page.locator('#session-search').fill(text, { timeout: 8000 });
  await page.waitForSelector('#search-panel:not([hidden])', { timeout: 8000 });
}

async function waitForSearchRows(page, minimum, timeout = 20000) {
  try {
    await page.waitForFunction(
      (count) => document.querySelectorAll('#search-results li').length >= count,
      minimum,
      { timeout },
    );
  } catch {
    // A short page is itself a reading; keep going so the screenshot still tells it.
  }
}

async function anchorSearchBottom(page) {
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#search-results li');
    const last = rows[rows.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    // Nearest = the least scroll that fully shows the control, so the pair is
    // anchored at the end of the list and differs by the control, not by scroll.
    const more = document.getElementById('search-more');
    if (more && !more.hidden) more.scrollIntoView({ block: 'nearest' });
  });
  await page.waitForTimeout(250);
}

async function readSearchState(page) {
  return page.evaluate(() => {
    const more = document.getElementById('search-more');
    return {
      rows: document.querySelectorAll('#search-results li').length,
      more: !more ? 'absent' : (more.hidden ? 'hidden' : (more.disabled ? 'disabled' : 'visible')),
      empty: (document.getElementById('search-empty')?.textContent || '').trim(),
      control: (() => {
        const node = document.getElementById('search-more');
        if (!node || node.hidden) return null;
        const r = node.getBoundingClientRect();
        return {
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          inView: r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0 && r.height > 0,
        };
      })(),
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
}

// #184: creator filter on /agents. Category chips exist on both arms; the
// creator <select> is greyed out on the base, so only the fixed arm can filter.
async function clickAgentCategory(page, slug) {
  const chip = page.locator(`.filter-row .pill[data-category="${slug}"]`);
  if (await chip.count()) await chip.click();
  await page.waitForTimeout(300);
}

async function readAgentsState(page) {
  return page.evaluate(() => {
    const select = document.getElementById('creator-filter');
    return {
      disabled: !select || select.disabled,
      options: !select ? [] : [...select.options].map((option) => option.textContent.trim()),
      shown: (document.getElementById('agents-count') || {}).textContent || '',
      rows: document.querySelectorAll('#agent-list li').length,
      empty: (document.getElementById('agents-empty')?.textContent || '').trim(),
      emptyHidden: document.getElementById('agents-empty')?.hidden,
    };
  });
}

const STATES = {
  default: async () => {},
  // #293: /register and /set-password are public, JS-mounted pages. Each state
  // below only acts on controls that exist on the after arm, so the before arm
  // records their absence (probes count=0) instead of failing the shot.
  'register-code-invalid': async (page) => {
    const submit = page.locator('#email-login-submit');
    if (!(await submit.count())) {
      noteReading(page, 'register-code-invalid skipped: no #email-login-submit on this arm');
      return;
    }
    // Both inputs satisfy the form's own constraints, so the server answers and
    // its refusal is what the status line shows (a native bubble cannot be shot).
    await page.fill('#email-login-address', 'qa.unknown@example.test');
    await page.fill('#email-login-code', '000000');
    const reply = page.waitForResponse((response) => response.url().includes('/v1/auth/email/login/verify')
      && response.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
    await submit.click();
    const response = await reply;
    noteReading(page, `register-code-invalid HTTP ${response ? response.status() : 'no-response'}`);
    await page.waitForFunction(() => (document.getElementById('email-login-status')?.textContent || '').trim().length > 0,
      null, { timeout: 20000 });
  },
  'register-link-sent': async (page) => {
    const send = page.locator('#email-register-send');
    if (!(await send.count())) {
      noteReading(page, 'register-link-sent skipped: no #email-register-send on this arm');
      return;
    }
    // A distinct address per combo keeps the per-email resend window out of the way.
    const email = await page.evaluate(() => `qa.${innerWidth}x${innerHeight}`
      + `.${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}@example.test`);
    await page.fill('#email-register-address', email);
    await page.locator('#email-register-terms').check();
    const reply = page.waitForResponse((response) => response.url().includes('/v1/auth/password/request')
      && response.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
    await send.click();
    const response = await reply;
    noteReading(page, `register-link-sent ${email} HTTP ${response ? response.status() : 'no-response'}`);
    await page.waitForFunction(() => {
      const text = (document.getElementById('email-register-status')?.textContent || '').trim();
      return text && !text.startsWith('正在发送');
    }, null, { timeout: 20000 });
  },
  'register-code-sent': async (page) => {
    const send = page.locator('#email-login-send');
    if (!(await send.count())) {
      noteReading(page, 'register-code-sent skipped: no #email-login-send on this arm');
      return;
    }
    const email = await page.evaluate(() => `login.${innerWidth}x${innerHeight}`
      + `.${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}@example.test`);
    await page.fill('#email-login-address', email);
    const reply = page.waitForResponse((response) => response.url().includes('/v1/auth/email/login/start')
      && response.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
    await send.click();
    const response = await reply;
    noteReading(page, `register-code-sent ${email} HTTP ${response ? response.status() : 'no-response'}`);
    await page.waitForFunction(() => {
      const text = (document.getElementById('email-login-status')?.textContent || '').trim();
      return text && !text.startsWith('正在发送');
    }, null, { timeout: 20000 });
  },
  'password-invalid-token': async (page) => {
    if (!(await page.locator('#set-password-lead').count())) {
      noteReading(page, 'password-invalid-token skipped: no /set-password page on this arm');
      return;
    }
    await page.goto(new URL('/set-password', page.url()).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (document.getElementById('set-password-lead')?.textContent || '')
      .includes('无效或已过期'), null, { timeout: 10000 });
  },
  'password-mismatch': async (page) => {
    if (!(await page.locator('#set-password-form').count())) {
      noteReading(page, 'password-mismatch skipped: no /set-password page on this arm');
      return;
    }
    // The page only shape-checks the token client-side; this placeholder is 43
    // base64url characters, so the form mounts without a real mailed token.
    await page.goto(`${new URL('/set-password', page.url()).href}?token=${'A'.repeat(43)}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const form = document.getElementById('set-password-form');
      return Boolean(form) && !form.hidden;
    }, null, { timeout: 10000 });
    await page.fill('#set-password-value', 'synthetic-passphrase-2026');
    await page.fill('#set-password-confirm', 'synthetic-passphrase-2027');
    await page.click('#set-password-submit');
    await page.waitForFunction(() => (document.getElementById('set-password-status')?.textContent || '')
      .includes('不一致'), null, { timeout: 10000 });
    // Never capture a filled password field: clear both, the status line is the reading.
    await page.fill('#set-password-value', '');
    await page.fill('#set-password-confirm', '');
  },
  // Every signed-in page shares the shell account menu; the 帮助中心 entry
  // lives in its help submenu, so this state opens both levels.
  'account-menu-open': async (page) => {
    await page.locator('#account-menu-button').click();
    await page.waitForSelector('#account-menu:not([hidden])', { timeout: 5000 });
    const helpButton = page.locator('#help-menu-button');
    if (await helpButton.count()) {
      await helpButton.click();
      await page.waitForSelector('#help-menu:not([hidden])', { timeout: 5000 });
    }
  },
  // Clicks the help entry itself, so the pair proves the entry navigates.
  // Before the fix it is a disabled button: the same click goes nowhere, the
  // before arm stays on the route while the after arm lands on /guide.
  'help-clicked': async (page) => {
    if (!(await page.locator('#account-menu:not([hidden])').count())) {
      await page.locator('#account-menu-button').click();
      await page.waitForSelector('#account-menu:not([hidden])', { timeout: 5000 });
    }
    if ((await page.locator('#help-menu-button').count())
      && !(await page.locator('#help-menu:not([hidden])').count())) {
      await page.locator('#help-menu-button').click();
      await page.waitForSelector('#help-menu:not([hidden])', { timeout: 5000 });
    }
    const from = new URL(page.url()).pathname;
    const entry = page.locator('#help-menu a[href="/guide"]').first();
    if (await entry.count()) {
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/guide', { timeout: 15000 }),
        entry.click(),
      ]);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const theme = (await page.evaluate(() => document.documentElement.dataset.themeResolved)) || 'light';
      await waitForShell(page, theme);
      await waitForStableText(page);
      if (new URL(page.url()).pathname !== '/guide') throw new Error('help entry did not reach /guide');
    } else {
      const dead = page.locator('#help-menu button[disabled]').first();
      if (!(await dead.count())) throw new Error('no help-centre entry in #help-menu');
      await dead.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(800);
      if (new URL(page.url()).pathname !== from) throw new Error(`disabled help entry navigated to ${page.url()}`);
    }
  },
  // The chat canvas shows #chat-empty only when the open workspace holds no
  // conversation. The fixture seeds one empty workspace next to the populated
  // one, so this state walks the workspace picker until the empty list shows.
  'chat-empty': async (page) => {
    const empty = page.locator('#chat-empty');
    const shows = async () => empty.count().then((n) => n > 0)
      && (await empty.evaluate((el) => !el.hidden).catch(() => false));
    if (await shows()) return;
    const select = page.locator('#workspace');
    if (!(await select.count())) throw new Error('no #workspace picker on this page');
    const values = await select.locator('option').evaluateAll((options) => options.map((o) => o.value).filter(Boolean));
    for (const value of values) {
      await select.selectOption(value);
      await page.waitForTimeout(300);
      await page.waitForFunction(
        () => !document.getElementById('chat-empty')?.hidden,
        null,
        { timeout: 4000 },
      ).catch(() => {});
      if (await shows()) {
        await waitForStableText(page);
        return;
      }
    }
    throw new Error(`no empty workspace among ${values.length} picker option(s)`);
  },
  'help-menu-open': async (page) => {
    await page.locator('#account-menu-button').click();
    await page.waitForSelector('#account-menu:not([hidden])', { timeout: 5000 });
    const helpButton = page.locator('#help-menu-button');
    if (!(await helpButton.count())) throw new Error('no #help-menu-button on this page');
    await helpButton.click();
    await page.waitForSelector('#help-menu:not([hidden])', { timeout: 5000 });
  },
  // #172/#177: a genuine 409, not a double click. A second tab saves a small
  // change first, so this tab's revision is stale and its save is really
  // rejected: main leaves the server's English text on screen, the fix refills
  // from error.current and shows the Chinese line. Both arms are anchored on
  // #status, which at 768x1024 sits below the first screen.
  'profile-save-409': async (page) => {
    const formReady = async (target) => {
      await target.waitForSelector('#profile-save:not([disabled])', { timeout: 10000 });
      await target.waitForFunction(
        () => (document.getElementById('profile-form')?.elements?.name?.value || '').length > 0,
        null,
        { timeout: 10000 },
      );
    };
    const hasStatus = () => page.waitForFunction(
      () => (document.getElementById('status')?.textContent || '').trim().length > 0,
      null,
      { timeout: 10000 },
    );
    await formReady(page);
    const other = await page.context().newPage();
    try {
      await other.goto(new URL('/profile', page.url()).href, { waitUntil: 'load' });
      await formReady(other);
      await other.evaluate(() => {
        const bio = document.querySelector('#profile-form [name="bio"]');
        if (!bio) throw new Error('no bio field to change in the first tab');
        bio.value = (bio.value || '').endsWith('x') ? 'qa' : 'qax';
      });
      await other.locator('#profile-save').click();
      await other.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').trim().length > 0,
        null,
        { timeout: 10000 },
      );
      await page.locator('#profile-save').click();
      await page.waitForTimeout(1200);
      await hasStatus();
    } finally {
      await page.evaluate(() => {
        const line = document.getElementById('status');
        if (line) window.scrollBy(0, Math.round(line.getBoundingClientRect().top) - 120);
      }).catch(() => {});
      await page.waitForTimeout(200);
      await other.close();
    }
  },
  // #172/#177: the same single save, screenshotted while its POST is still
  // open. Main leaves 保存 clickable (a second click sends a second request);
  // the fix disables it until the request settles.
  'profile-save-saving': async (page) => {
    await page.waitForSelector('#profile-save:not([disabled])', { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById('profile-form')?.elements?.name?.value || '').length > 0,
      null,
      { timeout: 10000 },
    );
    let seen = 0;
    const slow = async (route) => {
      if (route.request().method() === 'POST') {
        seen += 1;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      await route.continue().catch(() => {});
    };
    await page.route('**/v1/profile', slow);
    try {
      await page.evaluate(() => document.getElementById('profile-form').requestSubmit());
      await page.waitForTimeout(300);
      const disabled = await page.locator('#profile-save').evaluate((el) => el.disabled);
      if (disabled && seen === 0) throw new Error('no save request was started');
    } finally {
      await page.unroute('**/v1/profile', slow).catch(() => {});
    }
  },
  // #173/#180: hover the first catalog card on /discover (default tab is the
  // cards tab). The removed /d/<slug> text is a native title tooltip, which the
  // browser never paints into a page screenshot; this state still takes the
  // hover styling, and the title attribute is checked on the live DOM.
  'discover-hover': async (page) => {
    const card = page.locator('#discover-list li article').first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    await card.hover();
    await page.waitForTimeout(600);
    await waitForStableText(page);
  },
  // #175/#181: select the first category chip that has no entries, so the empty
  // line (「没有匹配的指引。」 vs 「这一类还没有指引。」) is the only thing that can differ.
  'guide-empty-category': async (page) => {
    await page.waitForSelector('#guide-categories button.guide-category', { timeout: 15000 });
    const empty = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('#guide-categories button.guide-category')];
      const hit = chips.find((chip) => chip.dataset.category !== 'all'
        && (chip.querySelector('.cat-count')?.textContent || '').trim() === '0');
      return hit ? hit.dataset.category : '';
    });
    if (!empty) throw new Error('no empty category chip on /guide');
    await page.locator(`#guide-categories button.guide-category[data-category="${empty}"]`).click();
    await page.waitForFunction(
      () => !document.getElementById('guide-empty')?.hidden,
      null,
      { timeout: 5000 },
    );
    await waitForStableText(page);
  },
  // #187: /guide?category=calls — the fixed arm opens with the calls chip
  // selected and the list already filtered; the base arm answers the route with
  // a plain-text 400 (Queries not supported), which is the before evidence.
  'guide-category-calls': async (page) => {
    if (!(await page.locator('#guide-categories').count())) {
      const raw = (await page.evaluate(() => document.body?.innerText || '')).trim();
      noteReading(page, `guide-category-calls raw-body="${raw.slice(0, 60)}"`);
      return;
    }
    await page.waitForSelector('#guide-categories button.guide-category', { timeout: 15000 });
    const reading = await page.evaluate(() => ({
      current: document.querySelector('#guide-categories button.guide-category[aria-current="true"]')?.dataset.category || '',
      search: globalThis.location.search,
      count: (document.getElementById('guide-count') || {}).textContent || '',
      rows: document.querySelectorAll('#guide-list .guide-item').length,
    }));
    noteReading(page, `guide-category-calls current=${reading.current} url="${reading.search}" count="${reading.count}" rows=${reading.rows}`);
    await waitForStableText(page);
  },
  // #187 state 2: typing a keyword after landing through ?category=calls keeps
  // the chip on calls and the category in the URL.
  'guide-category-search-kept': async (page) => {
    if (!(await page.locator('#guide-search').count())) {
      noteReading(page, 'guide-category-search-kept skipped: route not served on this arm');
      return;
    }
    await page.locator('#guide-search').fill('通话');
    await page.waitForTimeout(500);
    const reading = await page.evaluate(() => ({
      current: document.querySelector('#guide-categories button.guide-category[aria-current="true"]')?.dataset.category || '',
      search: globalThis.location.search,
      value: document.getElementById('guide-search').value,
      rows: document.querySelectorAll('#guide-list .guide-item').length,
    }));
    noteReading(page, `guide-category-search-kept current=${reading.current} url="${reading.search}" value="${reading.value}" rows=${reading.rows}`);
    if (reading.current !== 'calls') throw new Error(`category chip left calls after typing: ${reading.current || 'none'}`);
    if (!/[?&]category=calls/.test(reading.search)) throw new Error(`URL dropped category=calls: ${reading.search}`);
    await waitForStableText(page);
  },
  // #182 state 1: the 加载更多 control at the bottom of a >20-hit result list.
  // Base caps the list at 20 hits and has no control at all.
  'chat-search-paging': async (page) => {
    await searchFor(page, PAGING_TOKEN);
    await waitForSearchRows(page, 20);
    await page.waitForTimeout(400);
    await anchorSearchBottom(page);
    const reading = await readSearchState(page);
    noteReading(page, `paging rows=${reading.rows} more=${reading.more} empty="${reading.empty}" control=${JSON.stringify(reading.control)} vp=${reading.viewport.w}x${reading.viewport.h}`);
    await waitForStableText(page);
  },
  // #182 state 2: press 加载更多 once, the second page lands (25 rows > 20) and
  // the control goes away because the server has no cursor left.
  'chat-search-more-disabled': async (page) => {
    await searchFor(page, PAGING_TOKEN);
    await waitForSearchRows(page, 20);
    const more = page.locator('#search-more');
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('#search-results li').length > 20,
          null,
          { timeout: 15000 },
        );
      } catch { /* reading below records what actually happened */ }
      try {
        await page.waitForFunction(() => {
          const node = document.getElementById('search-more');
          return !node || node.hidden || node.disabled;
        }, null, { timeout: 15000 });
      } catch { /* same: the reading carries the truth */ }
    }
    await anchorSearchBottom(page);
    const reading = await readSearchState(page);
    noteReading(page, `paged rows=${reading.rows} more=${reading.more} empty="${reading.empty}" control=${JSON.stringify(reading.control)} vp=${reading.viewport.w}x${reading.viewport.h}`);
    await waitForStableText(page);
  },
  // #182 re-check on live main: open a conversation, press 搜索, type a keyword
  // that certainly matches, then quote the panel's own display box, the row
  // count and the 加载更多 control; finally close the panel and send a message.
  'chat-search-a': async (page) => {
    await searchFor(page, PAGING_TOKEN);
    await waitForSearchRows(page, 20);
    await page.waitForTimeout(400);
    const reading = await readSearchState(page);
    const panel = await page.evaluate(() => {
      const node = document.getElementById('search-panel');
      const css = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return {
        hidden: node.hidden,
        display: css.display,
        visibility: css.visibility,
        bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        vp: `${innerWidth}x${innerHeight}`,
      };
    });
    const more = page.locator('#search-more');
    const moreVisible = await more.isVisible().catch(() => false);
    const moreEnabled = await more.isEnabled().catch(() => false);
    noteReading(page, `A panel display=${panel.display} hidden=${panel.hidden} bbox=${JSON.stringify(panel.bbox)} vp=${panel.vp}`);
    noteReading(page, `A rows=${reading.rows} more=${reading.more} moreVisible=${moreVisible} moreEnabled=${moreEnabled} empty="${reading.empty}"`);
    // Close the panel the way a user does, then make sure the conversation is
    // back on screen and the composer still sends.
    await page.locator('#search-close').click({ timeout: 8000 }).catch(() => page.keyboard.press('Escape'));
    const closed = await page.evaluate(() => {
      const node = document.getElementById('search-panel');
      return { hidden: node.hidden, display: getComputedStyle(node).display };
    });
    const group = page.locator('#conversation-list button.session-row', { hasText: 'Group chat' }).first();
    if (await group.count()) {
      await group.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
    const before = await page.locator('#message-list li').count();
    const body = `QA #182 复核 ${panel.vp}`;
    await page.locator('#chat-body').fill(body, { timeout: 8000 });
    const sendState = await page.evaluate(() => {
      const form = document.getElementById('chat-form');
      const button = form?.querySelector('button[type="submit"]');
      const r = button?.getBoundingClientRect();
      return {
        panelHidden: document.getElementById('search-panel')?.hidden,
        buttonDisabled: button?.disabled ?? null,
        buttonBox: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        bodyClass: document.body.className,
      };
    });
    let sendError = '';
    try {
      await page.locator('#chat-form button[type="submit"]').click({ timeout: 8000 });
      await page.waitForFunction((n) => document.querySelectorAll('#message-list li').length > n, before, { timeout: 15000 });
    } catch (error) {
      sendError = String(error.message || error).split('\n')[0].slice(0, 160);
    }
    const after = await page.locator('#message-list li').count();
    const sent = await page.evaluate((text) => [...document.querySelectorAll('#message-list li')]
      .some((li) => (li.textContent || '').includes(text)), body);
    noteReading(page, `A close hidden=${closed.hidden} display=${closed.display}; send panelHidden=${sendState.panelHidden} clickable=${sendState.buttonBox ? 'yes' : 'no'} disabled=${sendState.buttonDisabled} body="${sendState.bodyClass}"`);
    noteReading(page, `A messages before=${before} after=${after} sentVisible=${sent} error="${sendError}"`);
  },
  // #184 state 2: 类目 + 创建人 with an empty intersection. Both arms pick the
  // same category chip, so the pair compares the empty lines, not the scroll.
  'agents-creator-empty': async (page) => {
    await ensureWorkspace(page);
    const select = page.locator('#creator-filter');
    await select.waitFor({ state: 'attached', timeout: 15000 });
    await clickAgentCategory(page, 'design');
    if (await select.evaluate((el) => el.disabled)) {
      // Base keeps the control greyed out: that is the before state, not an error.
      await page.waitForTimeout(300);
      const reading = await readAgentsState(page);
      noteReading(page, `creator-empty(disabled) rows=${reading.rows} empty="${reading.empty}"`);
      return;
    }
    await page.waitForFunction(
      () => document.querySelectorAll('#creator-filter option').length > 1,
      null,
      { timeout: 8000 },
    ).catch(() => {});
    const names = await select.evaluate((el) => [...el.options].map((option) => option.textContent.trim()));
    if (!names.includes('bob')) throw new Error(`no bob in creator filter: ${names.join(', ')}`);
    await select.selectOption({ label: 'bob' });
    await page.waitForTimeout(500);
    const reading = await readAgentsState(page);
    noteReading(page, `creator-empty(design+bob) rows=${reading.rows} empty="${reading.empty}" hidden=${reading.emptyHidden}`);
    await waitForStableText(page);
  },
  // #184 state 1: pick creator alice, whose two agents are the only ones left.
  'agents-creator-filtered': async (page) => {
    await ensureWorkspace(page);
    const select = page.locator('#creator-filter');
    await select.waitFor({ state: 'attached', timeout: 15000 });
    if (await select.evaluate((el) => el.disabled)) {
      // Base keeps the control greyed out: that is the before state, not an error.
      await page.waitForTimeout(300);
      const reading = await readAgentsState(page);
      noteReading(page, `creator-filter(disabled) rows=${reading.rows} shown="${reading.shown}"`);
      return;
    }
    await page.waitForFunction(
      () => document.querySelectorAll('#creator-filter option').length > 1,
      null,
      { timeout: 8000 },
    ).catch(() => {});
    const names = await select.evaluate((el) => [...el.options].map((option) => option.textContent.trim()));
    if (!names.includes('alice')) throw new Error(`no alice in creator filter: ${names.join(', ')}`);
    await select.selectOption({ label: 'alice' });
    await page.waitForTimeout(500);
    const reading = await readAgentsState(page);
    noteReading(page, `creator-filter(alice) rows=${reading.rows} shown="${reading.shown}"`);
    await waitForStableText(page);
  },
  // #191/#174: copy receipt beside 「1. 安装 CLI」 on /runtimes, 连接 tab. The
  // receipt lives 2s, so __shotImmediate makes the frame get taken at once, and
  // the label is read out of the DOM at that moment (the image must show 已复制).
  'runtimes-copy-receipt': async (page) => {
    const tab = page.locator('[data-tab="connect"]');
    await tab.waitFor({ state: 'attached', timeout: 15000 });
    await tab.click();
    await page.waitForSelector('#install-cli-block', { state: 'visible', timeout: 15000 });
    await page.evaluate(() => {
      const block = document.getElementById('install-cli-block');
      if (!block) return;
      block.scrollIntoView({ block: 'start' });
      globalThis.scrollBy(0, -96);
    });
    await page.waitForTimeout(300);
    const box = await page.locator('#install-cli-block').boundingBox();
    const height = page.viewportSize() ? page.viewportSize().height : 0;
    if (!box || box.y < 0 || box.y > height - 120) {
      throw new Error(`install block not in frame: y=${box ? Math.round(box.y) : 'none'} viewport=${height}`);
    }
    const labelBefore = (await page.locator('#copy-install').innerText()).trim();
    await page.locator('#copy-install').click();
    const labelAfter = (await page.locator('#copy-install').innerText()).trim();
    const feedback = await page.evaluate(() => {
      const node = document.getElementById('copy-install-feedback');
      return node ? { text: (node.textContent || '').trim(), hidden: node.hidden } : null;
    });
    noteReading(page, `runtimes-copy-receipt block-y=${Math.round(box.y)} before="${labelBefore}" after="${labelAfter}" feedback=${JSON.stringify(feedback)}`);
    page.__shotImmediate = true;
    if (feedback && labelAfter !== '已复制') throw new Error(`copy receipt missing, button reads "${labelAfter}"`);
    if (feedback && (!feedback.text || feedback.hidden)) throw new Error(`feedback line not shown: ${JSON.stringify(feedback)}`);
    if (!feedback && labelAfter !== '复制') throw new Error(`base copy button changed unexpectedly: "${labelAfter}"`);
  },
};

// The ticket calls the exhausted state `chat-search-more`; the harness key it
// grew from is `chat-search-more-disabled`. Same action, both names resolve.
STATES['chat-search-more'] = STATES['chat-search-more-disabled'];

// #205: /chat on narrow screens. ≤900px the pane is the conversation list until
// a session is opened, and #chat-back returns to it. The base arm cannot reach
// the list at all, so these read the layout instead of asserting it out of the
// run: the honest base picture is the evidence.
async function readChatLayout(page) {
  return page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const display = getComputedStyle(el).display;
      const visible = !el.hidden && display !== 'none' && r.width > 0 && r.height > 0;
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        display, visible,
        cssWidth: getComputedStyle(el).width,
        minWidth: getComputedStyle(el).minWidth,
      };
    };
    const pane = document.getElementById('session-pane');
    const list = document.getElementById('conversation-list');
    const composer = document.querySelector('#chat-form .composer');
    const composerBox = box(composer);
    return {
      vp: `${innerWidth}x${innerHeight}`,
      pane: box(pane),
      main: box(document.getElementById('main-panel')),
      listBox: box(list),
      back: box(document.getElementById('chat-back')),
      rows: list ? list.children.length : 0,
      messages: document.querySelectorAll('#message-list > *').length,
      composer: composerBox,
      composerInView: Boolean(composerBox && composerBox.visible
        && composerBox.y >= -1 && composerBox.y + composerBox.h <= innerHeight + 1),
      title: ((document.getElementById('chat-title') || {}).textContent || '').trim(),
      bodyClass: document.body.className,
      gridColumns: getComputedStyle(document.body).gridTemplateColumns,
    };
  });
}

function noteChatLayout(page, state, r) {
  noteReading(page, `${state} pane=${JSON.stringify(r.pane)} back=${JSON.stringify(r.back)} rows=${r.rows} messages=${r.messages} composerInView=${r.composerInView} title="${r.title}" vp=${r.vp} body="${r.bodyClass}" grid="${r.gridColumns}"`);
  noteReading(page, `${state} main=${JSON.stringify(r.main)} listBox=${JSON.stringify(r.listBox)}`);
}

// The default /chat layout: both columns wide, and the list as the only column
// narrow. At 1440 #chat-back must not be there at all.
async function enterChat(page) {
  // Each state starts at the /chat entry, not where the previous state left the
  // page: the harness keeps one page per combo and the states run in order.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
}

STATES['chat-list'] = async (page) => {
  await enterChat(page);
  await ensureWorkspace(page);
  await page.waitForTimeout(1200);
  const reading = await readChatLayout(page);
  noteChatLayout(page, 'chat-list', reading);
  if (reading.pane && reading.pane.visible && reading.rows < 2) {
    throw new Error(`chat-list: conversation list has ${reading.rows} rows, need ≥2`);
  }
  if (!reading.pane || !reading.pane.visible) {
    noteReading(page, `chat-list unreachable at ${reading.vp}: #session-pane display=${(reading.pane || {}).display} (base hides it)`);
  }
  await waitForStableText(page);
};

// Opening one conversation: the pane must be gone and the message column, with
// its composer, must be the thing on screen.
STATES['chat-session'] = async (page) => {
  await enterChat(page);
  await ensureWorkspace(page);
  await page.waitForTimeout(1200);
  let reading = await readChatLayout(page);
  let clicked = 'none';
  if (reading.pane && reading.pane.visible && reading.rows > 0) {
    const rows = page.locator('#conversation-list li button');
    await rows.first().click({ timeout: 8000 });
    clicked = (await rows.first().textContent().catch(() => '') || '').trim();
    await page.waitForTimeout(900);
    reading = await readChatLayout(page);
  }
  noteChatLayout(page, 'chat-session', reading);
  noteReading(page, `chat-session opened="${clicked}" paneHidden=${!reading.pane.visible}`);
  if (!reading.pane.visible && reading.messages === 0) {
    noteReading(page, `chat-session empty at ${reading.vp}: no message column content (base auto-opens nothing)`);
  }
  await waitForStableText(page);
};

// ‹ back to the list, then a second conversation must still open, then back
// again: the list is reachable more than once, not only on first load.
STATES['chat-back'] = async (page) => {
  await enterChat(page);
  await ensureWorkspace(page);
  await page.waitForTimeout(1200);
  let reading = await readChatLayout(page);
  if (!reading.pane.visible) {
    // The reload may restore the conversation from the hash; ‹ is the way back
    // to the list, which is exactly what this state is about.
    const back = page.locator('#chat-back');
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 8000 });
      await page.waitForTimeout(800);
      reading = await readChatLayout(page);
      noteReading(page, `chat-back start-from-session pane=${JSON.stringify(reading.pane)} rows=${reading.rows}`);
    }
  }
  if (reading.pane && reading.pane.visible && reading.rows > 0) {
    const rows = page.locator('#conversation-list li button');
    await rows.first().click({ timeout: 8000 });
    await page.waitForTimeout(800);
    const back = page.locator('#chat-back');
    if (await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 8000 });
      await page.waitForTimeout(800);
      const listed = await readChatLayout(page);
      noteReading(page, `chat-back after-back pane=${JSON.stringify(listed.pane)} rows=${listed.rows}`);
      if (listed.rows > 1) {
        await page.locator('#conversation-list li button').nth(1).click({ timeout: 8000 });
        await page.waitForTimeout(800);
        const second = await readChatLayout(page);
        noteReading(page, `chat-back second-session paneHidden=${!second.pane.visible} title="${second.title}" messages=${second.messages}`);
        await page.locator('#chat-back').click({ timeout: 8000 });
        await page.waitForTimeout(800);
      }
    } else {
      noteReading(page, `chat-back unreachable at ${reading.vp}: #chat-back not visible`);
    }
  }
  const final = await readChatLayout(page);
  noteChatLayout(page, 'chat-back', final);
  if (!final.back || !final.back.visible) {
    noteReading(page, `chat-back control absent at ${final.vp}: back=${JSON.stringify(final.back)}`);
  }
  await waitForStableText(page);
};

/* /members inline confirmation (#208). The seed already adds bob as a second
 * admin of the fixture team; the removed state really deletes him from that
 * arm's one database, so every members state first puts him back through the
 * same public members API the page itself calls. The re-add lives in the
 * harness, not in either arm's repo, and both arms run it. */
const MEMBER_TARGET = 'bob';

async function readMembersState(page) {
  return page.evaluate(() => {
    const readDialog = (row) => {
      const box = row.querySelector('[role="alertdialog"]');
      if (!box) return null;
      const labelledBy = box.getAttribute('aria-labelledby') || '';
      const r = box.getBoundingClientRect();
      return {
        role: box.getAttribute('role'),
        labelledby: labelledBy,
        question: (box.querySelector('span')?.textContent || '').trim(),
        labelledText: (document.getElementById(labelledBy)?.textContent || '').trim(),
        buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
        box: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)},
      };
    };
    const rows = [...document.querySelectorAll('#member-list li')].map((row) => ({
      label: (row.querySelector('span')?.textContent || '').trim(),
      buttons: [...row.querySelectorAll('button')]
        .filter((b) => !b.dataset.confirmAction).map((b) => b.textContent.trim()),
      dialog: readDialog(row),
    }));
    const list = document.getElementById('member-list');
    const active = document.activeElement;
    return {
      rows,
      count: rows.length,
      status: (document.getElementById('status')?.textContent || '').trim(),
      statusKind: (document.getElementById('status')?.dataset || {}).kind || '',
      active: active ? {
        tag: active.tagName.toLowerCase(),
        id: active.id || '',
        text: (active.textContent || '').trim(),
        confirmAction: (active.dataset || {}).confirmAction || '',
        rowAction: (active.dataset || {}).rowAction || '',
      } : null,
      listVisible: Boolean(list) && list.getBoundingClientRect().height > 0,
      workspace: (document.getElementById('workspace') || {}).value || '',
    };
  });
}

async function addMemberFromPage(page, username) {
  return page.evaluate(async (username) => {
    const select = document.getElementById('workspace');
    const workspaceId = select ? select.value : '';
    const cookie = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('__Host-ot_csrf=') || part.startsWith('ot_dev_csrf='));
    const csrf = cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : '';
    const response = await fetch(`/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
      credentials: 'same-origin',
      body: JSON.stringify({username, role: 'admin'}),
    });
    return {workspaceId, status: response.status, text: (await response.text()).slice(0, 200)};
  }, username);
}

function memberRow(reading, username) {
  return reading.rows.find((row) => row.label.split('·')[0].trim() === username) || null;
}

function noteMembers(page, state, reading) {
  const bob = memberRow(reading, MEMBER_TARGET);
  noteReading(page, `${state} rows=${reading.count} labels=${JSON.stringify(reading.rows.map((r) => r.label))} `
    + `status="${reading.status}" workspace=${reading.workspace} listVisible=${reading.listVisible}`);
  noteReading(page, `${state} ${MEMBER_TARGET}Row=${Boolean(bob)} `
    + `buttons=${JSON.stringify(bob ? bob.buttons : [])} `
    + `dialog=${bob && bob.dialog ? JSON.stringify(bob.dialog) : 'none'} `
    + `active=${JSON.stringify(reading.active)}`);
}

// Fresh load, pin the fixture team, re-add bob through the API, reload so the
// list is rendered from the server, then pin the team once more.
async function enterMembers(page) {
  const reload = async () => {
    await page.reload({waitUntil: 'networkidle', timeout: 20000}).catch(() => {});
    // The panel is filled by an async GET; wait for it before reading the
    // workspace <select>, otherwise the POST would target an empty id.
    await page.waitForFunction(() => {
      const panel = document.getElementById('main-panel');
      const select = document.getElementById('workspace');
      return Boolean(panel) && !panel.hidden && Boolean(select) && select.options.length >= 1;
    }, null, {timeout: 15000});
    await page.waitForTimeout(500);
  };
  await reload();
  await ensureWorkspace(page);
  const added = await addMemberFromPage(page, MEMBER_TARGET);
  await reload();
  await ensureWorkspace(page);
  await page.waitForTimeout(700);
  const reading = await readMembersState(page);
  if (!memberRow(reading, MEMBER_TARGET)) {
    throw new Error(`members: ${MEMBER_TARGET} not listed after re-add (workspace ${added.workspaceId}, `
      + `HTTP ${added.status} ${added.text}, rows=${JSON.stringify(reading.rows.map((r) => r.label))})`);
  }
  return reading;
}

STATES['members-idle'] = async (page) => {
  const reading = await enterMembers(page);
  noteMembers(page, 'members-idle', reading);
  if (reading.count < 2) throw new Error(`members-idle: only ${reading.count} row(s)`);
  await waitForStableText(page);
};

// One click on 移除. The fixed arm opens the inline alertdialog (bob still in
// the list, focus on 取消); the base arm removes bob at once and shows 已移除。
STATES['members-confirm'] = async (page) => {
  await enterMembers(page);
  const row = page.locator('#member-list li').filter({hasText: MEMBER_TARGET}).first();
  await row.getByRole('button', {name: '移除', exact: true}).click({timeout: 8000});
  await page.waitForTimeout(700);
  const reading = await readMembersState(page);
  const bob = memberRow(reading, MEMBER_TARGET);
  const dialog = bob && bob.dialog;
  noteMembers(page, 'members-confirm', reading);
  noteReading(page, `members-confirm question="${dialog ? dialog.question : ''}" `
    + `role=${dialog ? dialog.role : 'none'} labelledby=${dialog ? dialog.labelledby : 'none'} `
    + `labelledText="${dialog ? dialog.labelledText : ''}" `
    + `dialogButtons=${JSON.stringify(dialog ? dialog.buttons : [])} `
    + `box=${JSON.stringify(dialog ? dialog.box : null)} `
    + `active=${JSON.stringify(reading.active)} bobStillListed=${Boolean(bob)} status="${reading.status}"`);
  if (!dialog) {
    noteReading(page, `members-confirm no inline dialog: base removes on the first click (status="${reading.status}")`);
  }
  await waitForStableText(page);
};

// Confirm the removal: the fixed arm clicks 确认 inside the dialog, the base arm
// has nothing to click because the first click already removed bob.
STATES['members-removed'] = async (page) => {
  await enterMembers(page);
  const row = page.locator('#member-list li').filter({hasText: MEMBER_TARGET}).first();
  await row.getByRole('button', {name: '移除', exact: true}).click({timeout: 8000});
  await page.waitForTimeout(400);
  const dialog = page.locator('#member-list [role="alertdialog"]');
  let confirmedInline = false;
  if (await dialog.count()) {
    await dialog.getByRole('button', {name: '确认', exact: true}).click({timeout: 5000});
    confirmedInline = true;
  }
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, {timeout: 8000},
  ).catch(() => {});
  await page.waitForTimeout(900);
  const reading = await readMembersState(page);
  const bob = memberRow(reading, MEMBER_TARGET);
  noteMembers(page, 'members-removed', reading);
  noteReading(page, `members-removed confirmedInline=${confirmedInline} bobStillListed=${Boolean(bob)} `
    + `rows=${reading.count} status="${reading.status}" statusKind=${reading.statusKind} active=${JSON.stringify(reading.active)}`);
  await waitForStableText(page);
};

/* Privacy sweep for the #208 confirm screenshots: walk every text node that is
 * actually painted (ancestor chain visible, non-zero box) and report the whole
 * string set plus anything that looks like an address, phone or token. */
async function privacySweep(page, label) {
  const sweep = await page.evaluate(() => {
    const visible = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0) return false;
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
      }
      return true;
    };
    const base = document.body.getBoundingClientRect();
    const lines = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue || '').trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent)) continue;
      const r = document.createRange();
      r.selectNodeContents(node);
      const box = r.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      lines.push({
        text,
        tag: parent.tagName.toLowerCase() + (parent.id ? '#' + parent.id : ''),
        x: Math.round(box.x - base.x),
        y: Math.round(box.y - base.y),
      });
    }
    const all = lines.map((line) => line.text);
    const emailish = all.filter((t) => /@/.test(t));
    const phoneish = all.filter((t) => /(?:\+?\d[\d\s-]{7,}\d)/.test(t));
    const tokenish = all.filter((t) => /(?:token|secret|api[-_ ]?key|bearer|ghp_|sk-)/i.test(t));
    const inputs = [...document.querySelectorAll('input,textarea')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ id: el.id, value: el.value }));
    const images = [...document.images]
      .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { src: String(el.currentSrc || el.src).slice(-60), alt: el.alt, w: Math.round(r.width), h: Math.round(r.height) };
      });
    return { lines, emailish, phoneish, tokenish, inputs, images, vp: `${innerWidth}x${innerHeight}` };
  });
  noteReading(page, `${label} privacy vp=${sweep.vp} lines=${sweep.lines.length} emailish=${JSON.stringify(sweep.emailish)} `
    + `phoneish=${JSON.stringify(sweep.phoneish)} tokenish=${JSON.stringify(sweep.tokenish)} `
    + `inputs=${JSON.stringify(sweep.inputs)} images=${JSON.stringify(sweep.images)}`);
  for (const line of sweep.lines) {
    noteReading(page, `${label} privacy text ${line.tag}@${line.x},${line.y} "${line.text}"`);
  }
  return sweep;
}

// The three #208 states at 390, swept for anything painted that is not fixture
// copy: /members, its inline confirm, and the post-removal status line.
STATES['members-privacy-idle'] = async (page) => {
  await enterMembers(page);
  await privacySweep(page, 'members-idle');
  await waitForStableText(page);
};

STATES['members-privacy'] = async (page) => {
  await enterMembers(page);
  const row = page.locator('#member-list li').filter({hasText: MEMBER_TARGET}).first();
  await row.getByRole('button', {name: '移除', exact: true}).click({timeout: 8000});
  await page.waitForTimeout(700);
  await privacySweep(page, 'members-confirm');
  await waitForStableText(page);
};

STATES['members-privacy-removed'] = async (page) => {
  await enterMembers(page);
  const row = page.locator('#member-list li').filter({hasText: MEMBER_TARGET}).first();
  await row.getByRole('button', {name: '移除', exact: true}).click({timeout: 8000});
  await page.waitForTimeout(400);
  const dialog = page.locator('#member-list [role="alertdialog"]');
  if (await dialog.count()) {
    await dialog.getByRole('button', {name: '确认', exact: true}).click({timeout: 5000});
  }
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, {timeout: 8000},
  ).catch(() => {});
  await page.waitForTimeout(900);
  await privacySweep(page, 'members-removed');
  await waitForStableText(page);
};

/* #227: 390 search panel. The four states below are read in a LENIENT way on
 * purpose: on the before arm the panel lives inside a display:none session pane,
 * so throwing on the 0x0 box would lose the very evidence we need. Each state
 * still notes the panel's own display/box and its parent's display, and counts
 * rows twice — in the DOM and painted (non-zero box) — because the app renders
 * rows into the hidden list anyway. */
async function enterConversation(page) {
  const row = page.locator('#conversation-list button.session-row').first();
  if (await row.count()) await row.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
}

async function pressSearchButton(page) {
  const button = page.locator('#message-search');
  if (await button.count()) await button.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

// Typing through the DOM keeps working when the input has no box (before arm).
async function typeSearchText(page, text) {
  await page.evaluate((value) => {
    const input = document.getElementById('session-search');
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await page.waitForTimeout(1200);
}

async function readSearchPanel227(page, label) {
  const reading = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const panel = document.getElementById('search-panel');
    const results = document.getElementById('search-results');
    const more = document.getElementById('search-more');
    const rows = [...document.querySelectorAll('#search-results li')];
    const painted = rows.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const visible = (el) => {
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden') return false;
      }
      return true;
    };
    const composer = document.querySelector('#chat-form .composer');
    const messageList = document.getElementById('message-list');
    const send = document.querySelector('#chat-form button[type="submit"]');
    return {
      vp: `${innerWidth}x${innerHeight}`,
      panel: { hidden: panel?.hidden ?? null, display: panel ? getComputedStyle(panel).display : null, box: box(panel) },
      parent: (() => {
        const node = panel?.parentElement;
        if (!node) return null;
        return { tag: `${node.tagName.toLowerCase()}#${node.id}`, display: getComputedStyle(node).display, box: box(node) };
      })(),
      results: box(results),
      rowsDom: rows.length,
      rowsPainted: painted.length,
      more: !more ? 'absent' : (more.hidden ? 'hidden' : (more.disabled ? 'disabled' : 'visible')),
      moreUsable: Boolean(more && !more.hidden && !more.disabled && visible(more)
        && (() => { const r = more.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()),
      moreBox: box(more),
      keyboard: (() => {
        const form = document.getElementById('chat-form');
        return {
          composer: box(composer),
          send: {
            text: (send?.textContent || '').trim(),
            box: box(send),
            disabled: send?.disabled ?? null,
            inView: (() => { const r = send?.getBoundingClientRect?.(); return Boolean(r && r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0); })(),
          },
          messages: messageList ? messageList.querySelectorAll('li').length : 0,
          messagesBox: box(messageList),
          bodyClass: document.body.className,
        };
      })(),
      grid: getComputedStyle(document.body).gridTemplateColumns,
      rail: box(document.getElementById('app-rail') || document.querySelector('nav')),
    };
  });
  noteReading(page, `${label} panel hidden=${reading.panel.hidden} display=${reading.panel.display} bbox=${JSON.stringify(reading.panel.box)} parent=${reading.parent ? `${reading.parent.tag} display=${reading.parent.display} bbox=${JSON.stringify(reading.parent.box)}` : 'none'} vp=${reading.vp}`);
  noteReading(page, `${label} rowsDom=${reading.rowsDom} rowsPainted=${reading.rowsPainted} resultsBbox=${JSON.stringify(reading.results)} more=${reading.more} moreUsable=${reading.moreUsable} moreBox=${JSON.stringify(reading.moreBox)}`);
  noteReading(page, `${label} grid="${reading.grid}" rail=${JSON.stringify(reading.rail)} composer=${JSON.stringify(reading.keyboard.composer)} messages=${reading.keyboard.messages} messagesBox=${JSON.stringify(reading.keyboard.messagesBox)} send=${JSON.stringify(reading.keyboard.send)} body="${reading.keyboard.bodyClass}"`);
  return reading;
}

// 1. list + press 搜索 (the main evidence pair).
STATES['s227-panel'] = async (page) => {
  await enterConversation(page);
  await pressSearchButton(page);
  await readSearchPanel227(page, 's227-panel');
  await waitForStableText(page);
};

// 2. type a keyword that certainly matches the seeded paging messages.
STATES['s227-results'] = async (page) => {
  await enterConversation(page);
  await pressSearchButton(page);
  await typeSearchText(page, PAGING_TOKEN);
  await readSearchPanel227(page, 's227-results');
  await waitForStableText(page);
};

// 3. close the panel and come back to the conversation.
STATES['s227-closed'] = async (page) => {
  await enterConversation(page);
  await pressSearchButton(page);
  const close = page.locator('#search-close');
  if (await close.count()) {
    await close.click({ timeout: 4000 }).catch(async () => {
      await page.evaluate(() => document.getElementById('search-close')?.click());
    });
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(700);
  await readSearchPanel227(page, 's227-closed');
  await waitForStableText(page);
};

// 4. 1440 control: same path, the panel must be laid out and populated.
STATES['s227-wide'] = async (page) => {
  await enterConversation(page);
  await pressSearchButton(page);
  await typeSearchText(page, PAGING_TOKEN);
  await readSearchPanel227(page, 's227-wide');
  await waitForStableText(page);
};

/* #223 artifacts delete confirmation. Every capture creates its own artifact,
 * titled from the combo (viewport/locale/theme), so both arms open the same
 * title from their own database copy and the dialog quotes the same text. The
 * delete POST is counted through a fetch wrapper installed after the editor is
 * open, which is what tells "one click already sent it" (before) from "not yet"
 * (after). */
async function artifactCombo(page) {
  const parts = await page.evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    lang: (navigator.language || 'zh-CN').split('-')[0],
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'd' : 'l',
  }));
  // The title must not encode locale or theme: it is the text the dialog quotes,
  // and a locale-dependent title would fabricate a zh/en difference on a page
  // that has no locale branch.
  return { tag: `${parts.w}x${parts.h} ${parts.lang} ${parts.theme}`, title: `[CI FIXTURE] 样本 ${parts.w}` };
}

async function createArtifactFromPage(page, title) {
  return page.evaluate(async (value) => {
    const select = document.getElementById('workspace');
    const workspaceId = select ? select.value : '';
    const cookie = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('__Host-ot_csrf=') || part.startsWith('ot_dev_csrf='));
    const csrf = cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : '';
    const response = await fetch(`/v1/workspaces/${workspaceId}/artifacts`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        'Idempotency-Key': `qa-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        title: value,
        kind: 'slides',
        slides: { schema: 'openteamily.slides.v1', slides: [{ title: '目标', bullets: ['统一入口'] }] },
      }),
    });
    return { workspaceId, status: response.status, text: (await response.text()).slice(0, 200) };
  }, title);
}

async function artifactReload(page) {
  await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const panel = document.getElementById('main-panel');
    const select = document.getElementById('workspace');
    return Boolean(panel) && !panel.hidden && Boolean(select) && select.options.length >= 1;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await ensureWorkspace(page);
}

async function openArtifactEditor(page, title) {
  await page.waitForFunction((value) => [...document.querySelectorAll('#artifact-list li button')]
    .some((button) => (button.textContent || '').trim() === value), title, { timeout: 20000 });
  await page.locator('#artifact-list li button').filter({ hasText: title }).first().click({ timeout: 8000 });
  await page.waitForFunction(() => {
    const button = document.getElementById('remove-artifact');
    const form = document.getElementById('main-panel');
    return Boolean(button) && !button.hidden && Boolean(form);
  }, null, { timeout: 15000 });
  await page.waitForTimeout(500);
}

// Counted at the network layer: the page binds fetch at mount time, so wrapping
// window.fetch afterwards would miss the request the app actually sends.
function installRemoveCounter(page) {
  if (page.__removeCounterInstalled) return;
  page.__removeCounterInstalled = true;
  page.__removePosts = 0;
  page.on('request', (request) => {
    if (/\/artifacts\/[^/]+\/remove$/.test(request.url())) page.__removePosts += 1;
  });
}

// One click on 删除 that is verified: the before arm answers with the status
// line (it deletes at once), the after arm with the inline alertdialog. A click
// that lands before the editor's own state settles is retried through the same
// element, so the pair never records an accidental no-op.
async function clickRemove(page) {
  await page.locator('#remove-artifact').click({ timeout: 8000 });
  const settled = () => Boolean(document.querySelector('[role="alertdialog"]'))
    || (document.getElementById('status')?.textContent || '').trim().length > 0;
  try {
    await page.waitForFunction(settled, null, { timeout: 4000 });
  } catch {
    noteReading(page, 'clickRemove retry: first click left no dialog and no status');
    await page.evaluate(() => document.getElementById('remove-artifact')?.click());
    await page.waitForFunction(settled, null, { timeout: 6000 }).catch(() => {});
  }
}

async function artifactSetup(page) {
  await artifactReload(page);
  const combo = await artifactCombo(page);
  const created = await createArtifactFromPage(page, combo.title);
  // The three states share one page, so this combo's artifact may already exist
  // from the previous state; the server answers 409 with that title, which is a
  // reuse, not a failure.
  if (created.status === 409) {
    noteReading(page, `artifact "${combo.title}" reused (409 conflict on create)`);
  } else if (created.status !== 201 && created.status !== 200) {
    throw new Error(`artifact create HTTP ${created.status}: ${created.text}`);
  }
  await artifactReload(page);
  await openArtifactEditor(page, combo.title);
  await installRemoveCounter(page);
  await page.evaluate(() => document.getElementById('remove-artifact')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  return combo;
}

async function readArtifactsState(page, label) {
  const reading = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        inView: r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0 && r.height > 0,
      };
    };
    const dialog = document.querySelector('[role="alertdialog"]');
    const question = document.getElementById('remove-artifact-question');
    const labelledby = dialog ? dialog.getAttribute('aria-labelledby') : null;
    const labelled = labelledby ? document.getElementById(labelledby) : null;
    const active = document.activeElement;
    const status = document.getElementById('status');
    const trigger = document.getElementById('remove-artifact');
    return {
      vp: `${innerWidth}x${innerHeight}`,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY: Math.round(scrollY),
      dialog: dialog ? {
        role: dialog.getAttribute('role'),
        labelledby,
        labelledText: labelled ? (labelled.textContent || '').trim() : '',
        question: question ? (question.textContent || '').trim() : '',
        fullText: (dialog.textContent || '').replace(/\s+/g, ' ').trim(),
        buttons: [...dialog.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
        box: box(dialog),
      } : null,
      activeElement: active ? {
        tag: active.tagName.toLowerCase(),
        id: active.id,
        text: (active.textContent || '').trim().slice(0, 30),
      } : null,
      trigger: { hidden: trigger ? trigger.hidden : null, box: box(trigger) },
      status: { text: status ? (status.textContent || '').trim() : '', kind: status ? status.dataset.kind || '' : '' },
      listRows: [...document.querySelectorAll('#artifact-list li')].map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim()),
      editorOpen: !document.getElementById('main-panel')?.hidden
        && Boolean(document.getElementById('remove-artifact')) && !document.getElementById('remove-artifact').hidden,
      removePosts: globalThis.__removePosts === undefined ? 'not-installed' : globalThis.__removePosts,
    };
  });
  noteReading(page, `${label} dialog=${reading.dialog ? `role=${reading.dialog.role} labelledby=${reading.dialog.labelledby} labelledText="${reading.dialog.labelledText}" question="${reading.dialog.question}" buttons=${JSON.stringify(reading.dialog.buttons)} box=${JSON.stringify(reading.dialog.box)}` : 'none'}`);
  noteReading(page, `${label} active=${JSON.stringify(reading.activeElement)} triggerHidden=${reading.trigger.hidden} triggerBox=${JSON.stringify(reading.trigger.box)} status="${reading.status.text}" statusKind=${reading.status.kind} removePosts=${page.__removePosts}`);
  noteReading(page, `${label} vp=${reading.vp} scrollWidth=${reading.scrollWidth} scrollY=${reading.scrollY} editorOpen=${reading.editorOpen} rows=${JSON.stringify(reading.listRows)}`);
  return reading;
}

// 1. editor open, 删除 button in place, no question yet (both arms).
STATES['artifacts-idle'] = async (page) => {
  const combo = await artifactSetup(page);
  noteReading(page, `artifacts-idle title="${combo.title}" tag="${combo.tag}"`);
  await readArtifactsState(page, 'artifacts-idle');
  await waitForStableText(page);
};

// 2. one click on 删除. After: inline question, focus on 取消, nothing sent.
// Before: the same click already removed the artifact (the reading says so).
STATES['artifacts-confirm'] = async (page) => {
  const combo = await artifactSetup(page);
  await clickRemove(page);
  await page.waitForTimeout(1000);
  noteReading(page, `artifacts-confirm title="${combo.title}"`);
  await readArtifactsState(page, 'artifacts-confirm');
  await waitForStableText(page);
};

// 3. confirm (or, on the before arm, the click already did it) → row gone, status line.
STATES['artifacts-removed'] = async (page) => {
  const combo = await artifactSetup(page);
  await clickRemove(page);
  await page.waitForTimeout(600);
  const dialog = page.locator('[role="alertdialog"]');
  let confirmedInline = false;
  if (await dialog.count()) {
    await dialog.getByRole('button', { name: '确认', exact: true }).click({ timeout: 5000 });
    confirmedInline = true;
  }
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, { timeout: 8000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  noteReading(page, `artifacts-removed title="${combo.title}" confirmedInline=${confirmedInline}`);
  await readArtifactsState(page, 'artifacts-removed');
  await waitForStableText(page);
};

/* /automations list rows (#211): the row note must say the schedule in words and
 * never echo the stored kind. The seed adds three schedule kinds to the fixture's
 * own `now` row, so one screenshot holds all four wordings. */
STATES['automations-list'] = async (page) => {
  await ensureWorkspace(page);
  await page.waitForFunction(
    () => document.querySelectorAll('#automation-list li').length >= 4,
    null, {timeout: 20000},
  ).catch(() => {});
  await page.evaluate(() => {
    // Same absolute anchor in both arms: the panel's offset is identical (same
    // header), so the pair differs by the row wording, not by where it scrolled.
    // Clamping at the page bottom is what made the first pass drift, so the
    // anchor keeps the panel ~38% down the viewport, inside both scroll ranges.
    const panel = document.getElementById('list-panel');
    if (!panel) return;
    const top = panel.getBoundingClientRect().top + globalThis.scrollY;
    globalThis.scrollTo(0, Math.max(0, top - Math.round(innerHeight * 0.38)));
  });
  await page.waitForTimeout(400);
  const reading = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        inView: r.top >= -1 && r.bottom <= innerHeight + 1 && r.height > 0,
      };
    };
    const rows = [...document.querySelectorAll('#automation-list li')].map((li) => ({
      title: (li.querySelector('button')?.textContent || '').trim(),
      meta: (li.querySelector('.note')?.textContent || '').trim(),
      box: box(li),
    }));
    return {
      rows,
      listText: (document.getElementById('automation-list')?.innerText || '').trim(),
      panel: box(document.getElementById('list-panel')),
      vp: `${innerWidth}x${innerHeight}`,
      scrollY: Math.round(globalThis.scrollY),
    };
  });
  for (const [index, row] of reading.rows.entries()) {
    noteReading(page, `automations row${index + 1} title="${row.title}" meta="${row.meta}" box=${JSON.stringify(row.box)}`);
  }
  const leaked = ['now', 'later', 'once', 'daily', 'weekly', 'monthly', 'weekdays']
    .filter((word) => new RegExp(`\\b${word}\\b`).test(reading.listText));
  noteReading(page, `automations-list rows=${reading.rows.length} panel=${JSON.stringify(reading.panel)} `
    + `vp=${reading.vp} scrollY=${reading.scrollY} leaked=${JSON.stringify(leaked)}`);
  if (leaked.length) {
    noteReading(page, `automations-list internal kind still in the list text on this arm: ${leaked.join(', ')}`);
  }
  await waitForStableText(page);
};

/* /automations inline confirm (#226). Both destructive controls on the page —
 * 删除 and 取消这次运行 — now replace themselves with an in-place
 * role="alertdialog" and only 确认 / 确认取消 sends the one POST.
 *
 * A queued run is required for 取消这次运行 to exist at all: the scheduler's
 * `now` kind has the stable due slot 0, so one tick per fixture automation leaves
 * exactly one queued run behind (both arm servers run --no-automation-worker, so
 * it stays queued). The title must not encode locale or theme: the page has no
 * locale branch, and the title is visible in the editor, so encoding the locale
 * would fabricate a zh/en difference. Each arm walks the same combo order and
 * keeps its own serial, so both arms open the same "[CI FIXTURE] 排队 NN". */
const QUEUE_FIXTURE_TITLE = '[CI FIXTURE] 排队';
const queueSerials = new Map();
let fixtureUser = '';

function installAutomationCounters(page) {
  if (page.__automationCountersInstalled) return;
  page.__automationCountersInstalled = true;
  page.on('request', (request) => {
    const url = request.url();
    if (/\/automations\/[^/]+\/remove$/.test(url)) page.__removePosts = (page.__removePosts || 0) + 1;
    else if (/\/automations\/[^/]+\/runs\/[^/]+\/cancel$/.test(url)) page.__cancelPosts = (page.__cancelPosts || 0) + 1;
    else if (/\/automations\/tick$/.test(url)) page.__tickPosts = (page.__tickPosts || 0) + 1;
  });
}

function resetAutomationCounters(page) {
  page.__removePosts = 0;
  page.__cancelPosts = 0;
  page.__tickPosts = 0;
}

async function automationPage(page) {
  await page.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => {
    const select = document.getElementById('workspace');
    return Boolean(select) && Boolean(document.getElementById('automation-list'));
  }, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  await ensureWorkspace(page);
  await installAutomationCounters(page);
}

// Create (or reuse, 409) one `now`-kind automation and make sure it holds a
// queued run, so the editor shows 取消这次运行. Everything goes through the page's
// own API so both arms use the same fixture shape.
async function queueFixture(page, title, wantQueued) {
  const result = await page.evaluate(async ({ title, wantQueued, username }) => {
    const workspaceId = document.getElementById('workspace')?.value || '';
    const cookie = document.cookie.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('__Host-ot_csrf=') || part.startsWith('ot_dev_csrf='));
    const csrf = cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : '';
    const call = async (method, route, body, key) => {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (key) headers['Idempotency-Key'] = key;
      const response = await fetch(route, {
        method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed, text: text.slice(0, 200) };
    };
    const runs = async (id) => {
      const response = await fetch(`/v1/workspaces/${workspaceId}/automations/${id}/runs?limit=20`,
        { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      return (body.items || []).map((item) => ({ id: item.id, status: item.status, error_code: item.error_code || '' }));
    };
    const created = await call('POST', `/v1/workspaces/${workspaceId}/automations`, {
      title, prompt: 'CI fixture: inline confirm behaviour only.', template_id: 'custom',
      schedule: { kind: 'now', time_zone: 'Asia/Shanghai' }, participants: [username],
    }, `qa-queue-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    let automation = created.status === 201 && created.body.automation ? created.body.automation : null;
    if (!automation) {
      const listed = await fetch(`/v1/workspaces/${workspaceId}/automations?q=${encodeURIComponent(title)}`,
        { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      const body = await listed.json().catch(() => ({}));
      automation = (body.items || []).find((item) => item.title === title) || null;
    }
    if (!automation) return { workspaceId, created: created.status, error: created.text, automation: null };
    if (!automation.enabled) {
      const enabled = await call('POST', `/v1/workspaces/${workspaceId}/automations/${automation.id}`,
        { revision: automation.revision, changes: { enabled: true } });
      if (enabled.status !== 200) {
        return { workspaceId, created: created.status, error: `enable ${enabled.status} ${enabled.text}`, automation };
      }
      automation = enabled.body.automation || automation;
    }
    let listed = await runs(automation.id);
    let ticked = null;
    if (wantQueued && !listed.some((item) => item.status === 'queued')) {
      const tick = await call('POST', `/v1/workspaces/${workspaceId}/automations/tick`, {});
      ticked = tick.status;
      listed = await runs(automation.id);
    }
    return {
      workspaceId, created: created.status, tick: ticked,
      automation: { id: automation.id, title: automation.title, enabled: automation.enabled },
      runs: listed,
    };
  }, { title, wantQueued, username: fixtureUser });
  if (!result.automation) throw new Error(`automation fixture "${title}": create ${result.created} ${result.error || ''}`);
  return result;
}

async function openAutomationEditor(page, title) {
  await page.waitForFunction((value) => [...document.querySelectorAll('#automation-list li button')]
    .some((button) => (button.textContent || '').trim() === value), title, { timeout: 20000 });
  await page.locator('#automation-list li button').filter({ hasText: title }).first().click({ timeout: 8000 });
  await page.waitForFunction(() => {
    const form = document.getElementById('editor-form');
    return Boolean(form) && !form.hidden;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(700);
}

// One setup per state: reload, make sure this combo's fixture exists (creating it
// on the first state, reusing it afterwards), ensure a queued run when the state
// needs one, then open its editor.
async function automationSetup(page, { queued = false, group = 'queue' } = {}) {
  await automationPage(page);
  const side = page.__side || 'side';
  page.__automationFixtures = page.__automationFixtures || {};
  if (!page.__automationFixtures[group]) {
    const serial = (queueSerials.get(side) || 0) + 1;
    queueSerials.set(side, serial);
    page.__automationFixtures[group] = `${QUEUE_FIXTURE_TITLE} ${String(serial).padStart(2, '0')}`;
  }
  const title = page.__automationFixtures[group];
  const info = await queueFixture(page, title, queued);
  // The list on screen predates the creation, so reload before looking for the row.
  await automationPage(page);
  await openAutomationEditor(page, title);
  if (queued) {
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('#run-list button')]
        .some((button) => (button.textContent || '').trim() === '取消这次运行'), null, { timeout: 8000 });
    } catch {
      noteReading(page, `automationSetup: no 取消这次运行 after tick=${info.tick} runs=${JSON.stringify(info.runs)}`);
    }
    await page.evaluate(() => document.getElementById('run-panel')?.scrollIntoView({ block: 'center' }));
  } else {
    await page.evaluate(() => document.getElementById('remove-automation')?.scrollIntoView({ block: 'center' }));
  }
  await page.waitForTimeout(400);
  return { ...info, title };
}

// A click that is verified: before the change the click already acts (status
// line), after it opens the question. A click that lands too early is retried
// through the same element so a pair never records an accidental no-op.
async function verifiedClick(page, selectorOrLocator, label) {
  const settled = () => Boolean(document.querySelector('[role="alertdialog"]'))
    || (document.getElementById('status')?.textContent || '').trim().length > 0;
  if (typeof selectorOrLocator === 'string') {
    await page.locator(selectorOrLocator).first().click({ timeout: 8000 });
  } else {
    await selectorOrLocator.first().click({ timeout: 8000 });
  }
  try {
    await page.waitForFunction(settled, null, { timeout: 4000 });
  } catch {
    noteReading(page, `${label} retry: first click left no dialog and no status`);
    if (typeof selectorOrLocator === 'string') {
      await page.evaluate((sel) => document.querySelector(sel)?.click(), selectorOrLocator);
    } else {
      await page.evaluate(() => [...document.querySelectorAll('#run-list button')]
        .find((button) => (button.textContent || '').trim() === '取消这次运行')?.click());
    }
    await page.waitForFunction(settled, null, { timeout: 6000 }).catch(() => {});
  }
}

async function readAutomationsConfirm(page, label) {
  const reading = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        inView: r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0 && r.height > 0,
      };
    };
    const dialog = document.querySelector('[role="alertdialog"]');
    const labelledby = dialog ? dialog.getAttribute('aria-labelledby') : null;
    const labelled = labelledby ? document.getElementById(labelledby) : null;
    const active = document.activeElement;
    const status = document.getElementById('status');
    const remove = document.getElementById('remove-automation');
    return {
      vp: `${innerWidth}x${innerHeight}`,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY: Math.round(scrollY),
      dialog: dialog ? {
        role: dialog.getAttribute('role'),
        labelledby,
        labelledText: labelled ? (labelled.textContent || '').trim() : '',
        buttons: [...dialog.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
        box: box(dialog),
      } : null,
      activeElement: active ? {
        tag: active.tagName.toLowerCase(), id: active.id, text: (active.textContent || '').trim().slice(0, 30),
      } : null,
      remove: { hidden: remove ? remove.hidden : null, box: box(remove) },
      status: { text: status ? (status.textContent || '').trim() : '', kind: status ? status.dataset.kind || '' : '' },
      titleValue: (document.querySelector('#editor-form input[name="title"]')?.value || '').trim(),
      editorOpen: !document.getElementById('editor-form')?.hidden,
      listVisible: !document.getElementById('list-panel')?.hidden,
      runPanel: {
        hidden: document.getElementById('run-panel')?.hidden,
        box: box(document.getElementById('run-panel')),
      },
      runRows: [...document.querySelectorAll('#run-list li')].map((li) => ({
        status: (li.querySelector('strong')?.textContent || '').trim(),
        note: (li.querySelector('.note')?.textContent || '').trim(),
        hasCancel: [...li.querySelectorAll('button')].some((button) => (button.textContent || '').trim() === '取消这次运行'),
        box: box(li),
      })),
      listRows: [...document.querySelectorAll('#automation-list li')].map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim()),
    };
  });
  noteReading(page, `${label} dialog=${reading.dialog ? `role=${reading.dialog.role} labelledby=${reading.dialog.labelledby} labelledText="${reading.dialog.labelledText}" buttons=${JSON.stringify(reading.dialog.buttons)} box=${JSON.stringify(reading.dialog.box)}` : 'none'}`);
  noteReading(page, `${label} active=${JSON.stringify(reading.activeElement)} removeHidden=${reading.remove.hidden} removeBox=${JSON.stringify(reading.remove.box)} status="${reading.status.text}" statusKind=${reading.status.kind}`);
  noteReading(page, `${label} posts remove=${page.__removePosts || 0} cancel=${page.__cancelPosts || 0} tick=${page.__tickPosts || 0} vp=${reading.vp} scrollWidth=${reading.scrollWidth} scrollY=${reading.scrollY}`);
  noteReading(page, `${label} title="${reading.titleValue}" editorOpen=${reading.editorOpen} listVisible=${reading.listVisible} runPanelHidden=${reading.runPanel.hidden} runRows=${JSON.stringify(reading.runRows)}`);
  return reading;
}

// 1. Editor open: 删除 in place, the queued run's 取消这次运行 in place, no question.
STATES['automations-idle'] = async (page) => {
  const info = await automationSetup(page, { queued: true, group: 'queue' });
  resetAutomationCounters(page);
  noteReading(page, `automations-idle title="${info.title}" created=${info.created} tick=${info.tick} runs=${JSON.stringify(info.runs)}`);
  await readAutomationsConfirm(page, 'automations-idle');
  await waitForStableText(page);
};

// 2. One click on 取消这次运行. After: inline question, focus on 取消, nothing sent.
// Before: the same click already cancelled the run.
STATES['run-cancel'] = async (page) => {
  const info = await automationSetup(page, { queued: true, group: 'queue' });
  resetAutomationCounters(page);
  await verifiedClick(page, '#run-list button', 'run-cancel');
  await page.waitForTimeout(1000);
  noteReading(page, `run-cancel title="${info.title}"`);
  await readAutomationsConfirm(page, 'run-cancel');
  await waitForStableText(page);
};

// 3. Confirm the cancellation (before: the click already did it) → 已取消。 + run 已取消.
STATES['run-cancelled'] = async (page) => {
  const info = await automationSetup(page, { queued: true, group: 'cancel' });
  resetAutomationCounters(page);
  await verifiedClick(page, '#run-list button', 'run-cancelled');
  await page.waitForTimeout(600);
  const dialog = page.locator('[role="alertdialog"]');
  let confirmedInline = false;
  if (await dialog.count()) {
    await dialog.getByRole('button', { name: '确认取消', exact: true }).click({ timeout: 5000 });
    confirmedInline = true;
  }
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, { timeout: 8000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);
  noteReading(page, `run-cancelled title="${info.title}" confirmedInline=${confirmedInline}`);
  await readAutomationsConfirm(page, 'run-cancelled');
  await waitForStableText(page);
};

// 4. One click on 删除. After: inline question, focus on 取消, nothing sent.
// Before: the same click already removed the automation and returned to the list.
STATES['automations-confirm'] = async (page) => {
  const info = await automationSetup(page, { queued: false, group: 'delete' });
  resetAutomationCounters(page);
  await verifiedClick(page, '#remove-automation', 'automations-confirm');
  await page.waitForTimeout(1000);
  noteReading(page, `automations-confirm title="${info.title}"`);
  await readAutomationsConfirm(page, 'automations-confirm');
  await waitForStableText(page);
};

// 5. Confirm the deletion (before: already gone) → back to the list, 已删除。.
STATES['automations-removed'] = async (page) => {
  const info = await automationSetup(page, { queued: false, group: 'delete' });
  resetAutomationCounters(page);
  await verifiedClick(page, '#remove-automation', 'automations-removed');
  await page.waitForTimeout(600);
  const dialog = page.locator('[role="alertdialog"]');
  let confirmedInline = false;
  if (await dialog.count()) {
    await dialog.getByRole('button', { name: '确认', exact: true }).click({ timeout: 5000 });
    confirmedInline = true;
  }
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, { timeout: 8000 },
  ).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  noteReading(page, `automations-removed title="${info.title}" confirmedInline=${confirmedInline}`);
  await readAutomationsConfirm(page, 'automations-removed');
  await waitForStableText(page);
};

/* /memory 我的资料 「偏好」 block (#230). The three states are one visit: the
 * list lives in page state only, so pref-add builds on pref-empty and pref-list
 * builds on pref-add. A POST log counts every /v1/ POST the page sends after the
 * counter is reset, which is how "保存真的发了请求" would be proven — or, as here,
 * shown to be 0 because the block keeps a local array. The before arm has no
 * 偏好 block at all, so every reading is lenient: absent is a reading, not a
 * crash. */
const PREFERENCE_TEXTS = ['回复用中文', '结论先行', '少用感叹号'];

function installPostLog(page) {
  if (page.__postLogInstalled) return;
  page.__postLogInstalled = true;
  page.__postLog = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const url = request.url();
    if (/\/v1\//.test(url)) page.__postLog.push(url.replace(/^https?:\/\/[^/]+/, ''));
  });
}

function resetPostLog(page) {
  page.__postLog = [];
}

async function enterPreferences(page) {
  await page.waitForFunction(() => Boolean(document.getElementById('profile-panel')), null, { timeout: 20000 })
    .catch(() => {});
  await ensureWorkspace(page);
  let shown = await page.evaluate(() => {
    const panel = document.getElementById('profile-panel');
    return Boolean(panel) && !panel.hidden;
  });
  if (!shown) {
    const link = page.locator('a[data-view="profile"]').first();
    if (await link.count()) {
      await link.click({ timeout: 8000 }).catch(() => {});
      await page.waitForFunction(() => {
        const panel = document.getElementById('profile-panel');
        return Boolean(panel) && !panel.hidden;
      }, null, { timeout: 10000 }).catch(() => {});
      shown = await page.evaluate(() => {
        const panel = document.getElementById('profile-panel');
        return Boolean(panel) && !panel.hidden;
      });
    }
  }
  await page.waitForTimeout(700);
  installPostLog(page);
  await bringPreferenceIntoView(page);
  return shown;
}

async function addPreference(page, text) {
  const box = page.locator('#preference-input');
  if (!(await box.count())) return { skipped: 'no #preference-input' };
  await box.fill(text, { timeout: 8000 });
  await page.locator('#add-preference').click({ timeout: 8000 });
  await page.waitForTimeout(600);
  return { added: text };
}

// #profile-panel is the scroller (overflow:auto, min-height:0), so the document
// never scrolls: scrollY stays 0 and window.scrollTo does nothing. Scroll that
// panel instead, keeping the block ~70px below its top. On the before arm the
// block does not exist, so the panel is parked at its bottom, which is the same
// region the block is added to.
async function bringPreferenceIntoView(page) {
  await page.evaluate(() => {
    const pref = document.getElementById('preference-panel');
    const scroller = document.getElementById('profile-panel');
    if (!scroller) return;
    if (!pref) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    // At 390 the panel's own box is only ~140px tall (pre-existing: the same on
    // the base arm), so a 227–346px block never fits. Park whichever part the
    // state is about at the top: the rows once there are any, otherwise the
    // title/empty line.
    const list = document.getElementById('preference-list');
    const rows = list ? list.children.length : 0;
    const target = rows > 0 && list ? list : pref;
    const a = target.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    scroller.scrollTop += Math.round(a.top - b.top) - (rows > 0 ? 24 : 10);
  });
  await page.waitForTimeout(350);
}

async function readPreferences(page, label) {
  await bringPreferenceIntoView(page);
  const reading = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        inView: r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0 && r.height > 0,
      };
    };
    const text = (id) => (document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
    const panel = document.getElementById('preference-panel');
    const rows = [...document.querySelectorAll('#preference-list li')].map((li) => ({
      text: (li.querySelector('.preference-text')?.textContent || li.textContent || '').replace(/\s+/g, ' ').trim(),
      actions: [...li.querySelectorAll('button')].map((button) => (button.textContent || '').trim()),
      box: box(li),
    }));
    const empty = document.getElementById('preferences-empty');
    return {
      vp: `${innerWidth}x${innerHeight}`,
      scrollWidth: document.documentElement.scrollWidth,
      scrollY: Math.round(scrollY),
      profileShown: Boolean(document.getElementById('profile-panel')) && !document.getElementById('profile-panel').hidden,
      panelPresent: Boolean(panel),
      panelBox: box(panel),
      scrollerBox: box(document.getElementById('profile-panel')),
      title: text('preference-title'),
      note: panel ? (panel.querySelector('p.note')?.textContent || '').replace(/\s+/g, ' ').trim() : '',
      emptyText: empty ? (empty.textContent || '').trim() : null,
      emptyHidden: empty ? empty.hidden : null,
      rows,
      addButton: (document.getElementById('add-preference')?.textContent || '').trim(),
      inputValue: (document.getElementById('preference-input')?.value ?? null),
      status: text('preference-status'),
      profileStatus: text('memory-profile-status'),
      viewTitle: text('view-title'),
      ancestors: (() => {
        const out = [];
        let node = panel;
        while (node && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          out.push({
            tag: `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}`,
            oy: cs.overflowY, sh: node.scrollHeight, ch: node.clientHeight, st: Math.round(node.scrollTop),
          });
          node = node.parentElement;
        }
        return out;
      })(),
    };
  });
  noteReading(page, `${label} present=${reading.panelPresent} profileShown=${reading.profileShown} title="${reading.title}" empty="${reading.emptyText}" emptyHidden=${reading.emptyHidden} note="${reading.note}"`);
  noteReading(page, `${label} rows=${reading.rows.length} ${JSON.stringify(reading.rows)} addButton="${reading.addButton}" status="${reading.status}" posts=${JSON.stringify(page.__postLog)}`);
  noteReading(page, `${label} vp=${reading.vp} scrollWidth=${reading.scrollWidth} scrollY=${reading.scrollY} panelBox=${JSON.stringify(reading.panelBox)} scroller=${JSON.stringify(reading.scrollerBox)}`);
  noteReading(page, `${label} ancestors=${JSON.stringify(reading.ancestors)}`);
  return reading;
}

// 1. First visit to 我的资料: the 偏好 block's empty state, word for word.
STATES['pref-empty'] = async (page) => {
  await enterPreferences(page);
  resetPostLog(page);
  await readPreferences(page, 'pref-empty');
  await waitForStableText(page);
};

// 2. Type one preference and press 添加偏好: the row appears, and the POST log
// says whether anything left the page.
STATES['pref-add'] = async (page) => {
  await enterPreferences(page);
  resetPostLog(page);
  const added = await addPreference(page, PREFERENCE_TEXTS[0]);
  noteReading(page, `pref-add ${JSON.stringify(added)}`);
  await bringPreferenceIntoView(page);
  await page.waitForTimeout(400);
  await readPreferences(page, 'pref-add');
  await waitForStableText(page);
};

// 3. Three rows in the list: the shape a user sees once it has a few entries.
STATES['pref-list'] = async (page) => {
  await enterPreferences(page);
  resetPostLog(page);
  for (const text of PREFERENCE_TEXTS) {
    const existing = await page.evaluate(() => [...document.querySelectorAll('#preference-list .preference-text')]
      .map((node) => (node.textContent || '').trim()));
    if (existing.includes(text)) continue;
    await addPreference(page, text);
  }
  await bringPreferenceIntoView(page);
  await page.waitForTimeout(500);
  await readPreferences(page, 'pref-list');
  await waitForStableText(page);
};

// The must-fix face of the new tip: a question opened on one automation must not
// follow you to another row. Open 删除, go back to the list, open a different
// automation, and read whether the question is still there and whether its
// trigger is still the one that asked.
STATES['automations-confirm-crossrow'] = async (page) => {
  const info = await automationSetup(page, {queued: false, group: 'delete'});
  resetAutomationCounters(page);
  await verifiedClick(page, '#remove-automation', 'automations-confirm-crossrow');
  await page.waitForTimeout(500);
  const dialogBeforeBack = await page.locator('[role="alertdialog"]').count();
  // Before the question exists the click already deleted the automation, so the
  // editor is gone and 返回列表 is not there to press; being on the list is the
  // same starting point for the cross-row read.
  const editorOpen = await page.evaluate(() => {
    const form = document.getElementById('editor-form');
    return Boolean(form) && !form.hidden;
  });
  if (editorOpen) {
    await page.locator('#cancel-editor').click({ timeout: 8000 });
  }
  await page.waitForFunction(() => {
    const list = document.getElementById('list-panel');
    return Boolean(list) && !list.hidden;
  }, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const picked = await page.evaluate((fixtureTitle) => {
    const buttons = [...document.querySelectorAll('#automation-list li button')];
    const other = buttons.find((button) => (button.textContent || '').trim() !== fixtureTitle);
    if (!other) return null;
    const title = (other.textContent || '').trim();
    other.click();
    return title;
  }, info.title);
  await page.waitForTimeout(600);
  await page.waitForFunction(() => {
    const form = document.getElementById('editor-form');
    return Boolean(form) && !form.hidden;
  }, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('remove-automation')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  noteReading(page, `automations-confirm-crossrow previous="${info.title}" opened="${picked}" dialogBeforeBack=${dialogBeforeBack}`);
  await readAutomationsConfirm(page, 'automations-confirm-crossrow');
  await waitForStableText(page);
};

async function loadStates(names) {
  const file = argValue('--state-file');
  const table = { ...STATES };
  if (file) Object.assign(table, (await import(path.resolve(file))).states || {});
  const missing = names.filter((name) => !table[name]);
  if (missing.length) die(`unknown state(s): ${missing.join(', ')} (built-in: ${Object.keys(table).join(', ')})`);
  return names.map((name) => ({ name, run: table[name] }));
}

// Screenshots are attached to public evidence branches, so refuse to capture a
// page whose visible text carries a credential, an invite/approval link or a
// personal address. The seed only knows a username, so any hit is real.
const SECRET_TEXT_PATTERNS = [
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/],
  ['secret in a URL query', /https?:\/\/\S*[?&](?:token|ticket|key|code|secret)=[^\s&]+/i],
  ['invite or approval link', /https?:\/\/\S*(?:invite|approve|claim|verif)\S*/i],
  ['session or csrf value', /\b(?:session|csrf|ot)_?(?:token|cookie|id)=[A-Za-z0-9._~+/=-]{8,}/i],
];

async function assertSafeToCapture(page) {
  const filled = await page.$$eval('input[type="password"]',
    (inputs) => inputs.map((input) => input.value).filter(Boolean));
  if (filled.length) throw new Error('a password field is not empty; refusing to screenshot');
  const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
  for (const [name, pattern] of SECRET_TEXT_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) {
      const at = Math.max(0, (hit.index || 0) - 40);
      throw new Error(`page text carries a ${name} (…${text.slice(at, at + 120)}…); refusing to screenshot`);
    }
  }
}

async function waitForShell(page, theme) {
  await page.waitForFunction(() => {
    const doc = document.documentElement;
    return doc.dataset.themeResolved !== undefined || document.body?.dataset?.themeResolved !== undefined;
  }, null, { timeout: 5000 }).catch(() => {});
  const applied = await page.evaluate(() => document.documentElement.dataset.themeResolved || '');
  if (applied && applied !== theme) {
    throw new Error(`theme resolved to ${applied}, expected ${theme}`);
  }
  await page.waitForTimeout(150);
}

/**
 * The seeded pages fill lists and transcripts from /v1 fetches after load;
 * networkidle can fire before the last render. Wait until the visible text
 * length stops changing so before/after do not race different render states.
 */
async function waitForStableText(page) {
  let last = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const length = await page.evaluate(() => document.body?.innerText.length || 0);
    if (length === last && length > 0) {
      stable += 1;
      if (stable >= 3) return;
    } else {
      stable = 0;
      last = length;
    }
    await page.waitForTimeout(120);
  }
}

function compareText(a, b) {
  const left = a.split('\n').map((line) => line.trim()).filter(Boolean);
  const right = b.split('\n').map((line) => line.trim()).filter(Boolean);
  const rightSet = new Map();
  for (const line of right) rightSet.set(line, (rightSet.get(line) || 0) + 1);
  const sample = [];
  let changedLines = 0;
  for (const line of left) {
    const count = rightSet.get(line) || 0;
    if (count > 0) {
      rightSet.set(line, count - 1);
    } else {
      changedLines += 1;
      if (sample.length < 5) sample.push(line);
    }
  }
  for (const [line, count] of rightSet) {
    if (count > 0) {
      changedLines += count;
      if (sample.length < 5) sample.push(`+${line}`);
    }
  }
  return { changedLines, sample };
}

/** Pixel diff in the same Chromium, so no extra image dependency is needed. */
async function diffPair(page, beforeFile, afterFile) {
  const before = fs.readFileSync(beforeFile).toString('base64');
  const after = fs.readFileSync(afterFile).toString('base64');
  return page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = `data:image/png;base64,${src}`;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: true, before: [ia.width, ia.height], after: [ib.width, ib.height] };
    }
    const canvas = document.createElement('canvas');
    canvas.width = ia.width;
    canvas.height = ia.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(ia, 0, 0);
    const da = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(ib, 0, 0);
    const db = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0;
    // Split at the 90px rail so a nav-only difference can be told apart from a
    // content difference (both arms keep the same rail width in this app).
    const RAIL = 90;
    let changedRail = 0;
    let changedContent = 0;
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (let i = 0; i < da.length; i += 4) {
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
        changed += 1;
        const pixel = i / 4;
        const x = pixel % canvas.width;
        if (x < RAIL) changedRail += 1; else changedContent += 1;
        const y = Math.floor(pixel / canvas.width);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const total = canvas.width * canvas.height;
    return {
      sizeMismatch: false,
      width: canvas.width,
      height: canvas.height,
      total,
      changed,
      ratio: changed / total,
      rail: {changed: changedRail, ratio: changedRail / (Math.min(RAIL, canvas.width) * canvas.height)},
      content: {
        changed: changedContent,
        ratio: changedContent / (Math.max(1, canvas.width - RAIL) * canvas.height),
      },
      bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    };
  }, { a: before, b: after });
}

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0, bytes: buffer.length };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const slug = argValue('--slug');
  if (!slug) die('--slug is required');
  const beforeArg = argValue('--before');
  const afterArg = argValue('--after');
  const baseUrl = argValue('--base-url');
  const outRoot = path.resolve(argValue('--out', '.shots'));
  const routes = argList('--routes', ['/']);
  const viewports = argList('--viewports', ['1440x900', '390x844']).map(viewportFrom);
  const locales = argList('--locales', ['zh-CN', 'en']);
  const themes = argList('--themes', ['light', 'dark']);
  const stateNames = argList('--states', ['default']);
  const probeSelectors = argValue('--probes', '').split(';').map((item) => item.trim()).filter(Boolean);
  const fullPage = hasFlag('--full-page');
  const registerAllowed = hasFlag('--register');
  const timeout = Number(argValue('--timeout', '20000'));
  const waitUntil = argValue('--wait-until', 'networkidle');
  const startTimeout = Number(argValue('--start-timeout', '180000'));
  const skipDiff = hasFlag('--no-diff');
  // A route that is SUPPOSED to answer 4xx on one arm (a before-state evidence
  // page) still gets captured; the status is recorded, not treated as a crash.
  const allowedStatuses = argList('--allow-status', []).map(Number).filter((code) => code >= 400);
  // A route that does not exist yet answers 404 with a 9-character "Not found"
  // body; that page is the reading, so its short text must not fail the shot.
  const minText = Number(argValue('--min-text', '20'));
  const grantClipboard = hasFlag('--grant-clipboard');
  const anonymous = hasFlag('--anonymous');
  const flatNames = hasFlag('--flat');
  preferredWorkspaceLabel = argValue('--workspace-name', '');
  // /chat reads the workspace from the hash; pinning it there avoids the
  // workspace <select> (not rendered at 390) and its change handler.
  preferredWorkspaceId = argValue('--workspace-id', '');

  const specs = [];
  if (beforeArg) specs.push({ name: 'before', value: beforeArg, port: Number(argValue('--before-port', '8101')) });
  if (afterArg) specs.push({ name: 'after', value: afterArg, port: Number(argValue('--after-port', '8102')) });
  if (!specs.length && baseUrl) {
    specs.push({ name: argValue('--side-name', 'current'), value: baseUrl, port: 0 });
  }
  if (!specs.length) die('give --before and/or --after, or --base-url');

  const states = await loadStates(stateNames);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || argValue('--browser') || undefined;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath });
  const results = [];
  const sides = [];
  const started = Date.now();

  try {
    const trees = new Map();
    const refSpecs = specs.filter((spec) => !isHttpUrl(spec.value));
    let seed = null;
    if (refSpecs.length) {
      const seedTree = await ensureWorktree(refSpecs[0].name, refSpecs[0].value);
      trees.set(refSpecs[0].name, seedTree);
      seed = await seedFixtures(seedTree, startTimeout, browser);
      fixtureUser = (seed.login && seed.login.username) || '';
      if (!preferredWorkspaceId) preferredWorkspaceId = seed.ready.workspace_id;
    }
    for (const spec of specs) {
      if (isHttpUrl(spec.value)) {
        sides.push({ name: spec.name, url: spec.value.replace(/\/+$/, ''), login: envLogin() });
      } else {
        let tree = trees.get(spec.name);
        if (!tree) {
          tree = await ensureWorktree(spec.name, spec.value);
          trees.set(spec.name, tree);
        }
        sides.push(await startServerSide({
          name: spec.name, ref: spec.value, port: spec.port, tree,
          seedData: seed.dataDir, login: seed.login, timeoutMs: startTimeout,
        }));
      }
    }

    // One sign-in per side, reused by every context: the app rate-limits
    // logins per username and per peer address, so a login per viewport
    // would trip 429 by design.
    const auth = new Map();
    for (const side of sides) {
      if (anonymous) {
        auth.set(side.name, { storageState: undefined, csrf: '' });
        continue;
      }
      const authContext = await browser.newContext();
      const csrf = await signIn(authContext, side.url, side.login, registerAllowed);
      auth.set(side.name, { storageState: await authContext.storageState(), csrf });
      await authContext.close();
    }
    // Interleave the two sides inside each combo so time-dependent state (a
    // runtime heartbeat, a countdown, a worker tick) is seconds apart instead
    // of minutes; only the code under test should differ.
    for (const viewport of viewports) {
      for (const locale of locales) {
        for (const theme of themes) {
          for (const side of sides) {
            const { storageState, csrf } = auth.get(side.name);
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              colorScheme: theme,
              locale,
              deviceScaleFactor: 1,
              storageState,
              ...(grantClipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
            });
            context.setDefaultTimeout(timeout);
            try {
              if (!anonymous) await applyPreferences(context, side.url, csrf, { locale, theme });
              const page = await context.newPage();
              page.__side = side.name;
              page.__logs = [];
              page.on('console', (msg) => {
                if (msg.type() === 'error' || msg.type() === 'warning') page.__logs.push(`${msg.type()}: ${msg.text()}`);
              });
              page.on('pageerror', (err) => page.__logs.push(`pageerror: ${err.message}`));
              for (const route of routes) {
                let target = side.url + (route.startsWith('/') ? route : `/${route}`);
                if (preferredWorkspaceId && !target.includes('#') && /^(\/chat)(\/|\?|$)/.test(route)) {
                  target += `#workspace=${preferredWorkspaceId}`;
                }
                const response = await page.goto(target, { waitUntil, timeout });
                const status = response ? response.status() : 0;
                if (!status || (status >= 400 && !allowedStatuses.includes(status))) {
                  throw new Error(`GET ${route} HTTP ${status}`);
                }
                if (status < 400) await waitForShell(page, theme);
                else await page.waitForTimeout(200);
                await waitForStableText(page);
                for (const state of states) {
                  page.__facts = null;
                  await state.run(page);
                  // A state whose evidence is a 2s transient sets __shotImmediate
                  // so the frame is taken at once instead of after the text settles.
                  if (!page.__shotImmediate) await waitForStableText(page);
                  page.__shotImmediate = false;
                  await assertSafeToCapture(page);
                  const dir = path.join(outRoot, slug, side.name);
                  fs.mkdirSync(dir, { recursive: true });
                  const suffix = state.name === 'default' ? '' : `__${safePart(state.name)}`;
                  const file = flatNames
                    ? `${safePart(slug)}__${side.name}__${safePart(locale)}__${safePart(theme)}__${safePart(viewport.label)}__${routeToName(route)}${suffix}.png`
                    : `${safePart(locale)}__${safePart(theme)}__${safePart(viewport.label)}__${routeToName(route)}${suffix}.png`;
                  const full = path.join(dir, file);
                  await page.screenshot({ path: full, fullPage, animations: 'disabled' });
                  const png = pngSize(full);
                  const digest = sha256File(full);
                  const text = (await page.evaluate(() => document.body?.innerText || '')).trim();
                  if (text.length < minText) throw new Error(`page ${route} rendered almost no text`);
                  const genericFacts = await page.evaluate(() => ({
                    vp: `${innerWidth}x${innerHeight}`,
                    scrollWidth: document.documentElement.scrollWidth,
                    lang: document.documentElement.lang || '',
                    theme: document.documentElement.dataset.themeResolved || '',
                    darkAttr: document.body.hasAttribute('data-ds-dark-theme') ? 'body'
                      : (document.documentElement.hasAttribute('data-ds-dark-theme') ? 'html' : 'none'),
                    dswBgBase: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
                    btMain: getComputedStyle(document.body).getPropertyValue('--bt-main').trim(),
                    textStart: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
                    textLength: (document.body?.innerText || '').length,
                    visibleDialogs: [...document.querySelectorAll('[role="dialog"], dialog[open]')]
                      .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).length,
                  })).catch(() => null);
                  const probeFacts = probeSelectors.length ? await page.evaluate((sels) => {
                    const painted = (node) => {
                      if (!node) return false;
                      const box = node.getBoundingClientRect();
                      if (!(box.width > 0 && box.height > 0)) return false;
                      for (let up = node; up; up = up.parentElement) {
                        const st = getComputedStyle(up);
                        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
                      }
                      return true;
                    };
                    return sels.map((sel) => {
                      const found = [...document.querySelectorAll(sel)];
                      const node = found[0];
                      const box = node ? node.getBoundingClientRect() : null;
                      return {
                        sel,
                        count: found.length,
                        visible: painted(node),
                        text: node ? String(node.innerText || node.value || node.getAttribute('aria-label') || '').trim().slice(0, 160) : '',
                        disabled: node && 'disabled' in node ? node.disabled === true : null,
                        rect: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
                      };
                    });
                  }, probeSelectors).catch(() => []) : [];
                  const diagnostics = await page.evaluate(() => ({
                    themeResolved: document.documentElement.dataset.themeResolved || '',
                    language: document.documentElement.lang || '',
                    accountMenuOpen: Boolean(document.getElementById('account-menu'))
                      && !document.getElementById('account-menu').hasAttribute('hidden'),
                    helpMenuOpen: Boolean(document.getElementById('help-menu'))
                      && !document.getElementById('help-menu').hasAttribute('hidden'),
                    textLength: (document.body?.innerText || '').length,
                  }));
                  results.push({
                    side: side.name, route, locale, theme, viewport: viewport.label,
                    state: state.name, file: full, ok: true, diagnostics, text,
                    png, sha256: digest,
                    facts: { ...(page.__facts || genericFacts || {}), probes: probeFacts },
                    console: (page.__logs || []).slice(0, 60),
                  });
                  process.stdout.write(`ok ${path.relative(process.cwd(), full)}\n`);
                }
              }
            } catch (error) {
              results.push({
                side: side.name, locale, theme, viewport: viewport.label,
                ok: false, error: String(error.message || error),
              });
              process.stderr.write(`fail ${side.name} ${locale} ${theme} ${viewport.label}: ${error.message || error}\n`);
            } finally {
              await context.close();
            }
          }
        }
      }
    }

    let diffs = [];
    if (!skipDiff && sides.length === 2) {
      const before = results.filter((item) => item.ok && item.side === sides[0].name);
      const after = results.filter((item) => item.ok && item.side === sides[1].name);
      const comparePage = await browser.newPage();
      for (const left of before) {
        const right = after.find((item) => item.route === left.route && item.locale === left.locale
          && item.theme === left.theme && item.viewport === left.viewport && item.state === left.state);
        if (!right) continue;
        const diff = await diffPair(comparePage, left.file, right.file);
        const textDiff = compareText(left.text || '', right.text || '');
        const entry = {
          route: left.route, locale: left.locale, theme: left.theme,
          viewport: left.viewport, state: left.state,
          before: path.relative(outRoot, left.file),
          after: path.relative(outRoot, right.file),
          before_diagnostics: left.diagnostics,
          after_diagnostics: right.diagnostics,
          ...diff,
          text: textDiff,
        };
        diffs.push(entry);
        process.stdout.write(`diff ${entry.locale} ${entry.theme} ${entry.viewport} ${entry.route}`
          + ` changed=${(entry.ratio * 100).toFixed(3)}%`
          + (entry.bbox ? ` bbox=${entry.bbox.x},${entry.bbox.y},${entry.bbox.width}x${entry.bbox.height}` : ' bbox=none')
          + (entry.sizeMismatch ? ' SIZE-MISMATCH' : '')
          + ` textLinesChanged=${entry.text.changedLines}`
          + (entry.text.sample.length ? ` first="${entry.text.sample[0].slice(0, 80)}"` : '') + '\n');
      }
      await comparePage.close();
    }

    if (diffs.length) {
      fs.writeFileSync(path.join(outRoot, slug, 'diff.json'), `${JSON.stringify({
        slug, sides: sides.map((side) => side.url), diffs,
      }, null, 2)}\n`);
    }

    const reportDir = path.join(outRoot, slug);
    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      slug,
      reuse: REUSE,
      generated_at: new Date().toISOString(),
      sides: sides.map((side) => ({ name: side.name, ref: side.ref, url: side.url })),
      images: results.filter((item) => item.ok).map((item) => ({
        arm: item.side,
        file: path.relative(reportDir, item.file),
        route: item.route, locale: item.locale, theme: item.theme,
        viewport: item.viewport, state: item.state,
        png: item.png, sha256: item.sha256,
        diagnostics: item.diagnostics, facts: item.facts, console: item.console,
      })),
      failures: results.filter((item) => !item.ok).map((item) => ({
        arm: item.side, locale: item.locale, theme: item.theme,
        viewport: item.viewport, error: item.error,
      })),
    };
    fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    const failures = results.filter((item) => !item.ok);
    const summary = {
      slug,
      sides: sides.map((side) => side.url),
      routes,
      images: results.filter((item) => item.ok).length,
      failures: failures.length,
      diffs: diffs.length,
      elapsed_ms: Date.now() - started,
      output: outRoot,
      detail: hasFlag('--json') ? results : undefined,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
    for (const side of sides) {
      if (side.child && side.child.exitCode === null) {
        side.child.kill('SIGTERM');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    cleanup();
  }
}

/* #239: /discover catalog card gains 用这个智能体. Two catalog entries are
 * seeded: CATALOG_CONFLICT_NAME is published from the owner workspace (the
 * click must answer 409), CATALOG_CREATE_NAME from alice's workspace (the
 * click must 201 and land on /agents). The before arm has no .catalog-use at
 * all, so each state records its absence instead of throwing. */
async function gotoDiscoverAgents(page) {
  const target = new URL('/discover?tab=agents', page.url()).toString();
  await page.goto(target, {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(400);
}

async function discoverCard(page, name) {
  const card = page.locator('#discover-list li article').filter({hasText: name}).first();
  try {
    await card.waitFor({state: 'visible', timeout: 25000});
  } catch (error) {
    const dump = await page.evaluate(() => ({
      url: location.pathname + location.search,
      body: (document.body?.innerText || '').slice(0, 700),
      list: (document.getElementById('discover-list')?.innerHTML || 'absent').slice(0, 500),
      tabs: [...document.querySelectorAll('[role="tab"], .tab, nav button')].map((n) => (n.textContent || '').trim()).slice(0, 15),
    })).catch(() => ({url: 'unknown', body: '', list: '', tabs: []}));
    noteReading(page, `discoverCard missing "${name}" url=${dump.url} tabs=${JSON.stringify(dump.tabs)} list="${dump.list}"`);
    noteReading(page, `discoverCard body="${dump.body.replace(/\s+/g, ' ')}"`);
    throw error;
  }
  return card;
}

async function readDiscover239(page, label, name) {
  const reading = await page.evaluate((wanted) => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
    };
    const cards = [...document.querySelectorAll('#discover-list li article')];
    const card = cards.find((node) => (node.textContent || '').includes(wanted)) || null;
    const use = card ? card.querySelector('.catalog-use') : null;
    const chat = card ? card.querySelector('button:not(.catalog-use)') : null;
    const status = document.getElementById('status');
    return {
      cards: cards.length,
      cardFound: Boolean(card),
      cardBox: box(card),
      useText: use ? (use.textContent || '').trim() : 'absent',
      useAria: use ? use.getAttribute('aria-label') : 'absent',
      useTitle: use ? use.getAttribute('title') : 'absent',
      useBox: box(use),
      useDisabled: use ? use.disabled : null,
      chatText: chat ? (chat.textContent || '').trim() : 'absent',
      chatDisabled: chat ? chat.disabled : null,
      statusKind: status ? (status.dataset.kind || '') : 'absent',
      statusText: status ? (status.textContent || '').trim() : 'absent',
      url: location.pathname,
      scrollWidth: document.documentElement.scrollWidth,
      vp: `${innerWidth}x${innerHeight}`,
    };
  }, name);
  noteReading(page, `${label} cards=${reading.cards} cardFound=${reading.cardFound} cardBox=${JSON.stringify(reading.cardBox)} useText="${reading.useText}" useAria="${reading.useAria}" useDisabled=${reading.useDisabled} useBox=${JSON.stringify(reading.useBox)} chat="${reading.chatText}" chatDisabled=${reading.chatDisabled}`);
  noteReading(page, `${label} url=${reading.url} statusKind="${reading.statusKind}" statusText="${reading.statusText}" scrollWidth=${reading.scrollWidth} vp=${reading.vp}`);
  return reading;
}

// 1. card before any click.
STATES['disc-use-card'] = async (page) => {
  await gotoDiscoverAgents(page);
  await discoverCard(page, CATALOG_CREATE_NAME);
  await readDiscover239(page, 'disc-use-card', CATALOG_CREATE_NAME);
  await waitForStableText(page);
};

// 2. click the creator-owned card -> 201 -> the app assigns /agents. The status
// line is observed through a mutation log because the navigation replaces the
// document that carried it.
STATES['disc-use-created'] = async (page) => {
  await page.addInitScript(() => {
    window.__qaStatus239 = [];
    const attach = () => {
      const status = document.getElementById('status');
      if (!status) return false;
      window.__qaStatus239.push((status.textContent || '').trim());
      new MutationObserver(() => {
        const text = (status.textContent || '').trim();
        if (text && window.__qaStatus239[window.__qaStatus239.length - 1] !== text) {
          window.__qaStatus239.push(text);
        }
      }).observe(status, {childList: true, characterData: true, subtree: true});
      return true;
    };
    if (!attach()) {
      document.addEventListener('DOMContentLoaded', attach, {once: true});
    }
  });
  await gotoDiscoverAgents(page);
  const card = await discoverCard(page, CATALOG_CREATE_NAME);
  const use = card.locator('.catalog-use');
  if (!(await use.count())) {
    noteReading(page, `disc-use-created use button absent (before arm) cardBox=${JSON.stringify(await card.boundingBox())}`);
    await waitForStableText(page);
    return;
  }
  const posted = [];
  page.on('response', (response) => {
    const url = response.url();
    if (response.request().method() === 'POST' && /\/v1\/workspaces\/[^/]+\/agents$/.test(url)) {
      posted.push(response.status());
    }
  });
  const navigated = page.waitForURL('**/agents', {timeout: 20000}).then(() => 'agents').catch(() => 'no-nav');
  await use.click({timeout: 10000});
  const outcome = await navigated;
  await page.waitForTimeout(1200);
  const statuses = await page.evaluate(() => (window.__qaStatus239 || []).filter(Boolean));
  noteReading(page, `disc-use-created outcome=${outcome} postStatus=${JSON.stringify(posted)} statusLog=${JSON.stringify(statuses)} url=${page.url()}`);
  noteReading(page, `disc-use-created page text length=${(await page.evaluate(() => document.body.innerText.length))}`);
  await waitForStableText(page);
};

// 3. click the card whose name already exists in this workspace -> 409 line.
STATES['disc-use-conflict'] = async (page) => {
  await gotoDiscoverAgents(page);
  const card = await discoverCard(page, CATALOG_CONFLICT_NAME);
  const use = card.locator('.catalog-use');
  if (!(await use.count())) {
    noteReading(page, 'disc-use-conflict use button absent (before arm)');
    await waitForStableText(page);
    return;
  }
  const posted = [];
  page.on('response', (response) => {
    const url = response.url();
    if (response.request().method() === 'POST' && /\/v1\/workspaces\/[^/]+\/agents$/.test(url)) {
      posted.push(response.status());
    }
  });
  await use.click({timeout: 10000});
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, {timeout: 15000},
  ).catch(() => {});
  await page.waitForTimeout(800);
  await readDiscover239(page, 'disc-use-conflict', CATALOG_CONFLICT_NAME);
  noteReading(page, `disc-use-conflict postStatus=${JSON.stringify(posted)}`);
  await waitForStableText(page);
};

// 4. signed out: the click must answer 请先登录 instead of creating anything.
STATES['disc-use-logout'] = async (page) => {
  // Signed-out face without losing the catalog: answer the session read with 401
  // so currentUser stays null and the click takes the 请先登录 branch.
  await page.route('**/v1/auth/session', (route) => route.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({error: {code: 'unauthenticated', message: 'Not signed in.'}}),
  }));
  await gotoDiscoverAgents(page);
  const card = await discoverCard(page, CATALOG_CONFLICT_NAME);
  const use = card.locator('.catalog-use');
  if (!(await use.count())) {
    noteReading(page, 'disc-use-logout use button absent (before arm)');
    await waitForStableText(page);
    return;
  }
  const posted = [];
  page.on('response', (response) => {
    const url = response.url();
    if (response.request().method() === 'POST' && /\/v1\/workspaces\/[^/]+\/agents$/.test(url)) {
      posted.push(response.status());
    }
  });
  await use.click({timeout: 10000});
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent || '').trim().length > 0,
    null, {timeout: 15000},
  ).catch(() => {});
  await page.waitForTimeout(800);
  await readDiscover239(page, 'disc-use-logout', CATALOG_CONFLICT_NAME);
  noteReading(page, `disc-use-logout postStatus=${JSON.stringify(posted)}`);
  await waitForStableText(page);
};


// #237 probe: what the checklist says for whatever account is signed in.
STATES['ob-probe'] = async (page) => {
  await page.waitForSelector('#onboarding-checklist li', {timeout: 20000}).catch(() => {});
  const reading = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#onboarding-checklist li')];
    const ready = document.getElementById('onboarding-ready');
    return {
      rows: rows.map((row) => ({
        state: row.dataset.state,
        text: (row.textContent || '').trim(),
        className: row.className,
      })),
      readyHidden: ready ? ready.hidden : 'absent',
      readyText: ready ? (ready.textContent || '').trim() : 'absent',
      readyHref: ready ? (ready.querySelector('a')?.getAttribute('href') || '') : '',
      url: location.pathname,
    };
  });
  for (const [index, row] of reading.rows.entries()) {
    noteReading(page, `ob-probe step${index + 1} state=${row.state} class="${row.className}" text="${row.text}"`);
  }
  noteReading(page, `ob-probe ready hidden=${reading.readyHidden} text="${reading.readyText}" href="${reading.readyHref}" url=${reading.url}`);
};



// #237: switch the browser session, then read the checklist.
async function asAccount(page, cookieKey) {
  const jar = cookieKey === 'owner' ? OWNER_COOKIES : ONBOARDING_COOKIES[cookieKey];
  if (!jar || !jar.length) throw new Error(`asAccount ${cookieKey}: no captured cookie`);
  const origin = new URL(page.url()).origin;
  await page.context().clearCookies();
  await page.context().addCookies(jar);
  await page.goto(`${origin}/onboarding`, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('#onboarding-checklist li', {timeout: 15000}).catch(async () => {
    const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
    noteReading(page, `no #onboarding-checklist row (base arm?) body="${body}"`);
  });
  await page.waitForTimeout(900);
}

async function readChecklist237(page, label) {
  const reading = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#onboarding-checklist li')];
    const ready = document.getElementById('onboarding-ready');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
    };
    return {
      rows: rows.map((row) => ({state: row.dataset.state, text: (row.textContent || '').trim(),
        className: row.className, box: box(row)})),
      readyHidden: ready ? ready.hidden : 'absent',
      readyText: ready ? (ready.textContent || '').trim() : 'absent',
      readyHref: ready ? (ready.querySelector('a')?.getAttribute('href') || '') : '',
      readyBox: box(ready),
      scrollWidth: document.documentElement.scrollWidth,
      vp: `${innerWidth}x${innerHeight}`,
      url: location.pathname,
    };
  });
  for (const [index, row] of reading.rows.entries()) {
    noteReading(page, `${label} step${index + 1} state=${row.state} class="${row.className}" box=${JSON.stringify(row.box)} text="${row.text}"`);
  }
  noteReading(page, `${label} ready hidden=${reading.readyHidden} text="${reading.readyText}" href="${reading.readyHref}" box=${JSON.stringify(reading.readyBox)} scrollWidth=${reading.scrollWidth} vp=${reading.vp}`);
  return reading;
}

STATES['ob-ready'] = async (page) => {
  await page.waitForSelector('#onboarding-checklist li', {timeout: 15000}).catch(async () => {
    const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
    noteReading(page, `no #onboarding-checklist row (base arm?) body="${body}"`);
  });
  await page.waitForTimeout(1200);
  await readChecklist237(page, 'ob-ready');
  await waitForStableText(page);
};

STATES['ob-partial'] = async (page) => {
  try {
    await asAccount(page, 'obpartial');
    await readChecklist237(page, 'ob-partial');
    await waitForStableText(page);
  } finally {
    await asAccount(page, 'owner').catch(() => {});
  }
};

STATES['ob-fresh'] = async (page) => {
  try {
    await asAccount(page, 'obfresh');
    await readChecklist237(page, 'ob-fresh');
    await waitForStableText(page);
  } finally {
    await asAccount(page, 'owner').catch(() => {});
  }
};

// #254: /agents runtime status badges. The fixture binds no container, so every
// genuine answer is {"runtime": null} (未连运行时). online / offline /
// unavailable come from answering the page's own per-agent GET .../runtime with
// the server's exact binding_view() shape (openteamily/agent_runtime.py:98 +
// app.binding_status); 状态未知 is a real 500 on that same route, i.e. the
// page's own failure path. Everything else — directory, cards, rail — is the
// real fixture.
async function agentsRuntimeTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('#agent-list li a.chat-cta')]
    .map((link) => {
      const params = new URLSearchParams((link.href.split('#')[1] || ''));
      return {wid: params.get('workspace'), id: params.get('agent')};
    })
    .filter((item) => item.wid && item.id));
}

function agentsRuntimeBody(target, status) {
  return {
    runtime: {
      agent_id: target.id,
      workspace_id: target.wid,
      instance_id: 'ci-fixture-instance-1',
      revision: 1,
      bound_by: 'member_owner',
      created: '2026-11-19T00:00:00Z',
      updated: '2026-11-19T00:00:00Z',
      status,
    },
  };
}

async function readAgentsBadges(page, label) {
  const reading = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#agent-list li')];
    const badges = cards.map((card) => {
      const el = card.querySelector('.agent-status');
      return el ? {key: el.dataset.status, label: el.textContent.trim(), title: el.title} : null;
    }).filter(Boolean);
    const counts = {};
    for (const badge of badges) counts[badge.key] = (counts[badge.key] || 0) + 1;
    const note = [...document.querySelectorAll('#main-panel p')]
      .map((p) => p.textContent.trim())
      .filter((text) => text.includes('心跳') || text.includes('heartbeat'));
    return {
      rows: cards.length,
      badges: badges.length,
      counts,
      labels: [...new Set(badges.map((badge) => badge.label))],
      titles: [...new Set(badges.map((badge) => badge.title))],
      note: note.join(' | '),
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  });
  noteReading(page, `${label} rows=${reading.rows} badges=${reading.badges} counts=${JSON.stringify(reading.counts)} labels=${JSON.stringify(reading.labels)} note="${reading.note}" innerWidth=${reading.innerWidth} scrollWidth=${reading.scrollWidth}`);
  return reading;
}

async function mountAgentsRuntime(page, statuses, label) {
  const viewport = page.viewportSize();
  await page.setViewportSize({width: viewport.width, height: viewport.height});
  // The directory only lists agents of the workspace picked in #workspace;
  // without a pick the page clears #agent-list, so select it first.
  await ensureWorkspace(page);
  if (typeof page.unrouteAll === 'function') await page.unrouteAll({behavior: 'ignoreErrors'});
  else await page.unroute('**');
  const targets = await agentsRuntimeTargets(page);
  if (!targets.length) throw new Error('no agent cards to read a runtime for');
  const byAgent = new Map(targets.map((target, index) => [target.id, statuses[index] || null]));
  await page.route(/\/agents\/[^/]+\/runtime(\?|$)/, async (route) => {
    const id = (route.request().url().match(/\/agents\/([^/]+)\/runtime/) || [])[1] || '';
    const status = byAgent.get(id);
    if (status === 500) {
      await route.fulfill({status: 500, contentType: 'application/json',
        body: JSON.stringify({error: 'ci_fixture_runtime_500'})});
      return;
    }
    if (status) {
      const target = targets.find((item) => item.id === id) || {id, wid: targets[0].wid};
      await route.fulfill({status: 200, contentType: 'application/json',
        body: JSON.stringify(agentsRuntimeBody(target, status))});
      return;
    }
    await route.continue();
  });
  await page.reload({waitUntil: 'networkidle'});
  // The picked workspace is a per-profile setting; if the reload came back with
  // no pick the directory is empty, so make sure it is still selected.
  await page.waitForTimeout(300);
  await ensureWorkspace(page);
  await page.waitForSelector('#agent-list li', {timeout: 20000});
  await page.waitForFunction((want) => document.querySelectorAll('#agent-list li .agent-status').length >= want,
    targets.length, {timeout: 8000}).catch(() => {});
  await page.waitForTimeout(300);
  return readAgentsBadges(page, label);
}

STATES['statuses-all'] = async (page) => {
  await mountAgentsRuntime(page, ['online', 'offline', 'unavailable'], 'A statuses-all');
};

STATES['statuses-unknown'] = async (page) => {
  await mountAgentsRuntime(page, [500], 'A statuses-unknown');
};

// #224 Aurora: one state that puts every page on the same interaction point —
// /chat opens the seeded conversation (so a real message column is on screen),
// /agents picks the fixture workspace (its directory otherwise lists nothing),
// /settings and /automations are shot as they load. Also records the resolved
// theme, the surfaces' background colours and the width guard per cell.
STATES['aurora'] = async (page) => {
  const pathname = new URL(page.url()).pathname;
  const viewport = page.viewportSize();
  await page.setViewportSize({width: viewport.width, height: viewport.height});
  if (pathname === '/chat') {
    await enterChat(page);
    await ensureWorkspace(page);
    await page.waitForTimeout(1200);
    const rows = page.locator('#conversation-list li button');
    if (await rows.count()) {
      await rows.first().click({timeout: 8000}).catch(() => {});
      await page.waitForTimeout(1000);
    }
  } else if (pathname === '/agents') {
    await ensureWorkspace(page);
    await page.waitForSelector('#agent-list li', {timeout: 20000}).catch(() => {});
    await page.waitForTimeout(400);
  }
  const guard = await page.evaluate(() => {
    const surface = document.getElementById('main-panel') || document.querySelector('main');
    return {
      theme: document.documentElement.dataset.themeResolved || '',
      lang: document.documentElement.lang || '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      mainBg: surface ? getComputedStyle(surface).backgroundColor : 'none',
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      messages: document.querySelectorAll('#message-list li').length,
      agentRows: document.querySelectorAll('#agent-list li').length,
    };
  });
  noteReading(page, `aurora ${pathname} theme=${guard.theme} lang=${guard.lang} bodyBg=${guard.bodyBg} mainBg=${guard.mainBg} messages=${guard.messages} agentRows=${guard.agentRows} innerWidth=${guard.innerWidth} scrollWidth=${guard.scrollWidth}`);
};

// #269: /artifacts — the 收藏 (starred) empty state carries the 保存智能体成果
// CTA (#empty-save-agent). Each state starts from ?view=starred so the three
// shots are independent of one another.
async function openArtifactsStarred(page) {
  const origin = new URL(page.url()).origin;
  const viewport = page.viewportSize();
  await page.setViewportSize({width: viewport.width, height: viewport.height});
  await page.goto(`${origin}/artifacts?view=starred`, {waitUntil: 'networkidle'});
  await page.waitForSelector('#empty-save-agent', {timeout: 15000});
  // At 390x844 the CTA sits below the fold (y≈1800), and the harness shoots the
  // viewport, so bring it into frame — otherwise the image would not contain it.
  await page.locator('#empty-save-agent').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(700);
}

async function readArtifactsCta(page, label) {
  const reading = await page.evaluate(() => {
    const cta = document.getElementById('empty-save-agent');
    const starred = document.getElementById('empty-starred');
    const box = cta ? cta.getBoundingClientRect() : null;
    const current = [...document.querySelectorAll('#artifact-scopes button')]
      .filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent.trim());
    const firstDoc = document.querySelector('#artifact-list li');
    return {
      starredHidden: starred ? starred.hidden : null,
      ctaDisabled: cta ? cta.disabled : null,
      ctaTitle: cta ? cta.title : '',
      ctaLabel: cta ? `${(cta.querySelector('strong') || {}).textContent || ''}｜${(cta.querySelector('.hint') || {}).textContent || ''}` : '',
      ctaBox: box ? {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)} : null,
      scope: current.join(','),
      rows: document.querySelectorAll('#artifact-list li').length,
      firstRow: firstDoc ? (firstDoc.textContent || '').trim().slice(0, 60) : '',
      status: (document.getElementById('status')?.textContent || '').trim(),
      dialog: Boolean(document.getElementById('agent-task-dialog')),
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  noteReading(page, `${label} scope=${reading.scope} starredHidden=${reading.starredHidden} ctaDisabled=${reading.ctaDisabled} title="${reading.ctaTitle}" label="${reading.ctaLabel}" box=${JSON.stringify(reading.ctaBox)} rows=${reading.rows} first="${reading.firstRow}" status="${reading.status}" dialog=${reading.dialog} innerWidth=${reading.innerWidth} scrollWidth=${reading.scrollWidth}`);
  return reading;
}

STATES['art-empty-cta'] = async (page) => {
  await openArtifactsStarred(page);
  await readArtifactsCta(page, 'A art-empty-cta');
};

STATES['art-task-panel'] = async (page) => {
  await openArtifactsStarred(page);
  let posts = 0;
  page.on('response', (response) => {
    if (response.request().method() === 'POST') posts += 1;
  });
  await page.locator('#empty-save-agent').click({timeout: 8000}).catch(() => {});
  await page.waitForTimeout(1300);
  const panel = await page.evaluate(() => {
    const dialog = document.getElementById('agent-task-dialog');
    const rows = [...document.querySelectorAll('#agent-task-list li')];
    const note = document.getElementById('agent-task-note');
    return {
      dialog: Boolean(dialog),
      role: dialog ? dialog.getAttribute('role') : '',
      labelledby: dialog ? dialog.getAttribute('aria-labelledby') : '',
      heading: (document.getElementById('agent-task-title')?.textContent || '').trim(),
      noteHidden: note ? note.hidden : null,
      note: (note?.textContent || '').trim(),
      rows: rows.length,
      labels: rows.map((li) => (li.querySelector('span')?.textContent || '').trim()),
      buttons: [...new Set(rows.map((li) => (li.querySelector('button')?.textContent || '').trim()))],
      close: (document.getElementById('agent-task-close')?.textContent || '').trim(),
      openerDisabled: document.getElementById('empty-save-agent')?.disabled,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  noteReading(page, `A art-task-panel dialog=${panel.dialog} role=${panel.role} labelledby=${panel.labelledby} heading="${panel.heading}" noteHidden=${panel.noteHidden} note="${panel.note}" rows=${panel.rows} labels=${JSON.stringify(panel.labels)} buttons=${JSON.stringify(panel.buttons)} close="${panel.close}" openerDisabled=${panel.openerDisabled} posts=${posts} innerWidth=${panel.innerWidth} scrollWidth=${panel.scrollWidth}`);
};

STATES['art-saved'] = async (page) => {
  await openArtifactsStarred(page);
  const rowsBefore = await page.evaluate(() => document.querySelectorAll('#artifact-list li').length);
  let posts = 0; let postUrl = '';
  page.on('response', (response) => {
    const request = response.request();
    if (request.method() === 'POST') { posts += 1; postUrl = request.url(); }
  });
  await page.locator('#empty-save-agent').click({timeout: 8000}).catch(() => {});
  await page.waitForTimeout(1000);
  const taskRows = await page.locator('#agent-task-list li').count();
  const clicked = taskRows
    ? ((await page.locator('#agent-task-list li span').first().textContent().catch(() => '')) || '').trim()
    : '';
  await page.locator('#agent-task-list li button').first().click({timeout: 8000}).catch(() => {});
  await page.waitForTimeout(1800);
  const after = await readArtifactsCta(page, 'A art-saved');
  await page.reload({waitUntil: 'networkidle'});
  await page.waitForTimeout(1000);
  const persisted = await page.evaluate(() => ({
    rows: document.querySelectorAll('#artifact-list li').length,
    first: (document.querySelector('#artifact-list li')?.textContent || '').trim().slice(0, 60),
    scope: [...document.querySelectorAll('#artifact-scopes button')]
      .filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent.trim()).join(','),
    url: location.pathname + location.search,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  noteReading(page, `A art-saved rowsBefore=${rowsBefore} taskRows=${taskRows} clicked="${clicked}" posts=${posts} postUrl=${postUrl} afterSave rows=${after.rows} status="${after.status}" persistedAfterReload rows=${persisted.rows} first="${persisted.first}" scope=${persisted.scope} url="${persisted.url}" scrollWidth=${persisted.scrollWidth}`);
};

// #284: /settings → 通知. Three per-account switches (提及我 / 任务完成 / 作品
// 通知) that PUT /v1/notification-prefs. States: all on, one switched off (and
// still off after a reload), and a refused save that must roll the switch back
// and print the server's reason.
async function readNotifyPrefs(page, label) {
  const reading = await page.evaluate(() => {
    const section = document.getElementById('notification-prefs');
    const stateLine = document.getElementById('notification-prefs-state');
    const rows = [...document.querySelectorAll('#notification-prefs label.settings-toggle')].map((row) => {
      const input = row.querySelector('input[role="switch"]');
      return {
        label: (row.querySelector('.settings-row-label')?.textContent || '').trim(),
        meta: (row.querySelector('.settings-row-meta')?.textContent || '').trim(),
        id: input ? input.id : '',
        checked: input ? input.checked : null,
        disabled: input ? input.disabled : null,
      };
    });
    const box = section ? section.getBoundingClientRect() : null;
    return {
      heading: (document.getElementById('group-notifications')?.textContent || '').trim(),
      present: Boolean(section),
      rows,
      state: (stateLine?.textContent || '').trim(),
      box: box ? {x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height)} : null,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  noteReading(page, `${label} present=${reading.present} heading="${reading.heading}" rows=${JSON.stringify(reading.rows.map((row) => `${row.label}:${row.checked}`))} meta=${JSON.stringify(reading.rows.map((row) => row.meta))} checked=${JSON.stringify(reading.rows.map((row) => row.checked))} state="${reading.state}" box=${JSON.stringify(reading.box)} innerWidth=${reading.innerWidth} scrollWidth=${reading.scrollWidth}`);
  return reading;
}

async function openNotifyPrefs(page) {
  const viewport = page.viewportSize();
  await page.setViewportSize({width: viewport.width, height: viewport.height});
  await page.waitForSelector('#notify-mentions', {timeout: 3000}).catch(() => {});
  await page.locator('#group-notifications').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(700);
}

async function ensureNotifyAllOn(page) {
  for (const id of ['notify-mentions', 'notify-task-completion', 'notify-artifacts']) {
    const checked = await page.locator(`#${id}`).isChecked().catch(() => null);
    if (checked === false) {
      await page.locator(`#${id}`).click({timeout: 5000}).catch(() => {});
      await page.waitForTimeout(800);
    }
  }
}

STATES['notif-default'] = async (page) => {
  await openNotifyPrefs(page);
  await ensureNotifyAllOn(page);
  await readNotifyPrefs(page, 'A notif-default');
};

STATES['notif-artifacts-off'] = async (page) => {
  await openNotifyPrefs(page);
  await ensureNotifyAllOn(page);
  let puts = 0;
  page.on('request', (request) => { if (request.method() === 'PUT') puts += 1; });
  await page.locator('#notify-artifacts').click({timeout: 6000}).catch(() => {});
  await page.waitForTimeout(900);
  await readNotifyPrefs(page, `A notif-artifacts-off puts=${puts}`);
  await page.reload({waitUntil: 'networkidle'});
  await page.waitForTimeout(900);
  await page.locator('#group-notifications').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await readNotifyPrefs(page, 'A notif-artifacts-off afterReload');
};

STATES['notif-save-failed'] = async (page) => {
  await openNotifyPrefs(page);
  await ensureNotifyAllOn(page);
  if (typeof page.unrouteAll === 'function') await page.unrouteAll({behavior: 'ignoreErrors'});
  await page.route('**/v1/notification-prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({status: 500, contentType: 'application/json',
        body: JSON.stringify({error: {message: '通知偏好暂时写不进去（CI fixture 拦下的 500）。'}})});
      return;
    }
    await route.continue();
  });
  await page.locator('#notify-artifacts').click({timeout: 6000}).catch(() => {});
  await page.waitForTimeout(1100);
  await readNotifyPrefs(page, 'A notif-save-failed');
};

// #294: /onboarding step 2 — #onboarding-apps rows plus #onboarding-reality.
// Step 1 must be submitted before the steps card is shown, so every state walks
// the real flow first (first industry, first role, 继续).
async function openOnboardingStep2(page) {
  const viewport = page.viewportSize();
  await page.setViewportSize({width: viewport.width, height: viewport.height});
  const select = page.locator('#industry');
  await select.waitFor({timeout: 15000});
  const values = await select.evaluate((el) => [...el.options].map((o) => o.value).filter(Boolean));
  if (values.length) {
    await select.selectOption(values[0]).catch(() => {});
    await page.waitForTimeout(500);
  }
  const role = page.locator('#role-choices button, #role-choices label').first();
  if (await role.count()) {
    await role.click({force: true}).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.locator('#onboarding-save').click({timeout: 8000}).catch(() => {});
  await page.waitForSelector('#onboarding-apps li', {timeout: 20000}).catch(() => {});
  await page.locator('#onboarding-apps').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(700);
}

async function readOnboardingApps(page, label) {
  const reading = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#onboarding-apps li')].map((li) => ({
      name: (li.querySelector('strong')?.textContent || '').trim(),
      state: (li.querySelector('.app-state')?.textContent || '').trim(),
      key: li.querySelector('.app-state')?.dataset.state || '',
      button: (li.querySelector('.app-connect')?.textContent || '').trim(),
      disabled: li.querySelector('.app-connect')?.disabled ?? null,
    }));
    const reality = document.getElementById('onboarding-reality');
    return {
      rows,
      reality: (reality?.textContent || '').trim(),
      stepVisible: !document.getElementById('onboarding-steps')?.hidden,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  noteReading(page, `${label} rows=${reading.rows.length} names=${JSON.stringify(reading.rows.map((r) => r.name))} states=${JSON.stringify(reading.rows.map((r) => r.state))} keys=${JSON.stringify(reading.rows.map((r) => r.key))} buttons=${JSON.stringify([...new Set(reading.rows.map((r) => r.button))])} reality="${reading.reality}" stepVisible=${reading.stepVisible} innerWidth=${reading.innerWidth} scrollWidth=${reading.scrollWidth}`);
  return reading;
}

async function routeComposioConnections(page, kind) {
  if (typeof page.unrouteAll === 'function') await page.unrouteAll({behavior: 'ignoreErrors'});
  if (kind === 'none') return;
  await page.route('**/v1/composio/connections', async (route) => {
    if (kind === 'refused') {
      await route.fulfill({status: 409, contentType: 'application/json',
        body: JSON.stringify({error: {message: 'no personal composio key'}})});
      return;
    }
    await route.fulfill({status: 200, contentType: 'application/json',
      body: JSON.stringify({items: [{toolkit: 'github', state: 'connected'}], sync: 'ok'})});
  });
}

// #294: the seed's fake runtime daemon dies with the seeding server, so the
// connection goes stale after runtime_heartbeat_seconds (45 s). Post a real
// heartbeat with the seed's runtime key against this arm's server instead of
// faking the row: the page then reads a genuinely online connection.
async function refreshRuntimeHeartbeat(page) {
  const origin = new URL(page.url()).origin;
  // ready.json carries only the key name; the token file sits next to the DB.
  const token = fs.readFileSync(path.join(STATE_ROOT, 'seed', 'data', 'runtime-key'), 'utf8').trim();
  const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  // The seed daemon drops its connection when it is stopped, so a heartbeat
  // alone is 404: re-open the connection with the runtime's own /connect, then
  // heartbeat it. Both are the real endpoints the daemon uses.
  const connected = await fetch(`${origin}/v1/agent/connect`, {
    method: 'POST', headers, body: JSON.stringify({hostname: 'ci-fixture-runtime'}),
  });
  const connectText = (await connected.text()).slice(0, 120);
  const response = await fetch(`${origin}/v1/agent/heartbeat`, {
    method: 'POST', headers, body: '{}',
  });
  const text = (await response.text()).slice(0, 120);
  return `connect=${connected.status} heartbeat=${response.status} ${text || connectText}`;
}

// #294 state 3: the page counts agents in /v1/workspaces items[0], and that
// endpoint orders by the random workspace id, so which workspace is counted is
// luck and it is often the empty one. Make that first workspace really have an
// agent through the app's own API (once) so the summary line can name both an
// agent and an online runtime — the count is still read, never written in.
async function ensureFirstWorkspaceAgent(page) {
  const context = page.context();
  const base = new URL(page.url()).origin;
  const csrf = csrfFromCookies(await context.cookies());
  if (!csrf) return 'no-csrf-cookie';
  const listed = await apiJson(context, base, csrf, 'GET', '/v1/workspaces?limit=100');
  const items = listed.body?.items || listed.body?.workspaces || [];
  const space = items[0];
  if (!space) return `no-workspace (HTTP ${listed.status})`;
  const before = await apiJson(context, base, csrf, 'GET', `/v1/workspaces/${space.id}/agents?limit=100`);
  const count = (before.body?.items || []).length;
  if (count > 0) return `ws=${String(space.id).slice(0, 8)} agents=${count} kept`;
  const created = await apiJson(context, base, csrf, 'POST', `/v1/workspaces/${space.id}/agents`,
    {name: '[CI FIXTURE] 引导计数智能体',
      summary: 'CI fixture: makes the step-2 reality line count an agent.',
      instructions: 'Fixture only.'},
    {'Idempotency-Key': `ci-onboarding-reality-${String(space.id).slice(0, 8)}-0001`});
  return `ws=${String(space.id).slice(0, 8)} agents=${count}->${count + (created.status < 300 ? 1 : 0)} create=${created.status}`;
}

// Both arms read the same page: a fresh heartbeat keeps "M 个运行时连接在线"
// true across the whole grid, not just the first 45 seconds after seeding.
async function prepareOnboardingReality(page, label) {
  const heartbeat = await refreshRuntimeHeartbeat(page);
  const agents = await ensureFirstWorkspaceAgent(page);
  noteReading(page, `${label} prepare heartbeat=${heartbeat} ${agents}`);
}

STATES['apps-unlinked'] = async (page) => {
  await routeComposioConnections(page, 'refused');
  await prepareOnboardingReality(page, 'A apps-unlinked');
  await page.reload({waitUntil: 'networkidle'});
  await openOnboardingStep2(page);
  await readOnboardingApps(page, 'A apps-unlinked');
};

STATES['apps-connected'] = async (page) => {
  await routeComposioConnections(page, 'connected');
  await prepareOnboardingReality(page, 'A apps-connected');
  await page.reload({waitUntil: 'networkidle'});
  await openOnboardingStep2(page);
  await readOnboardingApps(page, 'A apps-connected');
};

STATES['apps-reality'] = async (page) => {
  await routeComposioConnections(page, 'none');
  await prepareOnboardingReality(page, 'A apps-reality');
  await page.reload({waitUntil: 'networkidle'});
  await openOnboardingStep2(page);
  await readOnboardingApps(page, 'A apps-reality');
};

main().catch((error) => {
  process.stderr.write(`shots: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
