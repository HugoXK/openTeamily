#!/usr/bin/env node
/**
 * Capture the real OpenTeamily management UI in a CI runner browser.
 * Reads ready.json plus a 0600 login file. Never prints passwords or tokens.
 * Talks only to the loopback origin from ready.json.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readLogin(file) {
  const text = fs.readFileSync(file, 'utf8');
  const username = /(?:^|\n)username=([^\n]+)/.exec(text)?.[1];
  const password = /(?:^|\n)password=([^\n]+)/.exec(text)?.[1];
  if (!username || !password) {
    throw new Error('login file is missing fields');
  }
  return { username, password };
}

function shanghaiStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} Asia/Shanghai`;
}

async function visibleText(locator) {
  if (!(await locator.count()) || !(await locator.isVisible())) return '';
  return ((await locator.innerText()) || '').trim();
}

async function assertSafeToCapture(page) {
  const filled = await page.$$eval('input[type="password"]', (inputs) => inputs.map((input) => input.value).filter(Boolean));
  if (filled.length) {
    throw new Error('a password field is not empty; refusing to screenshot');
  }
  for (const selector of ['#issued-token', '#share-once']) {
    const box = page.locator(selector);
    if ((await box.count()) && (await box.isVisible())) {
      const text = await box.innerText();
      if (text && /只显示一次/.test(text)) {
        throw new Error(`${selector} is showing a one-time secret; refusing to screenshot`);
      }
    }
  }
}

async function shot(page, outDir, name) {
  await assertSafeToCapture(page);
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function openListItem(page, title) {
  const button = page.locator('#main-panel button.link', { hasText: title }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
}

async function main() {
  const metaPath = argValue('--meta');
  const outDir = argValue('--out');
  if (!metaPath || !outDir) {
    throw new Error('usage: node scripts/ci_ui_screenshots.mjs --meta DIR --out DIR');
  }
  const ready = JSON.parse(fs.readFileSync(path.join(metaPath, 'ready.json'), 'utf8'));
  const origin = ready.origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error('ready.json origin is not a loopback http URL');
  }
  const { username, password } = readLogin(ready.login_file);
  if (username !== ready.username) {
    throw new Error('login username does not match ready.json');
  }
  fs.mkdirSync(outDir, { recursive: true });

  const checks = {};
  const screenshots = [];
  let failed = false;
  const record = (name, passed, detail = '', { soft = false } = {}) => {
    checks[name] = { passed: Boolean(passed), detail, soft };
    if (!passed && !soft) failed = true;
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const loginPage = await anonymous.newPage();
    await loginPage.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
    await loginPage.locator('#login-panel').waitFor({ state: 'visible', timeout: 15000 });
    const userValue = await loginPage.locator('#username').inputValue();
    const passValue = await loginPage.locator('#password').inputValue();
    record(
      'login_page_empty',
      (await loginPage.locator('#login-panel h2').innerText()) === '登录' && userValue === '' && passValue === '',
      'unauthenticated /settings shows an empty login form',
    );
    screenshots.push(path.basename(await shot(loginPage, outDir, '01-settings-login.png')));
    await anonymous.close();

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const login = await context.request.post(`${origin}/v1/auth/login`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: { username, password },
    });
    record('login_via_api', login.status() === 200, `POST /v1/auth/login returned ${login.status()}`);
    if (login.status() !== 200) {
      throw new Error('fixture login failed');
    }

    const page = await context.newPage();

    await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
    await page.locator('#settings-panel').waitFor({ state: 'visible', timeout: 15000 });
    const who = await visibleText(page.locator('#whoami'));
    const keyState = await visibleText(page.locator('#model-key-state'));
    const appearanceLight = await page.locator('input[name="appearance"][value="light"]').isChecked();
    record(
      'settings_signed_in',
      who === ready.username && appearanceLight && /已保存个人密钥/.test(keyState),
      `whoami=${who || '(empty)'}; keyState=${keyState || '(empty)'}`,
    );
    record(
      'settings_no_api_key_plaintext',
      (await page.locator('#model-api-form input[name="api_key"]').inputValue()) === '' && !/只显示一次/.test(await page.content()),
      'API key field is empty and no one-time secret banner is visible',
    );
    screenshots.push(path.basename(await shot(page, outDir, '02-settings-signed-in.png')));

    await page.goto(`${origin}/agents`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const agentsList = await visibleText(page.locator('#agent-list'));
    record('agents_list', agentsList.includes(ready.agent_name), agentsList || 'agent list empty');
    screenshots.push(path.basename(await shot(page, outDir, '03-agents-list.png')));
    try {
      await openListItem(page, ready.agent_name);
      await page.locator('#edit-form').waitFor({ state: 'visible', timeout: 15000 });
      const nameValue = await page.locator('#edit-form input[name="name"]').inputValue();
      record('agents_editor', nameValue === ready.agent_name, `editor name=${nameValue}`, { soft: true });
      screenshots.push(path.basename(await shot(page, outDir, '04-agents-editor.png')));
    } catch (error) {
      record('agents_editor', false, String(error), { soft: true });
    }

    await page.goto(`${origin}/automations`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const autoList = await visibleText(page.locator('#automation-list'));
    record('automations_list', autoList.includes(ready.automation_title), autoList || 'automation list empty');
    screenshots.push(path.basename(await shot(page, outDir, '05-automations-list.png')));
    try {
      await openListItem(page, ready.automation_title);
      await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#run-panel').waitFor({ state: 'visible', timeout: 15000 });
      const runs = await visibleText(page.locator('#run-list'));
      const emptyRuns = await visibleText(page.locator('#run-empty'));
      const hasHistory = runs.includes(ready.provider_text) || /已完成|运行中|等待已连接的代理/.test(runs);
      record(
        'automations_run_history',
        hasHistory,
        hasHistory ? (runs.slice(0, 200) || 'run list has status text') : (emptyRuns || 'no run history rendered'),
        { soft: true },
      );
      screenshots.push(path.basename(await shot(page, outDir, '06-automations-editor-runs.png')));
    } catch (error) {
      record('automations_run_history', false, String(error), { soft: true });
    }

    await page.goto(`${origin}/artifacts`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const artifacts = await visibleText(page.locator('#artifact-list'));
    record(
      'artifacts_list',
      [ready.document_title, ready.media_title, ready.board_title, ready.website_title].every((title) => artifacts.includes(title)),
      artifacts || 'artifact list empty',
    );
    screenshots.push(path.basename(await shot(page, outDir, '07-artifacts-list.png')));

    const openArtifact = async (title, file, checkName, extra) => {
      try {
        await page.goto(`${origin}/artifacts`, { waitUntil: 'networkidle' });
        await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
        await openListItem(page, title);
        await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 15000 });
        const ok = await extra();
        record(checkName, ok, title, { soft: true });
        screenshots.push(path.basename(await shot(page, outDir, file)));
      } catch (error) {
        record(checkName, false, String(error), { soft: true });
      }
    };
    await openArtifact(ready.document_title, '08-artifacts-document.png', 'artifacts_document', async () => {
      const body = await page.locator('#editor-form textarea[name="body"]').inputValue();
      return body.includes('synthetic CI screenshot fixture text');
    });
    await openArtifact(ready.media_title, '09-artifacts-media.png', 'artifacts_media', async () => {
      const image = page.locator('#media-image');
      await image.waitFor({ state: 'visible', timeout: 15000 });
      return image.isVisible();
    });
    await openArtifact(ready.board_title, '10-artifacts-whiteboard.png', 'artifacts_whiteboard', async () => {
      const canvas = page.locator('#board-canvas');
      await canvas.waitFor({ state: 'visible', timeout: 15000 });
      return canvas.isVisible();
    });
    await openArtifact(ready.website_title, '11-artifacts-website.png', 'artifacts_website', async () => {
      const preview = page.locator('#website-preview');
      await preview.waitFor({ state: 'visible', timeout: 15000 });
      return preview.isVisible();
    });

    await page.goto(`${origin}/members`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const members = await visibleText(page.locator('#member-list'));
    const invites = await visibleText(page.locator('#invite-list'));
    record(
      'members',
      members.includes(ready.username) && members.includes(ready.member_username),
      `members=${members || '(empty)'}; invites=${invites || '(empty)'}`,
    );
    screenshots.push(path.basename(await shot(page, outDir, '12-members.png')));

    await page.goto(`${origin}/team`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const teamHeading = await visibleText(page.locator('h1'));
    const step1 = await page.locator('#wizard-form #step-1').isVisible();
    record('team_wizard', teamHeading.includes('创建团队') && step1, `heading=${teamHeading}`);
    screenshots.push(path.basename(await shot(page, outDir, '13-team-wizard-step1.png')));
    try {
      await page.locator('#wizard-form input[name="name"]').fill('CI Fixture Preview Team');
      await page.locator('#next').click();
      await page.locator('#step-2').waitFor({ state: 'visible', timeout: 10000 });
      record('team_wizard_step2', await page.locator('#step-2').isVisible(), 'name accepted; team ID step visible', { soft: true });
      screenshots.push(path.basename(await shot(page, outDir, '13b-team-wizard-step2.png')));
      await page.locator('#wizard-form input[name="slug"]').fill('ci-preview-team');
      await page.locator('#next').click();
      await page.locator('#step-3').waitFor({ state: 'visible', timeout: 10000 });
      record('team_wizard_step3', await page.locator('#step-3').isVisible(), 'slug accepted; workspace step visible, not submitted', { soft: true });
      screenshots.push(path.basename(await shot(page, outDir, '13c-team-wizard-step3.png')));
    } catch (error) {
      record('team_wizard_steps', false, String(error), { soft: true });
    }

    await page.goto(`${origin}/runtimes`, { waitUntil: 'networkidle' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const runtimeHeading = await visibleText(page.locator('#runtimes-panel h2'));
    record('runtimes', runtimeHeading.includes('自托管 FlyBot'), runtimeHeading || 'runtimes tab missing');
    screenshots.push(path.basename(await shot(page, outDir, '14-runtimes.png')));
    await page.locator('[data-tab="connect"]').click();
    await page.locator('#connect-panel').waitFor({ state: 'visible', timeout: 15000 });
    const keys = await visibleText(page.locator('#key-list'));
    const connections = await visibleText(page.locator('#connection-list'));
    record(
      'runtimes_connect_key_prefix_only',
      keys.includes(ready.runtime_key_name) && keys.includes('…') && !(await page.locator('#issued-token').isVisible()),
      keys || 'key list empty',
    );
    record(
      'runtimes_connection',
      connections.includes(ready.runtime_key_name) && /在线|离线/.test(connections),
      connections || 'connection list empty',
      { soft: true },
    );
    screenshots.push(path.basename(await shot(page, outDir, '15-runtimes-connect.png')));

    await context.close();
  } finally {
    await browser.close();
  }

  const manifest = {
    captured_at: shanghaiStamp(),
    git_sha: ready.git_sha || process.env.GITHUB_SHA || '',
    github_run_id: process.env.GITHUB_RUN_ID || '',
    github_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '',
    origin_kind: 'throwaway GitHub Actions loopback app from this commit',
    ready: {
      username: ready.username,
      workspace_name: ready.workspace_name,
      team_slug: ready.team_slug,
      run_status: ready.run_status,
      connection_status: ready.connection_status,
      note: ready.note,
    },
    screenshots,
    checks,
    limitations: [
      'Captured from a throwaway management app on a GitHub Actions runner, not a local box desktop browser and not production.',
      'Model responses come from a local fake provider, not a real vendor.',
      'Fixture data is synthetic and clearly labeled. Login secrets were not written into this manifest or the PNG artifacts.',
      'This is not a completed Teamily feature-parity comparison and not a real-Docker or real-Bot-Social acceptance.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const hard = Object.entries(checks).filter(([, value]) => !value.passed && !value.soft).map(([name]) => name);
  const soft = Object.entries(checks).filter(([, value]) => !value.passed && value.soft).map(([name]) => name);
  console.log(`screenshots=${screenshots.length} hard_failures=${hard.join(',') || 'none'} soft_failures=${soft.join(',') || 'none'}`);
  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : 'screenshot script failed');
  process.exit(1);
});
