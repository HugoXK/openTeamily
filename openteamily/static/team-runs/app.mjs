import {readWorkspaceChoices} from '../shell/dsbot-api.mjs';
import {spaceHref} from '../shell/thumb.mjs';
import {createTeamRunShares} from './shares.mjs';

const ID = /^[a-f0-9]{32}$/;
const SHARED_ID = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const LIMITS = {minimum: 2, maximum: 8, title: 80, goal: 2000, instruction: 1000, attempts: 3};
const DRAFT_PREFIX = 'ot-team-run-draft:';
const CREATE_KEY = /^team-run-[a-f0-9]{32}$/;
const REUSABLE = new Set(['succeeded', 'failed', 'cancelled']);
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
  source_changed: '共享结果已更新。请打开最新版并发起后续任务。',
  source_unavailable: '无法读取引用的共享结果。',
};

export function teamRunTarget(hash = '') {
  if (!hash || hash === '#') return {};
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const workspace = params.get('workspace'), run = params.get('run'), shared = params.get('shared'), draft = params.get('draft');
  const selections = [run, shared, draft].filter(value => value !== null).length;
  if (!ID.test(workspace || '') || selections > 1 || params.size !== 1 + selections ||
      (run !== null && !ID.test(run)) || (shared !== null && !SHARED_ID.test(shared)) ||
      (draft !== null && draft !== '1')) return {invalid: true};
  return {workspace, ...(run ? {run} : {}), ...(shared ? {shared} : {}), ...(draft ? {draft: true} : {})};
}

function readSource(value) {
  if (!value || typeof value.id !== 'string' || !SHARED_ID.test(value.id) ||
      typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version) ||
      !Array.isArray(value.positions) || value.positions.length < 1 || value.positions.length > 3 ||
      value.positions.some(position => !Number.isInteger(position) || position < 0 || position > 7) ||
      new Set(value.positions).size !== value.positions.length) return null;
  return {id: value.id, version: value.version, positions: [...value.positions].sort((a, b) => a - b)};
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
  const source = draft.source && readSource(draft.source);
  if (draft.source && !source) return null;
  return {title, goal, steps, ...(source && {source})};
}

