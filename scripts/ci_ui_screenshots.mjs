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

async function openListItem(page, title, listSelector = '#main-panel') {
  const button = page.locator(`${listSelector} button.link`, { hasText: title }).first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
}

async function waitForInputValue(page, selector, expected, timeout = 15000) {
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector, expected },
    { timeout },
  );
}

async function waitForLocatorText(page, selector, expected, timeout = 15000) {
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    ({ selector, expected }) => (document.querySelector(selector)?.innerText || '').includes(expected),
    { selector, expected },
    { timeout },
  );
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
    // Wait for `load`, not a quiet network: shell and page scripts issue
    // same-origin API calls after load, which can prevent a quiet-network wait
    // from ever finishing on the loopback runner.
    await loginPage.goto(`${origin}/settings`, { waitUntil: 'load' });
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

    await page.goto(`${origin}/settings`, { waitUntil: 'load' });
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

    await page.goto(`${origin}/agents`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    let agentsList = '';
    try {
      await waitForLocatorText(page, '#agent-list', ready.agent_name);
      agentsList = await visibleText(page.locator('#agent-list'));
    } catch (error) {
      agentsList = String(error);
    }
    record('agents_list', agentsList.includes(ready.agent_name), agentsList || 'agent list empty');
    screenshots.push(path.basename(await shot(page, outDir, '03-agents-list.png')));
    try {
      await openListItem(page, ready.agent_name, '#agent-list');
      await page.locator('#edit-form').waitFor({ state: 'visible', timeout: 15000 });
      await waitForInputValue(page, '#edit-form input[name="name"]', ready.agent_name);
      const nameValue = await page.locator('#edit-form input[name="name"]').inputValue();
      record('agents_editor', nameValue === ready.agent_name, `editor name=${nameValue}`);
      screenshots.push(path.basename(await shot(page, outDir, '04-agents-editor.png')));
    } catch (error) {
      record('agents_editor', false, String(error));
    }

    try {
      await page.locator('#chat-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#chat-title', ready.agent_name);
      await openListItem(page, ready.conversation_title, '#conversation-list');
      await waitForLocatorText(page, '#message-list', ready.chat_user_text);
      await waitForLocatorText(page, '#message-list', ready.provider_text, 20000);
      const history = await visibleText(page.locator('#message-list'));
      record(
        'agents_conversation_history',
        history.includes(ready.chat_user_text) && history.includes(ready.provider_text),
        history.slice(0, 240) || 'conversation history empty',
        { soft: ready.chat_status !== 'succeeded' },
      );
      screenshots.push(path.basename(await shot(page, outDir, '16-agents-conversation.png')));
    } catch (error) {
      record('agents_conversation_history', false, String(error), { soft: ready.chat_status !== 'succeeded' });
    }

    try {
      await page.locator('#new-conversation').click();
      await page.locator('#chat-body').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#chat-body').fill(ready.chat_live_text);
      await page.locator('#chat-form button[type="submit"]').click();
      await waitForLocatorText(page, '#message-list', ready.chat_live_text, 15000);
      await waitForLocatorText(page, '#message-list', ready.provider_text, 20000);
      const live = await visibleText(page.locator('#message-list'));
      record(
        'agents_conversation_send',
        live.includes(ready.chat_live_text) && live.includes(ready.provider_text),
        live.slice(0, 240) || 'live conversation empty',
        { soft: ready.connection_status !== 'online' },
      );
      screenshots.push(path.basename(await shot(page, outDir, '17-agents-conversation-send.png')));
    } catch (error) {
      record('agents_conversation_send', false, String(error), { soft: ready.connection_status !== 'online' });
    }

    await page.goto(`${origin}/automations`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    let autoList = '';
    try {
      await waitForLocatorText(page, '#automation-list', ready.automation_title);
      autoList = await visibleText(page.locator('#automation-list'));
    } catch (error) {
      autoList = String(error);
    }
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

    await page.goto(`${origin}/artifacts`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    const artifactTitles = [ready.document_title, ready.media_title, ready.board_title, ready.website_title];
    let artifacts = '';
    try {
      for (const title of artifactTitles) {
        await waitForLocatorText(page, '#artifact-list', title);
      }
      artifacts = await visibleText(page.locator('#artifact-list'));
    } catch (error) {
      artifacts = String(error);
    }
    record(
      'artifacts_list',
      artifactTitles.every((title) => artifacts.includes(title)),
      artifacts || 'artifact list empty',
    );
    screenshots.push(path.basename(await shot(page, outDir, '07-artifacts-list.png')));

    const openArtifact = async (title, file, checkName, extra, { soft = true } = {}) => {
      try {
        await page.goto(`${origin}/artifacts`, { waitUntil: 'load' });
        await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
        await page.locator('#artifact-list').waitFor({ state: 'visible', timeout: 15000 });
        await openListItem(page, title, '#artifact-list');
        await page.locator('#editor-form').waitFor({ state: 'visible', timeout: 15000 });
        await waitForInputValue(page, '#editor-form input[name="title"]', title);
        const ok = await extra();
        record(checkName, ok, title, { soft });
        screenshots.push(path.basename(await shot(page, outDir, file)));
      } catch (error) {
        record(checkName, false, String(error), { soft });
      }
    };
    await openArtifact(ready.document_title, '08-artifacts-document.png', 'artifacts_document', async () => {
      await waitForInputValue(page, '#editor-form textarea[name="body"]', ready.document_body);
      const body = await page.locator('#editor-form textarea[name="body"]').inputValue();
      return body === ready.document_body;
    }, { soft: false });
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

    await page.goto(`${origin}/members`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    let members = '';
    let invites = '';
    try {
      await waitForLocatorText(page, '#member-list', ready.username);
      await waitForLocatorText(page, '#member-list', ready.member_username);
      members = await visibleText(page.locator('#member-list'));
      invites = await visibleText(page.locator('#invite-list'));
    } catch (error) {
      members = members || String(error);
    }
    record(
      'members',
      members.includes(ready.username) && members.includes(ready.member_username),
      `members=${members || '(empty)'}; invites=${invites || '(empty)'}`,
    );
    screenshots.push(path.basename(await shot(page, outDir, '12-members.png')));

    await page.goto(`${origin}/team`, { waitUntil: 'load' });
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

    await page.goto(`${origin}/runtimes`, { waitUntil: 'load' });
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

    await page.goto(`${origin}/memory`, { waitUntil: 'load' });
    await page.locator('#main-panel').waitFor({ state: 'visible', timeout: 15000 });
    await waitForLocatorText(page, '#memory-list', ready.memory_title);
    await waitForLocatorText(page, '#action-list', ready.action_title);
    const memoryList = await visibleText(page.locator('#memory-list'));
    const actionList = await visibleText(page.locator('#action-list'));
    record('memory_list', memoryList.includes(ready.memory_title), memoryList || 'memory list empty');
    record(
      'actions_list',
      actionList.includes(ready.action_title) && actionList.includes('未完成') && actionList.includes(ready.action_due),
      actionList || 'action list empty',
    );
    screenshots.push(path.basename(await shot(page, outDir, '18-memory-list.png')));

    try {
      await page.locator('#memory-list button', { hasText: ready.memory_title }).first().click();
      await waitForInputValue(page, '#editor-form input[name="title"]', ready.memory_title);
      await waitForInputValue(page, '#editor-form textarea[name="body"]', ready.memory_body);
      record('memory_editor_seeded', true, await visibleText(page.locator('#editor-meta')));
      await page.locator('#close-editor').click();
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
    } catch (error) {
      record('memory_editor_seeded', false, String(error));
    }

    try {
      await page.locator('#new-title').fill(ready.memory_create_title);
      await page.locator('#new-page').click();
      await waitForInputValue(page, '#editor-form input[name="title"]', ready.memory_create_title);
      await waitForLocatorText(page, '#status', '已创建记忆页');
      await page.locator('#editor-form textarea[name="body"]').fill(ready.memory_create_body);
      await page.locator('#save-page').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#editor-meta', '修订 2');
      await page.locator('#editor-form input[name="title"]').fill(ready.memory_edited_title);
      await page.locator('#editor-form textarea[name="body"]').fill(ready.memory_edited_body);
      await page.locator('#save-page').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#editor-meta', '修订 3');
      await waitForInputValue(page, '#editor-form input[name="title"]', ready.memory_edited_title);
      await waitForInputValue(page, '#editor-form textarea[name="body"]', ready.memory_edited_body);
      const memoryMeta = await visibleText(page.locator('#editor-meta'));
      record(
        'memory_create_edit',
        memoryMeta.includes('修订 3') && memoryMeta.includes(ready.username),
        memoryMeta,
      );
      screenshots.push(path.basename(await shot(page, outDir, '19-memory-editor.png')));
    } catch (error) {
      record('memory_create_edit', false, String(error));
    }

    try {
      await page.locator('#delete-page').click();
      await waitForLocatorText(page, '#status', '已删除');
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#memory-list', ready.memory_title);
      const memoryAfterDelete = await visibleText(page.locator('#memory-list'));
      record(
        'memory_delete',
        memoryAfterDelete.includes(ready.memory_title)
          && !memoryAfterDelete.includes(ready.memory_edited_title)
          && !memoryAfterDelete.includes(ready.memory_create_title),
        memoryAfterDelete || 'memory list empty after delete',
      );
    } catch (error) {
      record('memory_delete', false, String(error));
    }

    try {
      await page.locator('#new-action-title').fill(ready.action_create_title);
      await page.locator('#new-action-notes').fill(ready.action_create_notes);
      await page.locator('#new-action-due').fill(ready.action_create_due);
      await page.locator('#new-action-page').selectOption({ label: ready.memory_title });
      await page.locator('#new-action').click();
      await waitForInputValue(page, '#action-editor-form input[name="title"]', ready.action_create_title);
      await waitForLocatorText(page, '#status', '已创建下一步行动');
      await page.locator('#action-editor-form input[name="title"]').fill(ready.action_edited_title);
      await page.locator('#action-editor-form textarea[name="notes"]').fill(ready.action_edited_notes);
      await page.locator('#save-action').click();
      await waitForLocatorText(page, '#status', '已保存');
      await waitForLocatorText(page, '#action-editor-meta', '修订 2');
      await waitForInputValue(page, '#action-editor-form input[name="title"]', ready.action_edited_title);
      await waitForInputValue(page, '#action-editor-form textarea[name="notes"]', ready.action_edited_notes);
      const actionMeta = await visibleText(page.locator('#action-editor-meta'));
      const actionDue = await page.locator('#action-editor-form input[name="due"]').inputValue();
      record(
        'action_create_edit',
        actionMeta.includes('修订 2') && actionMeta.includes(ready.username) && actionDue === ready.action_create_due,
        `${actionMeta} due=${actionDue}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '20-action-editor.png')));
    } catch (error) {
      record('action_create_edit', false, String(error));
    }

    try {
      await page.locator('#delete-action').click();
      await waitForLocatorText(page, '#status', '已删除');
      await page.locator('#list-panel').waitFor({ state: 'visible', timeout: 15000 });
      await waitForLocatorText(page, '#action-list', ready.action_title);
      const memoryFinal = await visibleText(page.locator('#memory-list'));
      const actionAfterDelete = await visibleText(page.locator('#action-list'));
      record(
        'action_delete',
        memoryFinal.includes(ready.memory_title)
          && !memoryFinal.includes(ready.memory_edited_title)
          && actionAfterDelete.includes(ready.action_title)
          && actionAfterDelete.includes('未完成')
          && !actionAfterDelete.includes(ready.action_edited_title)
          && !actionAfterDelete.includes(ready.action_create_title),
        `memory=${memoryFinal || 'empty'} action=${actionAfterDelete || 'empty'}`,
      );
      screenshots.push(path.basename(await shot(page, outDir, '21-memory-after-delete.png')));
    } catch (error) {
      record('action_delete', false, String(error));
    }

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
      chat_status: ready.chat_status,
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
