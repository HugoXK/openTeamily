import assert from 'node:assert/strict';
import test from 'node:test';
import {mountTeamRuns, removeDraftStep, teamRunDraftFromHistory, teamRunPayload, teamRunTarget} from '../openteamily/static/team-runs/app.mjs';

const WS = 'a'.repeat(32);
const OTHER_WS = 'b'.repeat(32);
const RUN = 'c'.repeat(32);
const AGENT = 'd'.repeat(32);
const OTHER_AGENT = 'e'.repeat(32);
const BASE = `/v1/workspaces/${WS}/team-runs`;
const AGENTS = [{id: AGENT, name: '研究员'}, {id: OTHER_AGENT, name: '校对员'}];
const step = (key, id, instruction, dependencies = []) => ({key, agent: id, instruction, dependencies: new Set(dependencies)});

test('team run addresses allow exact workspace, private run or shared snapshot', () => {
  const shared = 'otsr_' + 'R'.repeat(26);
  assert.deepEqual(teamRunTarget(''), {});
  assert.deepEqual(teamRunTarget('#workspace=' + WS), {workspace: WS});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&run=${RUN}`), {workspace: WS, run: RUN});
  assert.deepEqual(teamRunTarget(`#workspace=${WS}&shared=${shared}`), {workspace: WS, shared});
  for (const bad of [`#run=${RUN}`, `#workspace=${WS}&run=${RUN}&shared=${shared}`,
    `#workspace=${WS}&workspace=${OTHER_WS}`, `#workspace=${WS}&run=wrong`]) {
    assert.deepEqual(teamRunTarget(bad), {invalid: true});
  }
});

test('draft validates local agents and exports dependencies only to earlier steps', () => {
  const draft = {title: ' 归纳反馈 ', goal: ' 组织建议 ', steps: [
    step(10, AGENT, ' 收集反馈 '),
    step(11, OTHER_AGENT, ' 编写总结 ', [10]),
  ]};
  assert.deepEqual(teamRunPayload(draft, AGENTS), {
    title: '归纳反馈', goal: '组织建议', steps: [
      {agent_id: AGENT, instruction: '收集反馈', depends_on: []},
      {agent_id: OTHER_AGENT, instruction: '编写总结', depends_on: [0]},
    ],
  });
  assert.equal(teamRunPayload(draft, AGENTS.slice(0, 1)), null);
  assert.equal(teamRunPayload({...draft, steps: draft.steps.slice(0, 1)}, AGENTS), null);
  draft.steps[0].dependencies.add(11);
  assert.equal(teamRunPayload(draft, AGENTS), null, 'future dependencies cannot leave the editor');
});

test('removing a draft step removes its own dependencies while stable keys keep unrelated inputs', () => {
  const draft = {title: '计划', goal: '明确步骤', steps: [
    step(41, AGENT, '搜集材料'), step(42, OTHER_AGENT, '再次核对'), step(43, AGENT, '出稿', [41, 42]),
  ]};
  const remaining = removeDraftStep(draft.steps, 41);
  const payload = teamRunPayload({...draft, steps: remaining}, AGENTS);
  assert.deepEqual(payload.steps.map(item => [item.instruction, item.depends_on]), [['再次核对', []], ['出稿', [0]]]);
  assert.equal(removeDraftStep(remaining, 42), remaining);
});

test('terminal run reuse carries definition and dependency identities without copying live state or output', () => {
  let serial = 40;
  const source = {id:RUN, status:'failed', title:'流程'.repeat(39)+'😀', goal:'处理下一轮反馈',
    steps:[{position:0,agent_id:AGENT,instruction:'搜集',depends_on:[],output:'private result',attempts:2},
      {position:1,agent_id:OTHER_AGENT,instruction:'复核',depends_on:[0],status:'blocked'}]};
  const draft = teamRunDraftFromHistory(source, () => ++serial);
  assert.ok(draft.title.length <= 80 && draft.title.endsWith('（副本）') && draft.title.isWellFormed());
  assert.deepEqual(draft.steps, [step(41,AGENT,'搜集'),step(42,OTHER_AGENT,'复核',[41])]);
  assert.equal(draft.sourceRun,RUN);
  assert.equal(draft.goal,source.goal);
  assert.ok(!JSON.stringify(draft).includes('private result'));
  assert.equal(teamRunDraftFromHistory({...source,status:'running'}, () => ++serial),null);
  source.steps[1].depends_on = [1];
  assert.equal(teamRunDraftFromHistory(source, () => ++serial),null);
});