export function teamRunDraftFromHistory(run, nextKey) {
  if (!REUSABLE.has(run?.status) || typeof run.title !== 'string' || !run.title.trim() ||
      typeof run.goal !== 'string' || !run.goal.trim() || run.goal.length > LIMITS.goal || !Array.isArray(run.steps) ||
      run.steps.length < LIMITS.minimum || run.steps.length > LIMITS.maximum) return null;
  const suffix = '（副本）';
  const prefix = run.title.trim().slice(0, LIMITS.title - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  const steps = [];
  for (const [position, source] of run.steps.entries()) {
    if (source?.position !== position || !ID.test(source.agent_id || '') || typeof source.instruction !== 'string' ||
        !source.instruction.trim() || source.instruction.length > LIMITS.instruction || !Array.isArray(source.depends_on) ||
        source.depends_on.some(index => !Number.isInteger(index) || index < 0 || index >= position) ||
        new Set(source.depends_on).size !== source.depends_on.length) return null;
    steps.push({key:nextKey(), agent:source.agent_id, instruction:source.instruction,
      dependencies:new Set(source.depends_on.map(index => steps[index].key))});
  }
  const source = readSource(run.source);
  return {title:prefix + suffix, goal:run.goal, steps, sourceRun:run.id, ...(source && {source})};
}

export function removeDraftStep(steps, key) {
  if (steps.length <= LIMITS.minimum) return steps;
  const remaining = steps.filter(step => step.key !== key);
  for (const step of remaining) step.dependencies.delete(key);
  return remaining;
}

function hasDraftContent(draft) {
  return Boolean(draft && (draft.title || draft.goal || draft.source || draft.steps.length !== LIMITS.minimum ||
    draft.steps.some(step => step.agent || step.instruction || step.dependencies.size)));
}

function draftStorageKey(owner, workspace) {
  if (!ID.test(owner || '') || !ID.test(workspace || '')) return '';
  return DRAFT_PREFIX + owner + ':' + workspace;
}

function readDraft(view, storageKey, nextKey) {
  if (!storageKey) return null;
  try {
    const raw = view.sessionStorage.getItem(storageKey);
    if (!raw || raw.length > 65536) return null;
    const {title, goal, steps, sourceRun, source: rawSource, createKey} = JSON.parse(raw);
    const source = readSource(rawSource);
    if (typeof title !== 'string' || title.length > LIMITS.title || typeof goal !== 'string' ||
        goal.length > LIMITS.goal || !Array.isArray(steps) || steps.length < LIMITS.minimum ||
        steps.length > LIMITS.maximum || (sourceRun && !ID.test(sourceRun)) ||
        (rawSource !== undefined && !source) || (createKey && !CREATE_KEY.test(createKey))) return null;
    const draft = {title, goal, steps: [], ...(sourceRun && {sourceRun}), ...(source && {source})};
    for (const [position, step] of steps.entries()) {
      if (!step || typeof step.agent !== 'string' || (step.agent && !ID.test(step.agent)) ||
          typeof step.instruction !== 'string' || step.instruction.length > LIMITS.instruction ||
          !Array.isArray(step.dependsOn) || step.dependsOn.length > position ||
          step.dependsOn.some(index => !Number.isInteger(index) || index < 0 || index >= position) ||
          new Set(step.dependsOn).size !== step.dependsOn.length) return null;
      draft.steps.push({key: nextKey(), agent: step.agent, instruction: step.instruction,
        dependencies: new Set(step.dependsOn.map(index => draft.steps[index].key))});
    }
    if (!createKey) return {draft};
    const payload = teamRunPayload(draft, draft.steps.map(step => ({id: step.agent})));
    return payload ? {draft, attempt: {key: createKey, payload, draft}} : null;
  } catch {
    return null;
  }
}

function writeDraft(view, storageKey, draft, attempt) {
  if (!storageKey) return false;
  try {
    if (!hasDraftContent(draft) && !attempt) {
      view.sessionStorage.removeItem(storageKey);
    } else {
      const positions = new Map(draft.steps.map((step, index) => [step.key, index]));
      const steps = draft.steps.map(step => ({agent: step.agent, instruction: step.instruction,
        dependsOn: [...step.dependencies].map(key => positions.get(key))}));
      view.sessionStorage.setItem(storageKey, JSON.stringify({title: draft.title, goal: draft.goal, steps,
        sourceRun: draft.sourceRun, source: draft.source, createKey: attempt?.key}));
    }
    return true;
  } catch {
    return false;
  }
}

function errorMessage(result, fallback) {
  if (result.body?.error?.code === 'source_changed') return '共享结果已更新。请重新打开共享结果并选择步骤。';
  if (result.body?.error?.code === 'source_unavailable') return result.status === 503
    ? '暂时无法读取共享结果，请稍后重试。' : '共享结果已不可用。可以移除引用后继续。';
  if (result.body?.error?.code === 'source_invalid') return '请选择有输出的已完成步骤。';
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
  const reuse = node('team-run-reuse');
  const confirm = node('team-run-confirm');
  const title = node('team-run-title');
  const goal = node('team-run-goal');
  const drafts = new Map();
  const creates = new Map();
  const previewNodes = new Map();
  let viewer, spaces = [], workspace = '', screen = '', detailId = '';
  let personalSpaces = new Set();
  let epoch = 0, reads = 0, auth = 0, serial = 0;
  let current, currentDraft, tasks = [], agents = [];
  let timer, doing = '', question = '', lastList = '', lastSteps = '';

  function show(id, text, kind = '') {
    const element = node(id);
    if (element.textContent !== text) element.textContent = text;
    if (element.dataset.kind !== kind) element.dataset.kind = kind;
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

  const shares = createTeamRunShares({
    document, request, adopt: adoptShare, selectAddress: id => updateLocation(id ? {shared: id} : {}),
  });
  const pathFor = (id = workspace) => `/v1/workspaces/${id}/team-runs`;
  const scope = () => ({viewer, workspace, epoch});
  const active = target => target.viewer === viewer && target.workspace === workspace && target.epoch === epoch;

  function updateLocation(extra = {}) {
    if (!workspace || !view?.history) return;
    const hash = '#' + new URLSearchParams({workspace, ...extra});
    if (view.location.hash !== hash) view.history.pushState(null, '', hash);
  }

  function hydrateDraft() {
    if (drafts.has(workspace)) return;
    const savedDraft = readDraft(view, draftStorageKey(viewer?.id, workspace), () => ++serial);
    if (!savedDraft) return;
    drafts.set(workspace, savedDraft.draft);
    if (savedDraft.attempt) creates.set(workspace, savedDraft.attempt);
  }

  function persistDraft(owner = viewer, space = workspace, announce = screen === 'editor') {
    const draft = drafts.get(space), attempt = creates.get(space);
    const stored = writeDraft(view, draftStorageKey(owner?.id, space), draft, attempt);
    if (!announce) return;
    const status = node('team-run-draft-status');
    status.hidden = !hasDraftContent(draft);
    if (!status.hidden) {
      show('team-run-draft-status', stored ? '草稿已保留在当前标签页。'
        : '浏览器无法保留草稿，刷新前请先复制内容。', stored ? '' : 'error');
    }
  }

  function hideQuestion(refocus = false) {
    const trigger = question === 'cancel' ? cancel : question === 'reuse' ? reuse : remove;
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
    cancel.hidden = remove.hidden = reuse.hidden = true;
    hideQuestion();
    node('team-run-list').replaceChildren();
    node('team-runs-empty').hidden = true;
    previewNodes.clear();
    node('team-run-results').replaceChildren();
    node('team-run-heading').textContent = '任务详情';
    node('team-run-goal-detail').textContent = '';
    node('team-run-open-source').hidden = true;
    show('team-run-progress', '');
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
    main.dataset.screen = next;
    const detailScope = node('team-run-detail-scope');
    if (detailScope) detailScope.textContent = next === 'detail' ? spaces.find(item => item.id === workspace)?.name || '' : '';
    lastList = lastSteps = '';
    previewNodes.clear();
    node('team-run-results').replaceChildren();
    listView.hidden = next !== 'list';
    editor.hidden = next !== 'editor';
    detail.hidden = next !== 'detail';
    newRun.hidden = next === 'editor';
    newRun.textContent = hasDraftContent(drafts.get(workspace)) ? '继续草稿' : '新建任务';
    newRun.disabled = !workspace;
    show('team-run-status', '');
    show('team-run-start-status', '');
    hideQuestion();
    syncShareWorkspace();
    shares.selectRun(null);
  }

  function afterPoll(work, delay = document.hidden ? 8000 : screen === 'detail' ? 1000 : 3500) {
    clearTimeout(timer);
    timer = setTimeout(work, delay);
  }

  function refreshVisibleRun() {
    if (!document.hidden && screen === 'detail' && !doing && (!current || current.status === 'running')) afterPoll(loadDetail, 0);
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

  function showList({address = true, focus = false, shared} = {}) {
    changeScreen('list');
    shares.openTarget(shared);
    tasks = [];
    node('team-run-list').replaceChildren();
    node('team-runs-empty').hidden = true;
    if (address) updateLocation(shared ? {shared} : {});
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

  function adoptShare({workspaceId, source, name}, {replace = false} = {}) {
    if (screen !== 'list' || workspaceId !== workspace || !readSource(source)) return 'unavailable';
    hydrateDraft();
    if (creates.has(workspace)) return 'pending';
    if (!replace && hasDraftContent(drafts.get(workspace))) return 'replace';
    const draft = blankDraft();
    draft.title = ('后续任务 · ' + name).slice(0, LIMITS.title).toWellFormed();
    draft.goal = '根据共享结果制定下一步行动计划。';
    draft.steps[0].instruction = '梳理共享结果，找出仍需解决的问题和优先事项。';
    draft.steps[1].instruction = '综合分析结果，给出具体的下一步行动计划。';
    draft.steps[1].dependencies.add(draft.steps[0].key);
    draft.source = source;
    drafts.set(workspace, draft);
    void showEditor();
    return 'opened';
  }

  function renderDraftSource() {
    const source = currentDraft.source;
    const container = node('team-run-source');
    container.hidden = !source;
    if (source) show('team-run-source-status', `已引用团队共享的第 ${source.positions.map(position => position + 1).join('、')} 步结果摘要。开始运行后，由你选择的智能体处理。`);
    node('team-run-form-heading').textContent = currentDraft.sourceRun ? '复用为新任务' : source ? '发起后续任务' : '新建任务';
  }

  const missingDraftAgent = () => currentDraft.steps.some(step => step.agent && !agents.some(agent => agent.id === step.agent));

  function editorControls() {
    const attempt = creates.get(workspace);
    node('team-run-fields').disabled = Boolean(attempt);
    start.disabled = Boolean(attempt?.sending || (!attempt && (!agents.length || missingDraftAgent())));
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
      select.addEventListener('change', () => {
        item.agent = select.value;
        persistDraft();
        if (agents.length) showAgentAvailability();
        editorControls();
      });
      agentLabel.append(select);
      const instructionLabel = make('label', '任务指令');
      const instruction = make('textarea');
      instruction.required = true;
      instruction.maxLength = LIMITS.instruction;
      instruction.rows = 2;
      instruction.value = item.instruction;
      instruction.dataset.stepInstruction = '';
      instruction.addEventListener('input', () => {
        item.instruction = instruction.value;
        persistDraft();
      });
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
            persistDraft();
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
          persistDraft();
          renderDraft(currentDraft.steps[Math.min(index, currentDraft.steps.length - 1)]?.key);
        });
        group.append(drop);
      }
      container.append(group);
      if (focusKey === item.key) select.focus();
    }
    if (agents.length) showAgentAvailability();
    editorControls();
  }

  function showAgentAvailability(loaded = true) {
    if (!loaded) {
      show('team-run-agent-status', '无法读取智能体。点击刷新重试。', 'error');
    } else if (!agents.length) {
      show('team-run-agent-status', '当前工作区没有可用智能体。请先到智能体页面创建或恢复，再返回刷新。');
    } else {
      show('team-run-agent-status', missingDraftAgent() ? '有步骤的原智能体不可用，请选择可用智能体。' : '');
    }
  }

  async function loadAgents() {
    const target = scope(), read = ++reads;
    show('team-run-agent-status', '正在读取本工作区的智能体…');
    const result = await request('GET', `/v1/workspaces/${workspace}/agents?limit=100`);
    if (!active(target) || read !== reads) return;
    const ok = result.status === 200 && Array.isArray(result.body.items);
    agents = ok ? result.body.items.filter(agent => ID.test(agent?.id || '') && !agent.archived && !agent.native_deleted &&
      (!agent.workspace_id || agent.workspace_id === workspace)) : [];
    if (!agents.length) showAgentAvailability(ok);
    renderDraft();
  }

  function showEditor({address = true} = {}) {
    if (!workspace) return;
    hydrateDraft();
    changeScreen('editor');
    if (address) updateLocation({draft: '1'});
    if (!drafts.has(workspace)) drafts.set(workspace, blankDraft());
    currentDraft = drafts.get(workspace);
    title.value = currentDraft.title;
    goal.value = currentDraft.goal;
    renderDraftSource();
    agents = [];
    renderDraft();
    persistDraft();
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
      persistDraft();
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
      persistDraft(target.viewer, target.workspace, false);
      if (active(target)) openDetail(run.id, run);
      else if (sameDraft) {
        currentDraft = blankDraft();
        drafts.set(workspace, currentDraft);
        title.value = goal.value = '';
        renderDraftSource();
        persistDraft();
        renderDraft();
        show('team-run-start-status', '任务已启动，可返回任务列表查看。', 'ok');
      }
      return;
    }
    const uncertain = accepted || (isUncertain(result.status) && result.body?.error?.code !== 'source_unavailable');
    if (!uncertain) {
      creates.delete(target.workspace);
      persistDraft(target.viewer, target.workspace, sameDraft);
    }
    if (!sameDraft) return;
    editorControls();
    show('team-run-start-status', uncertain ? '暂时无法确认任务是否已创建。重试会核对原请求。'
      : errorMessage(result, '无法启动任务，请检查步骤后重试。'), 'error');
  }

  function updatePreviews(steps) {
    for (const item of steps) {
      const preview = previewNodes.get(item.position);
      if (!preview) continue;
      const text = item.status === 'running' && typeof item.preview === 'string' ? item.preview : '';
      if (preview.text.textContent !== text) preview.text.textContent = text;
      preview.panel.hidden = !text;
    }
  }

  function renderResults(run) {
    const structure = run.steps.map(({preview, ...step}) => step);
    const fingerprint = JSON.stringify([structure, doing]);
    if (fingerprint === lastSteps) return updatePreviews(run.steps);
    lastSteps = fingerprint;
    const container = node('team-run-results');
    const activeElement = document.activeElement;
    const position = activeElement?.closest?.('[data-position]')?.dataset.position;
    const action = activeElement?.dataset.stepAction;
    previewNodes.clear();
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
      if (item.status === 'running') {
        const panel = make('div', '', 'step-preview');
        const text = make('pre', '', 'step-output');
        panel.hidden = true;
        panel.append(make('p', '生成预览', 'step-preview-label'), text);
        card.append(panel);
        previewNodes.set(item.position, {panel, text});
      } else if (item.status === 'succeeded' && item.output) card.append(make('pre', item.output, 'step-output'));
      else if (item.status === 'succeeded') card.append(make('p', '这一步没有返回文字。', 'note'));
      const actions = make('div', '', 'team-run-actions');
      if (item.status === 'failed' && item.attempts < LIMITS.attempts && run.status !== 'cancelled') {
        const retry = button(doing === 'retry' ? '正在重试…' : '重试这一步');
        retry.dataset.stepAction = 'retry';
        retry.disabled = Boolean(doing);
        retry.addEventListener('click', () => mutate('retry', item));
        actions.append(retry);
      }
      const artifact = ID.test(item.saved_artifact_id || '') && item.saved_artifact_id;
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
    updatePreviews(run.steps);
  }

  function renderDetail(run) {
    current = run;
    const counts = run.progress || {};
    show('team-run-heading', run.title);
    show('team-run-goal-detail', run.goal || '');
    show('team-run-progress', `${STATUS[run.status] || '状态未知'} · ${counts.succeeded ?? 0}/${counts.total ?? run.steps.length} 步完成`);
    cancel.hidden = run.status !== 'running';
    remove.hidden = run.status === 'running';
    reuse.hidden = !REUSABLE.has(run.status);
    node('team-run-open-source').hidden = !readSource(run.source);
    cancel.disabled = remove.disabled = reuse.disabled = Boolean(doing);
    if ((question === 'cancel' && cancel.hidden) || (question === 'remove' && remove.hidden) || (question === 'reuse' && reuse.hidden)) {
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
    if (isUncertain(result.status)) afterPoll(loadDetail, document.hidden ? 8000 : 2500);
    else if (current?.status === 'running') afterPoll(loadDetail);
  }

  function openDetail(id, initial, {address = true} = {}) {
    if (!workspace || !ID.test(id)) return;
    changeScreen('detail', id);
    if (address) updateLocation({run: id});
    node('team-run-heading').textContent = '任务详情';
    node('team-run-goal-detail').textContent = '';
    node('team-run-open-source').hidden = true;
    cancel.hidden = remove.hidden = reuse.hidden = true;
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
    if (step && !current.steps.some(item => item.position === step.position && item.status === step.status && item.attempts === step.attempts)) return;
    const target = scope(), runId = detailId;
    doing = action;
    ++reads;
    clearTimeout(timer);
    hideQuestion();
    renderDetail(current);
    show('team-run-status', '正在处理…');
    const suffix = step ? `/steps/${step.position}/${action}` : '/' + action;
    const result = await request('POST', pathFor(target.workspace) + '/' + runId + suffix, action === 'retry' ? {attempt:step.attempts} : {});
    if (!active(target)) return;
    doing = '';
    if (result.status === 200 && action === 'remove') return showList({focus: true});
    const run = result.body.run, artifact = result.body.artifact?.id;
    if (action === 'artifact' && [200, 201].includes(result.status) && ID.test(artifact || '')) {
      const steps = current.steps.map(item => item.position === step.position ? {...item, saved_artifact_id: artifact} : item);
      show('team-run-status', '已保存到作品库。', 'ok');
      renderDetail({...current, steps});
      node('team-run-results').querySelector(`[data-position="${step.position}"] [data-step-action="open"]`)?.focus();
    } else if (result.status === 200 && matchesRun(run, workspace, runId) && Array.isArray(run.steps)) {
      show('team-run-status', '');
      renderDetail(run);
    } else {
      if (cannotRead(result.status) && result.body?.error?.code !== 'source_unavailable') {
        clearInaccessibleRunData();
        show('team-run-status', errorMessage(result, '暂时无法读取任务。'), 'read-error');
        return;
      }
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
    node('team-run-confirm-label').textContent = cancelling ? '取消后会请求停止正在执行的步骤，已完成的结果会保留。'
      : action === 'reuse' ? '复用会替换本工作区未保存的任务草稿。' : '删除这条任务记录？';
    node('team-run-confirm-action').textContent = cancelling ? '确认取消' : action === 'reuse' ? '替换草稿' : '确认删除';
    confirm.hidden = false;
    node('team-run-keep').focus();
  }

  function reuseRun({replace = false} = {}) {
    if (screen !== 'detail' || doing || !matchesRun(current, workspace, detailId) || !REUSABLE.has(current.status)) return;
    if (creates.has(workspace)) {
      show('team-run-status', '请先打开草稿并确认上次启动结果，再复用任务。', 'error');
      return;
    }
    if (!replace && hasDraftContent(drafts.get(workspace))) {
      ask('reuse');
      return;
    }
    const draft = teamRunDraftFromHistory(current, () => ++serial);
    if (!draft) {
      show('team-run-status', '这条记录没有完整的步骤定义，无法复用。', 'error');
      return;
    }
    drafts.set(workspace, draft);
    return showEditor();
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
    hydrateDraft();
    if (target.draft) return showEditor({address});
    if (target.run) return openDetail(target.run, null, {address});
    return showList({address: address && !target.shared, shared: target.shared});
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
      drafts.clear(); creates.clear();
      personalSpaces.clear();
      changeScreen('');
      clearInaccessibleRunData();
      main.hidden = true;
      node('login-panel').hidden = false;
      show('status', session.status === 401 ? '' : '无法读取登录状态，请刷新重试。', 'error');
      return;
    }
    if (viewer && viewer.id !== session.body.user.id) {
      drafts.clear(); creates.clear();
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
  title.addEventListener('input', () => {
    currentDraft.title = title.value;
    persistDraft();
  });
  goal.addEventListener('input', () => {
    currentDraft.goal = goal.value;
    persistDraft();
  });
  node('team-run-review-source').addEventListener('click', () => {
    if (currentDraft?.source) showList({shared: currentDraft.source.id});
  });
  node('team-run-remove-source').addEventListener('click', () => {
    if (screen !== 'editor' || creates.has(workspace) || !currentDraft?.source) return;
    delete currentDraft.source;
    renderDraftSource();
    persistDraft();
    show('team-run-start-status', '');
    node('team-run-form-heading').focus();
  });
  node('team-run-add-step').addEventListener('click', () => {
    if (currentDraft.steps.length >= LIMITS.maximum) return;
    const step = blankStep();
    currentDraft.steps.push(step);
    persistDraft();
    renderDraft(step.key);
  });
  newRun.addEventListener('click', showEditor);
  picker.addEventListener('change', () => choose({workspace: picker.value}, true));
  view.addEventListener('hashchange', () => choose(teamRunTarget(view.location.hash)));
  function refresh() {
    if (!spaces.length) return load();
    if (screen === 'detail') return loadDetail();
    if (screen === 'editor') return loadAgents();
    return loadList();
  }
  node('team-runs-refresh').addEventListener('click', refresh);
  node('team-run-detail-refresh')?.addEventListener('click', refresh);
  for (const back of document.querySelectorAll('[data-back-to-team-runs]')) back.addEventListener('click', () => showList({focus: true}));
  cancel.addEventListener('click', () => ask('cancel'));
  remove.addEventListener('click', () => ask('remove'));
  reuse.addEventListener('click', () => reuseRun());
  node('team-run-open-source').addEventListener('click', () => {
    const source = readSource(current?.source);
    if (source) showList({shared: source.id});
  });
  node('team-run-keep').addEventListener('click', () => hideQuestion(true));
  node('team-run-confirm-action').addEventListener('click', () => {
    if (question === 'reuse') return reuseRun({replace:true});
    if (question) void mutate(question);
  });
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
  view?.addEventListener('online', refreshVisibleRun);
  document.addEventListener?.('visibilitychange', refreshVisibleRun);
  return load();
}

if (globalThis.document?.getElementById('team-run-list')) mountTeamRuns(globalThis.document);
