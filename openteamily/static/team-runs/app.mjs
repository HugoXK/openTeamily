import {readWorkspaceChoices} from '../shell/dsbot-api.mjs';
import {spaceHref} from '../shell/thumb.mjs';
import {createTeamRunShares} from './shares.mjs';

const ID = /^[a-f0-9]{32}$/;
const SHARED_ID = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const LIMITS = {minimum: 2, maximum: 8, title: 80, goal: 2000, instruction: 1000, attempts: 3};
const STATUS = {
  waiting: '等待前序步骤', queued: '已排队', running: '运行中', succeeded: '已完成',
  failed: '失败', blocked: '前序步骤未完成', cancelled: '已取消',
};
const STEP_ERROR = {
  agent_unavailable: '智能体已归档或不可用。',
  empty_reply: '智能体没有返回内容。',
  interrupted: '运行环境重启，此步骤已中断。',
  model_unconfigured: '当前没有可用的模型配置。',
  runtime_unavailable: '当前运行环境不可用。',
  timeout: '该步骤运行超时。',
  runtime_failed: '运行时未能完成此步骤。',
  workspace_unavailable: '运行时已失去对该工作区的访问权限。',
};

export function teamRunTarget(hash = '') {
  if (!hash || hash === '#') return {};
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const workspace = params.get('workspace'), run = params.get('run'), shared = params.get('shared');
  if (!ID.test(workspace || '') || (run !== null && shared !== null) || params.size !== (run === null && shared === null ? 1 : 2)
      || (run !== null && !ID.test(run)) || (shared !== null && !SHARED_ID.test(shared))) return {invalid: true};
  return {workspace, ...(run ? {run} : {}), ...(shared ? {shared} : {})};
}

export function teamRunPayload(draft, agents) {
  const title = draft.title.trim(), goal = draft.goal.trim();
  if (!title || title.length > LIMITS.title || !goal || goal.length > LIMITS.goal ||
      draft.steps.length < LIMITS.minimum || draft.steps.length > LIMITS.maximum) return null;
  const positions = new Map(draft.steps.map((step, index) => [step.key, index]));
  const available = new Set(agents.map(agent => agent.id));
  if (positions.size !== draft.steps.length) return null;
  const steps = [];
  for (const [index, step] of draft.steps.entries()) {
    const instruction = step.instruction.trim();
    const depends_on = [...step.dependencies].map(key => positions.get(key));
    if (!ID.test(step.agent) || !available.has(step.agent) || !instruction || instruction.length > LIMITS.instruction ||
        depends_on.some(position => position === undefined || position >= index)) return null;
    steps.push({agent_id: step.agent, instruction, depends_on: depends_on.sort((a, b) => a - b)});
  }
  return {title, goal, steps};
}

export function removeDraftStep(steps, key) {
  if (steps.length <= LIMITS.minimum) return steps;
  const remaining = steps.filter(step => step.key !== key);
  for (const step of remaining) step.dependencies.delete(key);
  return remaining;
}

function errorMessage(result, fallback) {
  if (result.status === 401) return '登录已失效，请重新登录。';
  if (result.status === 403) return '你没有权限操作此工作区的任务。';
  if (result.status === 404) return '找不到这条团队任务。';
  if (result.status === 429) return '已达到运行或重试上限。';
  return fallback;
}

function isUncertain(status) {
  return status === 0 || status === 408 || status >= 500;
}

const cannotRead = status => status === 401 || status === 403 || status === 404;

function matchesRun(run, workspace, id = run?.id) {
  return ID.test(id || '') && run?.id === id && run.workspace_id === workspace;
}