function fixture(hash = '') {
  const nodes = new Map();
  const document = {activeElement: null, cookie: ''};
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.dataset = {};
      this.children = [];
      this.events = {};
      this.value = '';
      this.textContent = '';
    }
    get childElementCount() { return this.children.length; }
    addEventListener(type, handler) { this.events[type] = handler; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    focus() { document.activeElement = this; }
  }
  const node = id => {
    if (['team-shared-runs', 'share-team-run'].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  document.getElementById = node;
  document.createElement = name => new Element(name);
  document.querySelectorAll = () => [];
  const location = {hash};
  document.defaultView = {
    location, crypto: globalThis.crypto,
    addEventListener() {},
    history: {pushState(_state, _title, next) { location.hash = next; }},
  };
  return {document, node};
}

const ok = (body, status = 200) => ({status, json: async () => body});
const user = {id: 'f'.repeat(32), username: 'author'};
const workspace = {id: WS, name: '个人工作区', kind: 'personal'};
const alternate = {id: OTHER_WS, name: '协同工作区', kind: 'team'};
const run = {id: RUN, workspace_id: WS, status: 'failed', title: '正式任务', progress: {total: 2, succeeded: 0},
  steps: [{position: 0, status: 'failed', attempts: 1, agent_name: '研究员', instruction: '归纳', depends_on: []},
    {position: 1, status: 'blocked', attempts: 0, agent_name: '校对员', instruction: '复核', depends_on: [0]}]};
const baseRead = path => {
  if (path === '/v1/auth/session') return ok({user});
  if (path === '/v1/workspaces?scope=personal') return ok({items: [workspace]});
  if (path === '/v1/workspaces?limit=100') return ok({items: [workspace, alternate]});
};
const input = (element, value, type = 'input') => { element.value = value; element.events[type](); };

test('startup overlaps account and workspace reads before rendering private tasks', async () => {
  const {document, node} = fixture();
  const authenticate = Promise.withResolvers();
  const calls = [];
  const mounted = mountTeamRuns(document, async path => {
    calls.push(path);
    if (path === '/v1/auth/session') return authenticate.promise;
    if (path === BASE) return ok({items: []});
    return baseRead(path);
  });
  assert.deepEqual(calls, ['/v1/auth/session', '/v1/workspaces?scope=personal', '/v1/workspaces?limit=100']);
  assert.equal(node('team-run-list').children.length, 0);
  authenticate.resolve(ok({user}));
  await mounted;
  assert.equal(calls.at(-1), BASE);
  assert.equal(node('team-runs-workspace').value, WS);
});

test('a lost create response leaves the same form locked until the exact request is confirmed', async () => {
  const {document, node} = fixture();
  const posts = [];
  await mountTeamRuns(document, async (path, options) => {
    const base = baseRead(path);
    if (base) return base;
    if (path === `/v1/workspaces/${WS}/agents?limit=100`) return ok({items: AGENTS});
    if (path === BASE && options.method === 'GET') return ok({items: []});
    if (path === BASE && options.method === 'POST') {
      posts.push({key: options.headers['Idempotency-Key'], body: JSON.parse(options.body)});
      if (posts.length === 1) throw new TypeError('response lost');
      return ok({run});
    }
    throw new Error(path);
  });
  await node('team-runs-new').events.click();
  input(node('team-run-title'), '正式任务');
  input(node('team-run-goal'), '处理请求');
  for (const [index, row] of node('team-run-steps').children.entries()) {
    input(row.children[1].children[0], AGENTS[index].id, 'change');
    input(row.children[2].children[0], '完成第 ' + (index + 1) + ' 步');
  }
  const submit = () => node('team-run-form').events.submit({preventDefault() {}});
  await submit();
  assert.equal(node('team-run-start').textContent, '确认并重试');
  assert.equal(node('team-run-fields').disabled, true);
  assert.match(node('team-run-start-status').textContent, /无法确认/);
  await submit();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.match(posts[0].key, /^team-run-[a-f0-9]{32}$/);
  assert.equal(node('team-run-detail').hidden, false);
  assert.match(node('team-run-progress').textContent, /失败/);
  assert.equal(document.defaultView.location.hash, `#workspace=${WS}&run=${RUN}`);
});

test('a delayed exact result cannot replace the list after switching workspaces', async () => {
  const {document, node} = fixture(`#workspace=${WS}&run=${RUN}`);
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const mounted = mountTeamRuns(document, async path => {
    const base = baseRead(path);
    if (base) return base;
    if (path === BASE + '/' + RUN) {
      started.resolve();
      return pending.promise;
    }
    if (path === `/v1/workspaces/${OTHER_WS}/team-runs`) return ok({items: []});
    throw new Error(path);
  });
  await started.promise;
  node('team-runs-workspace').value = OTHER_WS;
  await node('team-runs-workspace').events.change();
  pending.resolve(ok({run}));
  await mounted;
  assert.equal(node('team-run-detail').hidden, true);
  assert.equal(node('team-run-list-panels').hidden, false);
  assert.equal(node('team-run-results').children.length, 0);
  assert.equal(document.defaultView.location.hash, '#workspace=' + OTHER_WS);
});

test('transient read errors keep visible results, but permission loss clears task output and actions', async () => {
  const {document, node} = fixture(`#workspace=${WS}&run=${RUN}`);
  let status = 200;
  const finished = {...run, status: 'succeeded', goal: '团队目标', steps: [
    {...run.steps[0], status: 'succeeded', output: '属于原工作区的结果'},
    {...run.steps[1], status: 'succeeded', output: '复核后的结果'},
  ]};
  await mountTeamRuns(document, async path => baseRead(path) || ok(status === 200 ? {run: finished} : {}, status));
  assert.equal(node('team-run-results').children.length, 2);
  assert.equal(node('team-run-remove').hidden, false);
  status = 503;
  await node('team-runs-refresh').events.click();
  assert.equal(node('team-run-results').children.length, 2);
  status = 403;
  await node('team-runs-refresh').events.click();
  assert.equal(node('team-run-results').children.length, 0);
  assert.equal(node('team-run-goal-detail').textContent, '');
  assert.equal(node('team-run-remove').hidden, true);
  assert.equal(node('team-runs-new').disabled, true);
  assert.match(node('team-run-status').textContent, /没有权限/);
});
