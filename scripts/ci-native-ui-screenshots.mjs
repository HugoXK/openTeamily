import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startNativeUI} from './ci-native-ui.mjs';

const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: ci-native-ui-screenshots.mjs <output-directory>');
await mkdir(output, {recursive:true});
const fixture = await startNativeUI();
const screenshots = [];
const errors = [];
let browser;

async function contextFor(viewport) {
  const context = await browser.newContext({viewport,locale:'zh-CN',reducedMotion:'reduce'});
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return {context,page};
}

async function screenshot(page, name) {
  const dimensions = await page.evaluate(() => ({width:innerWidth, content:document.documentElement.scrollWidth}));
  assert.ok(dimensions.content <= dimensions.width + 1, name + ' has horizontal overflow');
  await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});
  screenshots.push(name+'.png');
  console.log('Captured', name);
}

async function signIn(page, account) {
  const login = page.locator('#login-form');
  await page.goto(fixture.origin+'/login');
  await login.locator('input[name="username"]').fill(account.user.username);
  await login.locator('input[name="password"]').fill(fixture.password);
  await login.locator('button[type="submit"]').click();
  await page.locator('#home-greeting').waitFor({state:'visible'});
  const session = await page.request.get(fixture.origin+'/v1/auth/session');
  assert.equal((await session.json()).user.id, account.user.id);
}

function chatPath({instanceId,agent,chat}) {
  return '/chat#'+new URLSearchParams({workspace:instanceId,agent:agent.id,conversation:chat.id});
}

async function openNative(page, path, instanceId, selector) {
  const response = await page.goto(fixture.origin+path);
  assert.equal(response.status(),200,path);
  assert.equal(await page.locator('meta[name="openteamily-instance"]').getAttribute('content'),instanceId,path);
  await page.locator(selector).waitFor({state:'visible'});
}

async function chat(page, name, send) {
  const owner = fixture.owner;
  await openNative(page,chatPath(owner),owner.instanceId,'#chat-body');
  await page.locator('#chat-title').getByText(owner.chat.name,{exact:true}).waitFor();
  const messages = page.locator('#message-list');
  const composer = page.locator('#chat-body');
  if (send) {
    await composer.fill('这是一条正式的浏览器验收消息');
    const [stream] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/b/api/openteamily/reply-stream'),
      page.locator('#chat-send').click(),
    ]);
    await page.waitForFunction(() => document.querySelector('#chat-body').value === '');
    await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).waitFor();
    assert.equal(stream.headers()['content-type']?.split(';')[0],'text/event-stream');
  }
  await messages.getByText(owner.chat.reply,{exact:true}).waitFor();
  await messages.getByRole('table').getByRole('cell',{name:'通过'}).waitFor();
  await messages.locator('.chat-flowchart').getByText('收到回复',{exact:true}).waitFor();
  assert.equal(await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).count(),1);
  await screenshot(page,name);
}

try {
  browser = await chromium.launch({executablePath:process.env.OT_UI_CHROMIUM_EXECUTABLE});
  const desktop = await contextFor({width:1440,height:900});
  const {page} = desktop;
  await page.goto(fixture.origin+'/login');
  await page.locator('#login-form').waitFor({state:'visible'});
  await screenshot(page,'desktop-login');
  await signIn(page,fixture.owner);
  await screenshot(page,'desktop-home');
  await chat(page,'desktop-chat',true);
  const scenes = [
    ['/settings','#settings-panel','desktop-settings'],
    ['/agents','#agent-search','desktop-agents'],
    ['/space','#artifact-list','desktop-space','CI 合成工作文档'],
    ['/memory','#main-panel','desktop-memory','CI 合成记忆'],
    ['/automations','#list-empty','desktop-automations'],
    ['/meetings','#meetings-empty','desktop-meetings'],
    ['/discover','#main-panel','desktop-discover'],
  ];
  for (const [path,selector,name,expected] of scenes) {
    await openNative(page,path,fixture.owner.instanceId,selector);
    if (expected) await page.getByText(expected,{exact:true}).first().waitFor();
    await screenshot(page,name);
  }
  await openNative(page,'/members#workspace='+fixture.team.workspace_id,fixture.owner.instanceId,'#main-panel');
  await page.locator('#member-list').getByText(fixture.peer.profile.handle.split('.')[0],{exact:true}).first().waitFor();
  await screenshot(page,'desktop-members');
  await openNative(page,chatPath(fixture.owner),fixture.owner.instanceId,'#chat-body');
  await page.locator('#new-conversation').click();
  await page.locator('#compose-new-group').click();
  await page.locator('#compose-mode-team').click();
  await page.locator('#team-template-choices input').first().check();
  await page.locator('#compose-dialog-submit').click();
  await page.locator('#compose-dialog').waitFor({state:'hidden'});
  await page.locator('#chat-title').getByText('产品研发小队',{exact:true}).waitFor();
  await page.locator('#conversation-agents-label').click();
  const roster = page.locator('#group-agent-chips .group-roster-name');
  await roster.filter({hasText:'产品经理助理'}).waitFor();
  assert.equal(await roster.count(),3);
  await screenshot(page,'desktop-template-group');

  const mobile = await contextFor({width:390,height:844});
  await signIn(mobile.page,fixture.owner);
  await chat(mobile.page,'mobile-chat',false);
  await mobile.context.close();

  const peer = await contextFor({width:1440,height:900});
  await signIn(peer.page,fixture.peer);
  assert.notEqual(fixture.peer.instanceId,fixture.owner.instanceId);
  await openNative(peer.page,'/chat',fixture.peer.instanceId,'#session-pane');
  const otherPrivateChat = await peer.page.request.post(fixture.origin+'/b/api/openteamily',{
    data:{endpoint:'agents/v1',payload:{method:'GET',
      path:'/v1/workspaces/'+fixture.owner.instanceId+'/agents/'+fixture.owner.agent.id+'/conversations/'+fixture.owner.chat.id}},
  });
  const isolation = await otherPrivateChat.json();
  assert.equal(isolation.ok,true);
  assert.equal(isolation.value.status,404);
  assert.ok(!JSON.stringify(isolation).includes(fixture.owner.chat.reply));
  await peer.context.close();
  await desktop.context.close();
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'coverage.json'), JSON.stringify({screenshots,privateChatIsolated:true},null,2)+'\n');
} finally {
  await browser?.close();
  await fixture.close();
}