export function mountTeamRuns(document, fetcher = globalThis.fetch.bind(globalThis)) {
  const view = document.defaultView;
  const node = id => document.getElementById(id);
  const main = node('main-panel');
  const picker = node('team-runs-workspace');
  const start = node('team-run-start');
  const newRun = node('team-runs-new');
  const editor = node('team-run-form');
  const detail = node('team-run-detail');
  const listView = node('team-run-list-panels');
  const cancel = node('team-run-cancel');
  const remove = node('team-run-remove');
  const confirm = node('team-run-confirm');
  const title = node('team-run-title');
  const goal = node('team-run-goal');
  const drafts = new Map();
  const creates = new Map();
  const saved = new Map();
  let viewer, spaces = [], workspace = '', screen = '', detailId = '';
  let personalSpaces = new Set();
  let epoch = 0, reads = 0, auth = 0, serial = 0;
  let current, currentDraft, tasks = [], agents = [];
  let timer, doing = '', question = '', lastList = '', lastSteps = '';

  function show(id, text, kind = '') {
    const element = node(id);
    if (element.textContent !== text) element.textContent = text;
    element.dataset.kind = kind;
  }

  function make(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(text, type = 'secondary') {
    const element = make('button', text, type);
    element.type = 'button';
    return element;
  }

  async function request(method, path, body, extra) {
    const headers = {Accept: 'application/json', ...extra};
    try {
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        const csrf = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(document.cookie);
        headers['X-CSRF-Token'] = csrf ? decodeURIComponent(csrf[1]) : '';
      }
      const response = await fetcher(path, {method, headers, credentials: 'same-origin',
        signal: globalThis.AbortSignal?.timeout?.(12000),
        body: body === undefined ? undefined : JSON.stringify(body)});
      const payload = await response.json().catch(() => null);
      return {status: response.status, body: payload || {}};
    } catch {
      return {status: 0, body: {}};
    }
  }

  const shares = createTeamRunShares({document, request});
  const pathFor = (id = workspace) => `/v1/workspaces/${id}/team-runs`;
  const scope = () => ({viewer, workspace, epoch});
  const active = target => target.viewer === viewer && target.workspace === workspace && target.epoch === epoch;
  const savedKey = step => workspace + '/' + detailId + '/' + step.position;

  function updateLocation(run = '') {
    if (!workspace || !view?.history) return;
    const hash = '#' + new URLSearchParams({workspace, ...(run ? {run} : {})});
    if (view.location.hash !== hash) view.history.pushState(null, '', hash);
  }

  function hideQuestion(refocus = false) {
    const trigger = question === 'cancel' ? cancel : remove;
    question = '';
    confirm.hidden = true;
    if (refocus && !trigger.hidden) trigger.focus();
  }

  function syncShareWorkspace() {
    shares.selectWorkspace(screen && !personalSpaces.has(workspace) ? spaces.find(item => item.id === workspace) : null);
  }

  function clearInaccessibleRunData() {
    current = null;
    tasks = [];
    lastList = lastSteps = '';
    newRun.disabled = true;
    cancel.hidden = remove.hidden = true;
    hideQuestion();
    node('team-run-list').replaceChildren();
    node('team-runs-empty').hidden = true;
    node('team-run-results').replaceChildren();
    node('team-run-heading').textContent = '任务详情';
    node('team-run-goal-detail').textContent = '';
    show('team-run-progress', '');
    for (const key of saved.keys()) if (key.startsWith(workspace + '/')) saved.delete(key);
    shares.selectRun(null);
    shares.selectWorkspace(null);
  }

  function changeScreen(next, id = '') {
    epoch += 1;
    clearTimeout(timer);
    doing = '';
    detailId = id;
    current = null;
    screen = next;
    lastList = lastSteps = '';
    listView.hidden = next !== 'list';
    editor.hidden = next !== 'editor';
    detail.hidden = next !== 'detail';
    newRun.hidden = next === 'editor';
    newRun.disabled = !workspace;
    show('team-run-status', '');
    show('team-run-start-status', '');
    hideQuestion();
    syncShareWorkspace();
    shares.selectRun(null);
  }

  function afterPoll(work) {
    clearTimeout(timer);
    timer = setTimeout(work, document.hidden ? 8000 : screen === 'detail' ? 1600 : 3500);
  }

  function renderList(items) {
    const list = node('team-run-list');
    node('team-runs-empty').hidden = items.length > 0;
    const fingerprint = JSON.stringify(items);
    if (fingerprint === lastList) return;
    lastList = fingerprint;
    const focusedId = document.activeElement?.dataset.runId;
    list.replaceChildren();
    for (const item of items) {
      const row = make('li');
      const open = button(item.title, 'team-run-row');
      open.dataset.runId = item.id;
      const name = make('strong', item.title);
      const counts = item.progress || {};
      const progress = make('span', `${counts.succeeded ?? 0}/${counts.total ?? 0} 步完成`, 'note');
      const status = make('span', STATUS[item.status], 'team-run-pill');
      status.dataset.state = item.status;
      open.replaceChildren(name, progress, status);
      open.addEventListener('click', () => openDetail(item.id));
      row.append(open);
      list.append(row);
      if (focusedId === item.id) open.focus({preventScroll: true});
    }
  }

  async function loadList() {
    clearTimeout(timer);
    if (!workspace) return;
    const target = scope(), read = ++reads;
    const result = await request('GET', pathFor());
    if (!active(target) || read !== reads) return;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      if (cannotRead(result.status)) clearInaccessibleRunData();
      show('status', errorMessage(result, '无法加载任务列表，点击刷新重试。'), 'error');
    } else {
      tasks = result.body.items.filter(item => matchesRun(item, workspace));
      newRun.disabled = false;
      syncShareWorkspace();
      show('status', '');
      renderList(tasks);
    }
    if (tasks.some(item => item.status === 'running')) afterPoll(loadList);
  }

  function showList({address = true, focus = false} = {}) {
    changeScreen('list');
    tasks = [];
    node('team-run-list').replaceChildren();
    node('team-runs-empty').hidden = true;
    if (address) updateLocation();
    if (focus) node('team-runs-list-heading').focus();
    if (workspace) {
      show('status', '正在读取任务…');
      return loadList();
    }
  }

  function blankStep() {
    return {key: ++serial, agent: '', instruction: '', dependencies: new Set()};
  }

  function blankDraft() {
    return {title: '', goal: '', steps: [blankStep(), blankStep()]};
  }

  function editorControls() {
    const attempt = creates.get(workspace);
    node('team-run-fields').disabled = Boolean(attempt);
    start.disabled = Boolean(attempt?.sending || (!attempt && !agents.length));
    start.textContent = attempt?.sending ? '正在启动…' : attempt ? '确认并重试' : '开始运行';
    node('team-run-add-step').disabled = currentDraft.steps.length >= LIMITS.maximum;
  }

  function renderDraft(focusKey) {
    const container = node('team-run-steps');
    container.replaceChildren();
    for (const [index, item] of currentDraft.steps.entries()) {
      const group = make('fieldset', '', 'step-draft');
      const legend = make('legend', `第 ${index + 1} 步`);
      const agentLabel = make('label', '智能体');
      const select = make('select');
      select.required = true;
      select.dataset.stepAgent = '';
      const choice = make('option', '选择智能体');
      choice.value = '';
      select.append(choice);
      for (const agent of agents) {
        const option = make('option', agent.name);
        option.value = agent.id;
        select.append(option);
      }
      if (item.agent && !agents.some(agent => agent.id === item.agent)) {
        const unavailable = make('option', '当前智能体不可用');
        unavailable.value = item.agent;
        select.append(unavailable);
      }
      select.value = item.agent;
      select.addEventListener('change', () => { item.agent = select.value; });
      agentLabel.append(select);
      const instructionLabel = make('label', '任务指令');
      const instruction = make('textarea');
      instruction.required = true;
      instruction.maxLength = LIMITS.instruction;
      instruction.rows = 2;
      instruction.value = item.instruction;
      instruction.dataset.stepInstruction = '';
      instruction.addEventListener('input', () => { item.instruction = instruction.value; });
      instructionLabel.append(instruction);
      group.append(legend, agentLabel, instructionLabel);
      if (index > 0) {
        const dependencies = make('fieldset', '', 'step-dependencies');
        dependencies.append(make('legend', '引用前序结果'));
        for (const [position, prior] of currentDraft.steps.slice(0, index).entries()) {
          const label = make('label', '', 'step-dependency');
          const check = make('input');
          check.type = 'checkbox';
          check.checked = item.dependencies.has(prior.key);
          check.dataset.dependencyPosition = String(position);
          check.addEventListener('change', () => {
            if (check.checked) item.dependencies.add(prior.key);
            else item.dependencies.delete(prior.key);
          });
          label.append(check, `第 ${position + 1} 步`);
          dependencies.append(label);
        }
        group.append(dependencies);
      }
      if (currentDraft.steps.length > LIMITS.minimum) {
        const drop = button('移除这一步');
        drop.classList.add('step-remove');
        drop.addEventListener('click', () => {
          currentDraft.steps = removeDraftStep(currentDraft.steps, item.key);
          renderDraft(currentDraft.steps[Math.min(index, currentDraft.steps.length - 1)]?.key);
        });
        group.append(drop);
      }
      container.append(group);
      if (focusKey === item.key) select.focus();
    }
    editorControls();
  }

  async function loadAgents() {
    const target = scope(), read = ++reads;
    show('team-run-agent-status', '正在读取本工作区的智能体…');
    const result = await request('GET', `/v1/workspaces/${workspace}/agents?limit=100`);
    if (!active(target) || read !== reads) return;
    const ok = result.status === 200 && Array.isArray(result.body.items);
    agents = ok ? result.body.items.filter(agent => ID.test(agent?.id || '') && !agent.archived &&
      (!agent.workspace_id || agent.workspace_id === workspace)) : [];
    show('team-run-agent-status', agents.length ? '' : ok
      ? '当前工作区没有可用智能体。请先到智能体页面创建或恢复，再返回刷新。'
      : '无法读取智能体。点击刷新重试。', agents.length || ok ? '' : 'error');
    renderDraft();
  }

  function showEditor() {
    if (!workspace) return;
    changeScreen('editor');
    updateLocation();
    if (!drafts.has(workspace)) drafts.set(workspace, blankDraft());
    currentDraft = drafts.get(workspace);
    title.value = currentDraft.title;
    goal.value = currentDraft.goal;
    agents = [];
    renderDraft();
    if (creates.has(workspace)) show('team-run-start-status', '暂时无法确认任务是否已创建。重试会核对原请求。', 'error');
    show('status', '');
    node('team-run-form-heading').focus();
    return loadAgents();
  }

  async function startRun(event) {
    event.preventDefault();
    if (screen !== 'editor' || !workspace) return;
    const target = scope();
    let attempt = creates.get(workspace);
    if (attempt?.sending) return;
    if (!attempt) {
      const payload = teamRunPayload(currentDraft, agents);
      if (!payload) {
        show('team-run-start-status', '请填写目标和每一步任务指令，并选择可用智能体。', 'error');
        return;
      }
      const key = Array.from(view.crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
      attempt = {payload, key: 'team-run-' + key, draft: currentDraft};
      creates.set(workspace, attempt);
    }
    attempt.sending = true;
    editorControls();
    show('team-run-start-status', '正在启动任务…');
    const result = await request('POST', pathFor(target.workspace), attempt.payload, {'Idempotency-Key': attempt.key});
    if (creates.get(target.workspace) !== attempt) return;
    attempt.sending = false;
    const run = result.body.run;
    const accepted = [200, 201].includes(result.status);
    const sameDraft = target.viewer === viewer && target.workspace === workspace && screen === 'editor' && currentDraft === attempt.draft;
    if (accepted && matchesRun(run, target.workspace) && Array.isArray(run.steps)) {
      creates.delete(target.workspace);
      drafts.delete(target.workspace);
      if (active(target)) openDetail(run.id, run);
      else if (sameDraft) {
        currentDraft = blankDraft();
        drafts.set(workspace, currentDraft);
        title.value = goal.value = '';
        renderDraft();
        show('team-run-start-status', '任务已启动，可返回任务列表查看。', 'ok');
      }
      return;
    }
    const uncertain = accepted || isUncertain(result.status);
    if (!uncertain) creates.delete(target.workspace);
    if (!sameDraft) return;
    editorControls();
    show('team-run-start-status', uncertain ? '暂时无法确认任务是否已创建。重试会核对原请求。'
      : errorMessage(result, '无法启动任务，请检查步骤后重试。'), 'error');
  }

  function renderResults(run) {
    const fingerprint = JSON.stringify([run.steps, doing, run.steps.map(step => saved.get(savedKey(step)))]);
    if (fingerprint === lastSteps) return;
    lastSteps = fingerprint;
    const container = node('team-run-results');
    const activeElement = document.activeElement;
    const position = activeElement?.closest?.('[data-position]')?.dataset.position;
    const action = activeElement?.dataset.stepAction;
    container.replaceChildren();
    for (const item of run.steps) {
      const card = make('li', '', 'result-step');
      card.dataset.position = String(item.position);
      const header = make('header', '', 'result-step-header');
      const heading = make('h3', `第 ${item.position + 1} 步 · ${item.agent_name}`);
      heading.tabIndex = -1;
      const pill = make('span', STATUS[item.status] || '状态未知', 'team-run-pill');
      pill.dataset.state = item.status;
      header.append(heading, pill);
      card.append(header, make('p', item.instruction, 'result-instruction'));
      if (item.depends_on?.length) card.append(make('p', '引用第 ' + item.depends_on.map(index => index + 1).join('、') + ' 步', 'note'));
      if (item.status === 'failed') card.append(make('p', STEP_ERROR[item.error_code] || '此步骤没有完成。', 'result-error'));
      if (item.status === 'failed' && item.attempts >= LIMITS.attempts) card.append(make('p', '已达到重试上限。', 'note'));
      if (item.output) card.append(make('pre', item.output, 'step-output'));
      else if (item.status === 'succeeded') card.append(make('p', '这一步没有返回文字。', 'note'));
      const actions = make('div', '', 'team-run-actions');
      if (item.status === 'failed' && item.attempts < LIMITS.attempts && run.status !== 'cancelled') {
        const retry = button(doing === 'retry' ? '正在重试…' : '重试这一步');
        retry.dataset.stepAction = 'retry';
        retry.disabled = Boolean(doing);
        retry.addEventListener('click', () => mutate('retry', item));
        actions.append(retry);
      }
      const artifact = saved.get(savedKey(item));
      if (artifact) {
        const link = make('a', '打开作品', 'team-run-link');
        link.href = spaceHref(workspace, artifact);
        link.dataset.stepAction = 'open';
        actions.append(link);
      } else if (item.status === 'succeeded' && item.output?.trim()) {
        const save = button('保存到作品库');
        save.dataset.stepAction = 'save';
        save.disabled = Boolean(doing);
        save.addEventListener('click', () => mutate('artifact', item));
        actions.append(save);
      }
      if (actions.childElementCount) card.append(actions);
      container.append(card);
      if (position === card.dataset.position) {
        const same = [...actions.children].find(control => control.dataset.stepAction === action && !control.disabled);
        (same || heading).focus({preventScroll: true});
      }
    }
  }

  function renderDetail(run) {
    current = run;
    const counts = run.progress || {};
    node('team-run-heading').textContent = run.title;
    node('team-run-goal-detail').textContent = run.goal || '';
    show('team-run-progress', `${STATUS[run.status] || '状态未知'} · ${counts.succeeded ?? 0}/${counts.total ?? run.steps.length} 步完成`);
    cancel.hidden = run.status !== 'running';
    remove.hidden = run.status === 'running';
    cancel.disabled = remove.disabled = Boolean(doing);
    if ((question === 'cancel' && cancel.hidden) || (question === 'remove' && remove.hidden)) {
      const refocus = confirm.contains(document.activeElement);
      hideQuestion();
      if (refocus) node('team-run-heading').focus({preventScroll: true});
    }
    shares.selectRun(run);
    renderResults(run);
  }

  async function loadDetail() {
    clearTimeout(timer);
    if (doing) return;
    const target = scope(), read = ++reads, runId = detailId;
    const result = await request('GET', pathFor() + '/' + runId);
    if (!active(target) || read !== reads) return;
    const run = result.body.run;
    if (result.status === 200 && matchesRun(run, workspace, runId) && Array.isArray(run.steps)) {
      newRun.disabled = false;
      syncShareWorkspace();
      if (node('team-run-status').dataset.kind === 'read-error') show('team-run-status', '');
      renderDetail(run);
    } else {
      if (cannotRead(result.status)) clearInaccessibleRunData();
      show('team-run-status', errorMessage(result, '暂时无法刷新任务。'), 'read-error');
      if (!current) node('team-run-progress').textContent = '';
    }
    if (current?.status === 'running' && result.status !== 403 && result.status !== 404) afterPoll(loadDetail);
  }

  function openDetail(id, initial, {address = true} = {}) {
    if (!workspace || !ID.test(id)) return;
    changeScreen('detail', id);
    if (address) updateLocation(id);
    node('team-run-heading').textContent = '任务详情';
    node('team-run-goal-detail').textContent = '';
    node('team-run-results').replaceChildren();
    cancel.hidden = remove.hidden = true;
    show('status', '');
    if (initial) renderDetail(initial);
    else show('team-run-progress', '正在读取步骤…');
    node('team-run-heading').focus();
    if (!initial) return loadDetail();
    if (initial.status === 'running') afterPoll(loadDetail);
  }

  async function mutate(action, step) {
    if (doing || !current || screen !== 'detail') return;
    if ((action === 'cancel' && current.status !== 'running') || (action === 'remove' && current.status === 'running')) return;
    if (step && !current.steps.some(item => item.position === step.position && item.status === step.status)) return;
    const target = scope(), runId = detailId;
    doing = action;
    ++reads;
    clearTimeout(timer);
    hideQuestion();
    renderDetail(current);
    show('team-run-status', '正在处理…');
    const suffix = step ? `/steps/${step.position}/${action}` : '/' + action;
    const result = await request('POST', pathFor(target.workspace) + '/' + runId + suffix, {});
    if (!active(target)) return;
    doing = '';
    if (result.status === 200 && action === 'remove') return showList({focus: true});
    const run = result.body.run, artifact = result.body.artifact?.id;
    if (action === 'artifact' && [200, 201].includes(result.status) && ID.test(artifact || '')) {
      saved.set(savedKey(step), artifact);
      show('team-run-status', '已保存到作品库。', 'ok');
      renderDetail(current);
      node('team-run-results').querySelector(`[data-position="${step.position}"] [data-step-action="open"]`)?.focus();
    } else if (result.status === 200 && matchesRun(run, workspace, runId) && Array.isArray(run.steps)) {
      show('team-run-status', '');
      renderDetail(run);
    } else {
      renderDetail(current);
      show('team-run-status', errorMessage(result, isUncertain(result.status)
        ? '暂时无法确认操作结果，正在刷新任务。' : '无法完成这次操作，请刷新后重试。'), 'error');
      return loadDetail();
    }
    if (current.status === 'running') afterPoll(loadDetail);
  }

  function ask(action) {
    question = action;
    const cancelling = action === 'cancel';
    node('team-run-confirm-label').textContent = cancelling ? '取消后会停止安排后续步骤，已完成的结果会保留。' : '删除这条任务记录？';
    node('team-run-confirm-action').textContent = cancelling ? '确认取消' : '确认删除';
    confirm.hidden = false;
    node('team-run-keep').focus();
  }

  function choose(target, address = false) {
    const allowed = spaces.find(item => item.id === target.workspace);
    workspace = allowed?.id || (target.workspace || target.invalid ? '' : spaces[0]?.id || '');
    picker.value = workspace;
    if (!workspace) {
      showList({address: false});
      show('status', target.workspace || target.invalid ? '无法打开这个工作区。请选择可访问的工作区。'
        : '还没有可用的工作区。', 'error');
      return;
    }
    if (target.run) return openDetail(target.run, null, {address});
    return showList({address: address && !target.shared});
  }

  function fillSpaces(items) {
    spaces = items.filter(item => ID.test(item?.id || ''));
    picker.replaceChildren();
    const first = make('option', '选择工作区');
    first.value = '';
    first.disabled = true;
    picker.append(first);
    for (const item of spaces) {
      const option = make('option', item.name);
      option.value = item.id;
      picker.append(option);
    }
    picker.value = workspace;
  }

  async function load() {
    const seq = ++auth;
    const sessionRead = request('GET', '/v1/auth/session');
    const personalRead = request('GET', '/v1/workspaces?scope=personal');
    const trustedPersonal = Promise.all([sessionRead, personalRead]).then(([session, local]) => {
      const user = session.body.user;
      if (session.status !== 200 || !user || local.status !== 200 || !Array.isArray(local.body.items)) return {status: 0, body: {}};
      return {...local, body: {...local.body, items: local.body.items.filter(item => item?.kind === 'personal' &&
        ID.test(item.id) && (item.owner_id == null || item.owner_id === user.id))}};
    });
    const directory = readWorkspaceChoices(request, '/v1/workspaces?limit=100', trustedPersonal);
    const session = await sessionRead;
    if (seq !== auth) return;
    if (session.status !== 200 || !session.body.user) {
      viewer = null;
      drafts.clear(); creates.clear(); saved.clear();
      personalSpaces.clear();
      changeScreen('');
      clearInaccessibleRunData();
      main.hidden = true;
      node('login-panel').hidden = false;
      show('status', session.status === 401 ? '' : '无法读取登录状态，请刷新重试。', 'error');
      return;
    }
    if (viewer && viewer.id !== session.body.user.id) {
      drafts.clear(); creates.clear(); saved.clear();
      workspace = '';
      spaces = [];
      personalSpaces.clear();
      changeScreen('');
    }
    viewer = session.body.user;
    node('whoami').textContent = viewer.username;
    main.hidden = false;
    node('login-panel').hidden = true;
    picker.disabled = true;
    let [{initial, supplemental}, personal] = await Promise.all([directory, trustedPersonal]);
    const target = teamRunTarget(view.location.hash);
    if (target.workspace && !initial.body.items?.some(item => item.id === target.workspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) initial = shared;
      supplemental = null;
    }
    if (seq !== auth) return;
    personalSpaces = new Set((personal.body.items || []).map(item => item.id));
    if (initial.status !== 200 || !Array.isArray(initial.body.items)) {
      show('status', '无法读取工作区，点击刷新重试。', 'error');
      return;
    }
    fillSpaces(initial.body.items);
    picker.disabled = !spaces.length;
    void supplemental?.then(result => {
      if (seq === auth && result.status === 200 && Array.isArray(result.body.items)) {
        fillSpaces(result.body.items);
        picker.disabled = !spaces.length;
      }
    });
    return choose(target);
  }

  editor.addEventListener('submit', startRun);
  title.addEventListener('input', () => { currentDraft.title = title.value; });
  goal.addEventListener('input', () => { currentDraft.goal = goal.value; });
  node('team-run-add-step').addEventListener('click', () => {
    if (currentDraft.steps.length >= LIMITS.maximum) return;
    const step = blankStep();
    currentDraft.steps.push(step);
    renderDraft(step.key);
  });
  newRun.addEventListener('click', showEditor);
  picker.addEventListener('change', () => choose({workspace: picker.value}, true));
  view.addEventListener('hashchange', () => choose(teamRunTarget(view.location.hash)));
  node('team-runs-refresh').addEventListener('click', () => {
    if (!spaces.length) return load();
    if (screen === 'detail') return loadDetail();
    if (screen === 'editor') return loadAgents();
    return loadList();
  });
  for (const back of document.querySelectorAll('[data-back-to-team-runs]')) back.addEventListener('click', () => showList({focus: true}));
  cancel.addEventListener('click', () => ask('cancel'));
  remove.addEventListener('click', () => ask('remove'));
  node('team-run-keep').addEventListener('click', () => hideQuestion(true));
  node('team-run-confirm-action').addEventListener('click', () => { if (question) void mutate(question); });
  confirm.addEventListener('keydown', event => { if (event.key === 'Escape') hideQuestion(true); });
  node('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status === 200) {
      changeScreen('');
      return load();
    }
    show('status', '无法退出登录，请重试。', 'error');
  });
  return load();
}

if (globalThis.document?.getElementById('team-run-list')) mountTeamRuns(globalThis.document);
