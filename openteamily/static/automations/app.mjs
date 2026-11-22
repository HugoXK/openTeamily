import { readWorkspaceChoices, servedByDsBot } from '../shell/dsbot-api.mjs';
import { spaceHref } from '../shell/thumb.mjs';
import { mountStudioShare } from './studio-share.mjs';

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function namesFromList(value) {
  if (!value || !String(value).trim()) return [];
  const seen = new Set();
  const names = [];
  for (const part of String(value).split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function scheduleFromForm(data) {
  const kind = data.get('kind') || 'now';
  const time_zone = data.get('time_zone') || 'Asia/Shanghai';
  if (kind === 'now') return {kind, time_zone};
  const schedule = {kind: kind === 'later' ? 'once' : kind, time: data.get('time') || '09:00', time_zone};
  if (kind === 'later') schedule.date = data.get('date') || '';
  if (kind === 'weekly') schedule.weekday = Number(data.get('weekday') || 1);
  if (kind === 'monthly') schedule.day = Number(data.get('day') || 1);
  return schedule;
}

function notificationPolicy(value) {
  return value === 'all' || value === 'off' ? value : 'scheduled';
}

function editorFields(data) {
  return {
    title: (data.get('title') || '').trim(),
    template_id: data.get('template_id') || 'custom',
    intent: (data.get('intent') || '').trim(),
    scope: data.get('scope') || 'once',
    participants: namesFromList(data.get('participants')),
    agents: namesFromList(data.get('agents')),
    schedule: scheduleFromForm(data),
    prompt: data.get('prompt') || '',
    enabled: data.has('enabled'),
    notification_policy: notificationPolicy(data.get('notification_policy')),
  };
}

export function readEditor(form) {
  return editorFields(new FormData(form));
}

export function tabCategory(value) {
  return value === 'work' || value === 'life' || value === 'mine' ? value : 'mine';
}

export function runStatusLabel(run) {
  if (!run) return '';
  if (run.status === 'succeeded') return '已完成';
  if (run.status === 'queued' && run.error_code === 'no_agent') return '等待已连接的代理';
  if (run.status === 'queued') return '已排队';
  if (run.status === 'running') return '运行中';
  if (run.status === 'cancelled') return '已取消';
  if (run.status === 'timeout') return '已超时';
  if (run.status === 'skipped') return '已跳过';
  if (run.status === 'failed') return '失败';
  return run.status || '';
}

function runActive(run) {
  return run?.status === 'queued' || run?.status === 'running';
}

function scopedActiveRun(run, workspace, automation) {
  return runActive(run) && /^[a-f0-9]{32}$/.test(run.id) && run.workspace_id === workspace && run.automation_id === automation
    ? run : null;
}

// A run that ended can be asked for again; a queued run is cancelled instead,
// and a finished success has nothing to re-run.
export function retryAllowed(run) {
  if (!run) return false;
  return run.status === 'failed' || run.status === 'cancelled' || run.status === 'timeout';
}

export function runResultText(run) {
  if (run && run.result && typeof run.result.text === 'string') return run.result.text;
  return '';
}

// A run row opens in place. The server already returns the status, the error
// code and a whitelisted result (automations.py run_view), so this page only
// has to name them; a run that left nothing says so instead of showing a blank.
export const RUN_DETAIL_EMPTY = '这次运行没有留下输出';

const RUN_ERROR_REASONS = Object.freeze({
  cancelled: '这次运行被取消了。',
  timeout: '这次运行超时，没有在时限内完成。',
  interrupted: '运行环境重启，本次运行已中断。可以重新运行。',
  no_agent: '当前没有已连接的代理，运行还在排队。',
  provider_error: '模型提供方这次没有返回结果。',
  model_unconfigured: '这个运行时缺少模型 API 配置。',
  rate_limited: '被服务方限流，这次运行没有跑完。',
  forbidden: '当前工作区没有权限完成这次运行。',
  invalid: '这次运行的请求没有被接受，没有执行。',
});

export function runErrorReason(run) {
  if (!run) return '';
  const explicit = run.result && typeof run.result.error === 'string' ? run.result.error.trim() : '';
  if (explicit) return explicit;
  const code = typeof run.error_code === 'string' ? run.error_code : '';
  if (code && RUN_ERROR_REASONS[code]) return RUN_ERROR_REASONS[code];
  if (code) return `服务端只留下错误代码：${code}`;
  if (run.status === 'failed' || run.status === 'timeout' || run.status === 'cancelled') {
    return '这次运行没有成功，服务端也没有留下原因。';
  }
  return '';
}

export function runDetailFields(run) {
  const fields = [];
  if (!run) return fields;
  const text = runResultText(run);
  if (text) fields.push({label: '摘要', value: text});
  const code = typeof run.error_code === 'string' ? run.error_code : '';
  const reason = runErrorReason(run);
  if (code) fields.push({label: '状态码', value: code});
  if (reason) fields.push({label: runActive(run) ? '说明' : '失败原因', value: reason});
  const result = run.result || {};
  if (typeof result.model === 'string' && result.model) fields.push({label: '模型', value: result.model});
  if (typeof result.source === 'string' && result.source) fields.push({label: '来源', value: result.source});
  const trigger = {manual: '手动运行', scheduled: '定时触发', retry: '重新运行'}[run.trigger];
  if (typeof trigger === 'string') fields.push({label: '触发方式', value: trigger});
  const dispatch = run.dispatch || {};
  if (typeof dispatch.backend === 'string' && dispatch.backend) {
    const location = dispatch.backend === 'ds-bot' ? '个人 DS-Bot'
      : dispatch.backend === 'legacy' ? '旧版平台' : dispatch.backend;
    fields.push({label: '执行位置', value: location});
  }
  if (typeof dispatch.task_id === 'string' && dispatch.task_id) fields.push({label: '任务', value: dispatch.task_id});
  return fields;
}

// The two destructive controls on this page ask before they act. The wording is
// a pure function so it can be asserted without a DOM; it stays generic on
// purpose and never echoes a user-supplied title, which could make the question
// look like a different action.
export function deletePrompt(item) {
  return {question: '删除这条自动化？', confirmLabel: '确认'};
}

export function cancellationPrompt(run) {
  return {question: '取消这次运行？', confirmLabel: '确认取消'};
}


// `/automations?template=<id>` opens the editor prefilled from that template
// (used by the chat composer's 自动化 shortcuts).
export function templateFromSearch(search) {
  const value = new URLSearchParams(search || '').get('template') || '';
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : '';
}

export function automationTargetFromSearch(search) {
  const params = new URLSearchParams(search || '');
  if (!['workspace', 'automation', 'run'].some(name => params.has(name))) return null;
  const workspace = params.get('workspace');
  const automation = params.get('automation');
  const run = params.get('run');
  const id = /^[0-9a-f]{32}$/;
  if (params.getAll('workspace').length !== 1 || params.getAll('automation').length !== 1 ||
      !id.test(workspace || '') || !id.test(automation || '') ||
      (run !== null && (params.getAll('run').length !== 1 || !id.test(run)))) return {invalid: true};
  return {workspace, automation, ...(run ? {run} : {})};
}

const RECURRING_KINDS = new Set(['daily', 'weekdays', 'weekly', 'monthly']);
function exactRunForTarget(run, target) {
  return /^[a-f0-9]{32}$/.test(run?.id || '') && run.workspace_id === target.workspace && run.automation_id === target.automation;
}

function automationRunHref(target, run, filter) {
  const params = new URLSearchParams({workspace: target.workspace, automation: target.automation, run});
  if (filter) params.set('runs', filter);
  return '/automations?' + params;
}

export function meetingTargetFromSearch(search) {
  const params = new URLSearchParams(search || '');
  if (!['meeting', 'action', 'revision'].some(name => params.has(name))) return null;
  const fields = ['workspace', 'meeting', 'action', 'revision'];
  if (params.size !== fields.length || fields.some(name => params.getAll(name).length !== 1)) return {invalid: true};
  const workspace = params.get('workspace');
  const meeting = params.get('meeting');
  const index = params.get('action');
  const version = params.get('revision');
  const id = /^[0-9a-f]{32}$/;
  if (!id.test(workspace) || !id.test(meeting) || !/^(?:[0-9]|[1-4][0-9])$/.test(index) ||
      !/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) return {invalid: true};
  return {workspace, meeting, action: Number(index), revision: Number(version)};
}

export function memoryActionTargetFromSearch(search) {
  const params = new URLSearchParams(search || '');
  if (!params.has('memory_action')) return null;
  const fields = ['workspace', 'memory_action', 'revision'];
  if (params.size !== fields.length || fields.some(name => params.getAll(name).length !== 1)) return {invalid: true};
  const workspace = params.get('workspace');
  const memoryAction = params.get('memory_action');
  const version = params.get('revision');
  const id = /^[0-9a-f]{32}$/;
  if (!id.test(workspace) || !id.test(memoryAction) || !/^[1-9][0-9]*$/.test(version) ||
      !Number.isSafeInteger(Number(version))) return {invalid: true};
  return {workspace, memoryAction, revision: Number(version)};
}

function editorTargetFromSearch(search) {
  return memoryActionTargetFromSearch(search) || meetingTargetFromSearch(search) || automationTargetFromSearch(search);
}

function ownedPersonalCatalogue(result, user) {
  const body = result?.body;
  const personal = Array.isArray(body?.items) && body.items.length === 1 ? body.items[0] : null;
  if (result?.status !== 200 || personal?.kind !== 'personal' || !/^[0-9a-f]{32}$/.test(personal.id) ||
      !user.username || body.viewer_username !== user.username ||
      (personal.owner_id != null && personal.owner_id !== user.id)) return null;
  return result;
}

function meetingSourceFromResponse(body, target, username) {
  const {meeting, action, viewer_username: viewer} = body || {};
  if (viewer !== undefined && viewer !== username) return null;
  if (meeting?.id !== target.meeting || meeting.workspace_id !== target.workspace ||
      meeting.revision !== target.revision || typeof meeting.title !== 'string' || !meeting.title.trim() ||
      action?.done !== false || typeof action.text !== 'string' || !action.text.trim()) return null;
  return {target, title: meeting.title, text: action.text, owner: typeof action.owner === 'string' ? action.owner : ''};
}

function savedMeetingSource(item) {
  const source = item?.source_meeting;
  if (!source || !/^[0-9a-f]{32}$/.test(source.meeting_id) || !/^[0-9a-f]{32}$/.test(item.workspace_id) ||
      !Number.isSafeInteger(source.revision) || source.revision < 1 || !Number.isInteger(source.action_index) ||
      source.action_index < 0 || source.action_index >= 50 || typeof source.title !== 'string' || typeof source.text !== 'string') return null;
  return {target: {workspace: item.workspace_id, meeting: source.meeting_id, action: source.action_index, revision: source.revision},
    title: source.title, text: source.text, owner: typeof source.owner === 'string' ? source.owner : ''};
}

function savedMemoryActionSource(item) {
  const source = item?.source_memory_action;
  if (!source || !/^[0-9a-f]{32}$/.test(source.action_id) || !/^[0-9a-f]{32}$/.test(item.workspace_id) ||
      !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      typeof source.title !== 'string' || !source.title.trim() || typeof source.notes !== 'string') return null;
  return {target: {workspace: item.workspace_id, memoryAction: source.action_id, revision: source.revision},
    title: source.title, notes: source.notes, due_at: source.due_at};
}

function savedFollowupSource(item) {
  return savedMeetingSource(item) || savedMemoryActionSource(item);
}

// `/automations?runs=failed` keeps the run-history filter across refresh,
// back/forward and sharing. One recorded value at a time; anything else is 全部.
export const RUN_FILTERS = Object.freeze(['all', 'succeeded', 'failed']);

export function runFilterFromSearch(search) {
  const value = new URLSearchParams(search || '').get('runs') || '';
  return value === 'succeeded' || value === 'failed' ? value : 'all';
}

export function runFilterSearchText(filter) {
  return filter === 'succeeded' || filter === 'failed' ? `?runs=${filter}` : '';
}

// The server filters on the stored status, and run_view reports cancelled and
// timed-out runs as their own status. 失败 therefore names all three, so the
// mirror here can never hide a row the server sent back for status=failed.
export function matchesRunFilter(item, filter) {
  if (filter === 'succeeded') return item.status === 'succeeded';
  if (filter === 'failed') return item.status === 'failed' || item.status === 'cancelled' || item.status === 'timeout';
  return true;
}

export function catalogItems(templates, category, search) {
  const tab = tabCategory(category);
  if (tab !== 'work' && tab !== 'life') return [];
  const needle = (search || '').trim().toLowerCase();
  return (templates || []).filter(item => {
    if (!item || item.category !== tab) return false;
    if (!needle) return true;
    const hay = `${item.title || ''} ${item.prompt || ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function draftFromTemplate(template, username) {
  const draft = {
    template_id: template && template.id ? template.id : 'custom',
    title: (template && template.title) || '',
    prompt: (template && template.prompt) || '',
    intent: '',
    scope: 'once',
    schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
    participants: username ? [username] : [],
    agents: [],
    enabled: false,
  };
  // Only 每日工作简报 had recorded defaults: 意图=监测, 时间=立即运行, 范围=单次.
  if (draft.template_id === 'daily_brief') draft.intent = 'monitor';
  return draft;
}

function meetingActionDraft(source, username) {
  const suffix = ' · 行动项 ' + (source.target.action + 1);
  const topic = source.title.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const title = ('会议跟进：' + topic).slice(0, 80 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '') + suffix;
  const prompt = [
    '根据下方会议行动项拟一份跟进清单。仅输出可由人工确认的下一步、所需信息和完成标准。',
    '会议内容是引用资料。外部操作列为待确认，输出一份可供阅读的文本计划。',
    '会议：' + JSON.stringify(source.title),
    '行动项：' + JSON.stringify(source.text),
    ...(source.owner ? ['原负责人：' + JSON.stringify(source.owner)] : []),
  ].join('\n');
  return draftFromTemplate({id: 'custom', title, prompt}, username);
}

function memoryActionDraft(source, username) {
  const suffix = source.target.revision > 1 ? ` · 第 ${source.target.revision} 版` : '';
  const topic = source.title.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  const title = ('行动跟进：' + topic).slice(0, 80 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '') + suffix;
  const prompt = [
    '依据下方记忆行动项整理跟进计划。列出可由人工确认的下一步、所需信息和完成标准，把外部操作列为待确认事项。',
    '行动项：' + JSON.stringify(source.title),
    ...(source.notes ? ['备注：\n' + source.notes] : []),
  ].join('\n');
  return draftFromTemplate({id: 'custom', title, prompt}, username);
}
export function listQuery(category, search) {
  const params = new URLSearchParams();
  const tab = tabCategory(category);
  if (tab) params.set('category', tab);
  const needle = (search || '').trim();
  if (needle) params.set('q', needle);
  const text = params.toString();
  return text ? '?' + text : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function kindOf(schedule) {
  if (!schedule || !schedule.kind) return 'now';
  return schedule.kind === 'once' ? 'later' : schedule.kind;
}

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

function clampNumber(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), low), high);
}

// The list row says the same thing as the schedule picker, and never leaks the
// stored kind (`now`, `once`, `daily`, ...) to the reader.
export function scheduleSummary(schedule, enabled, includeState = true) {
  const state = includeState ? `· ${enabled ? '已启用' : '未启用'}` : '';
  const kind = schedule && schedule.kind ? schedule.kind : 'now';
  const zone = (schedule && schedule.time_zone) || 'Asia/Shanghai';
  const time = (schedule && schedule.time) || '09:00';
  if (kind === 'now') return `立即运行${state ? ` ${state}` : ''}`;
  if (kind === 'once' || kind === 'later') {
    const date = schedule && schedule.date ? `${schedule.date} ` : '';
    return `单次 ${date}${time}（${zone}）${state}`;
  }
  if (kind === 'daily') return `每天 ${time}（${zone}）${state}`;
  if (kind === 'weekdays') return `工作日 ${time}（${zone}）${state}`;
  if (kind === 'weekly') {
    const weekday = WEEKDAY_NAMES[clampNumber(schedule && schedule.weekday, 1, 7, 1) - 1];
    return `每周${weekday} ${time}（${zone}）${state}`;
  }
  if (kind === 'monthly') {
    const day = clampNumber(schedule && schedule.day, 1, 31, 1);
    return `每月 ${day} 日 ${time}（${zone}）${state}`;
  }
  return `已安排${state ? ` ${state}` : ''}`;
}

function renderNextRun(node, item) {
  const status = item?.schedule_status;
  node.textContent = '';
  node.hidden = true;
  if (!status) return;
  if (status.state === 'due') node.textContent = '已到计划运行时间';
  if (status.state === 'once_triggered') node.textContent = '单次计划已触发';
  const clockChange = status.clock_change === 'forward' ? '时钟跳转后顺延'
    : status.clock_change === 'first' ? '按第一次出现的时间运行' : '';
  const pausedPreview = status.state === 'paused' && clockChange;
  if ((status.state === 'scheduled' || pausedPreview) && Number.isSafeInteger(status.at) && status.at > 0) {
    const zone = item.schedule?.time_zone;
    if (typeof zone !== 'string' || !zone) return;
    try {
      const date = new Date(status.at * 1000);
      const formatted = new Intl.DateTimeFormat('zh-CN', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(date);
      const time = node.ownerDocument.createElement('time');
      time.dateTime = date.toISOString();
      time.textContent = `${formatted}（${zone}）`;
      node.textContent = pausedPreview ? '启用后按此时刻运行 ' : '下次运行 ';
      node.append(time);
      if (clockChange) {
        const note = node.ownerDocument.createElement('span');
        note.textContent = ' · ' + clockChange;
        node.append(note);
      }
    } catch { return; }
  }
  node.hidden = !node.textContent;
}

function fillEditor(form, item, username) {
  const schedule = (item && item.schedule) || {kind: 'now', time_zone: 'Asia/Shanghai'};
  const kind = kindOf(schedule);
  form.elements.template_id.value = (item && item.template_id) || 'custom';
  form.elements.intent.value = (item && item.intent) || '';
  form.elements.scope.value = (item && item.scope) || 'once';
  form.elements.participants.value = item && item.participants
    ? item.participants.map(row => row.username || row).join(', ')
    : (username || '');
  form.elements.agents.value = item && item.agents ? item.agents.join(', ') : '';
  form.elements.kind.value = kind;
  form.elements.date.value = schedule.date || '';
  form.elements.time.value = schedule.time || '09:00';
  form.elements.weekday.value = String(schedule.weekday || 1);
  form.elements.day.value = String(schedule.day || 1);
  form.elements.time_zone.value = schedule.time_zone || 'Asia/Shanghai';
  form.elements.prompt.value = (item && item.prompt) || '';
  form.elements.enabled.checked = Boolean(item && item.enabled);
  form.elements.notification_policy.value = notificationPolicy(item?.notification_policy);
  form.elements.title.value = item?.title || '';
  syncScheduleFields(form);
}

function syncScheduleFields(form) {
  const kind = form.elements.kind.value;
  for (const field of form.querySelectorAll('[data-schedule-kind]')) {
    const fieldKind = field.dataset.scheduleKind;
    field.hidden = fieldKind !== kind && !(fieldKind === 'timed' && kind !== 'now');
  }
  form.elements.date.required = kind === 'later';
}

function setBusy(node, busy) {
  if (!node) return;
  if (busy) {
    if (typeof node.setAttribute === 'function') node.setAttribute('aria-busy', 'true');
    return;
  }
  if (typeof node.removeAttribute === 'function') node.removeAttribute('aria-busy');
}

function monogram(name) {
  const text = String(name || '').trim();
  const chars = Array.from(text);
  const label = (chars.slice(0, chars[0] && /[A-Za-z]/.test(chars[0]) ? 2 : 1).join('') || '?');
  let tone = 0;
  for (const ch of chars) tone += ch.codePointAt(0) || 0;
  return {label, tone: (tone % 6) + 1};
}

function renderList(items, list, empty, onOpen) {
  list.textContent = '';
  list.classList.remove('template-catalog');
  setBusy(list, false);
  empty.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    const mark = monogram(item.title);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.dataset.tone = String(mark.tone);
    avatar.textContent = mark.label;
    avatar.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'item-meta';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'automation-row';
    open.dataset.automationId = item.id;
    open.setAttribute('aria-label', item.title);
    open.addEventListener('click', () => onOpen(item, open));
    const title = document.createElement('strong');
    title.className = 'item-title';
    title.textContent = item.title;
    const meta = document.createElement('span');
    meta.className = 'item-schedule';
    meta.id = 'automation-schedule-' + item.id;
    const description = [meta.id];
    meta.textContent = scheduleSummary(item.schedule, item.enabled, false);
    copy.appendChild(title);
    copy.appendChild(meta);
    const running = scopedActiveRun(item.active_run, item.workspace_id, item.id);
    if (running) {
      const pill = document.createElement('span');
      pill.className = 'status-pill item-run-status';
      pill.id = 'automation-execution-' + item.id;
      description.push(pill.id);
      pill.dataset.status = running.status;
      pill.textContent = runStatusLabel(running);
      copy.appendChild(pill);
    }
    const consumed = item.schedule_status?.state === 'once_triggered';
    if (item.schedule_status && !consumed) {
      const next = document.createElement('span');
      next.className = 'item-schedule item-next-run';
      renderNextRun(next, item);
      if (!next.hidden) {
        next.id = 'automation-next-' + item.id;
        description.push(next.id);
        copy.appendChild(next);
      }
    }
    const state = document.createElement('span');
    state.className = 'status-pill' + (item.enabled && !consumed ? ' is-on' : '');
    state.id = 'automation-state-' + item.id;
    state.textContent = consumed ? '单次计划已触发' : item.enabled ? '已启用' : '未启用';
    description.push(state.id);
    open.setAttribute('aria-describedby', description.join(' '));
    open.appendChild(avatar);
    open.appendChild(copy);
    open.appendChild(state);
    row.appendChild(open);
    list.appendChild(row);
  }
}


function renderCatalog(items, list, empty, onOpen) {
  list.textContent = '';
  list.classList.add('template-catalog');
  setBusy(list, false);
  empty.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'catalog-card';
    open.dataset.templateId = item.id;
    const title = document.createElement('strong');
    title.textContent = item.title || '';
    const summary = document.createElement('span');
    summary.className = 'note';
    summary.textContent = item.prompt || '';
    open.appendChild(title);
    open.appendChild(summary);
    open.addEventListener('click', () => onOpen(item, open));
    row.appendChild(open);
    list.appendChild(row);
  }
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const main = document.getElementById('main');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const workspaceSelect = document.getElementById('workspace');
  const search = document.getElementById('search');
  const runButton = document.getElementById('tick-automation');
  const runHistoryButton = document.getElementById('show-run-history');
  const runPanel = document.getElementById('run-panel');
  const runHeading = document.getElementById('run-heading');
  const runPages = document.getElementById('run-pages');
  const runNewer = document.getElementById('run-newer');
  const runOlder = document.getElementById('run-older');
  const newButton = document.getElementById('new-automation');
  const saveButton = document.getElementById('save-automation');
  const sampleButton = document.getElementById('save-and-sample');
  const backButton = document.getElementById('cancel-editor');
  const editorConfirm = document.getElementById('editor-head-confirm') || form;
  const manualRunNote = document.getElementById('manual-run-note');
  const manualRunStatus = document.getElementById('manual-run-status');
  const viewWatchedRun = document.getElementById('view-watched-run');
  const historyError = document.getElementById('run-history-error');
  const linkRetry = document.getElementById('automation-link-retry');
  const sourcePanel = document.getElementById('meeting-action-source');
  const tabs = document.querySelectorAll('.tabs [data-category]');
  const workspaceStatus = document.getElementById('workspace-status');
  const templateRetry = document.getElementById('automation-template-retry');
  const editorOptions = document.getElementById('automation-editor-options');
  const nextRun = document.getElementById('automation-next-run');
  const scheduleSettings = document.getElementById('automation-schedule-settings');
  const native = servedByDsBot(document);
  document.getElementById('automation-notification-settings').hidden = !native;
  let currentUser = null;
  let loadRequest = 0;
  let templates = [];
  let templateState = 'idle';
  let templateRequest = null;
  let current = null;
  let followupSource = null;
  let draftSave = null;
  let category = 'mine';
  let runTimer = 0;
  let runRequest = 0;
  let listRequest = 0;
  let listTimer = 0;
  let listFingerprint = '';
  let listReturn = null;
  let recentRuns = [];
  let selectedRun = null;
  let runCursors = [''];
  let pendingRunCursors = null;
  let nextRunCursor = '';
  let activeRun = false;
  let editorRequest = 0;
  let editorInitial = '';
  let runIntent = 0;
  let runFingerprint = '';
  const savedRunResults = new Map();
  const savingRunResults = new Set();
  const runSubmissions = new Map();
  const watchedRuns = new Map();
  const cancellingRuns = new Set();
  const view = document.defaultView;
  const readSearch = () => (view && view.location && view.location.search) || '';
  let runFilter = runFilterFromSearch(readSearch());
  // Which rows the reader opened. Kept outside the render so the 3s poll and
  // the filter switches do not close a row under the reader.
  const expandedRuns = new Set();
  const teamNames = new Map();
  const studioShare = mountStudioShare(document, {
    request: (method, path, body, signal) => request(method, path, body, undefined, signal),
    isCurrent: currentRunScope,
  });

  function pushRunFilter(filter) {
    if (!view || !view.history || !view.location) return;
    const target = automationTargetFromSearch(readSearch());
    const base = view.location.pathname || '/automations';
    const params = new URLSearchParams();
    if (target?.automation) {
      params.set('workspace', target.workspace);
      params.set('automation', target.automation);
    }
    if (filter !== 'all') params.set('runs', filter);
    const text = params.size ? '?' + params : '';
    if ((view.location.search || '') === text) return;
    view.history.pushState({runs: filter}, '', text ? base + text : base);
  }

  function clearEditorLink() {
    if (!editorTargetFromSearch(readSearch())) return;
    if (linkRetry) linkRetry.hidden = true;
    show('', '');
    view?.history?.replaceState?.({runs: runFilter}, '', (view.location.pathname || '/automations') + runFilterSearchText(runFilter));
  }

  const RUN_FILTER_BUTTONS = {all: 'run-filter-all', succeeded: 'run-filter-succeeded', failed: 'run-filter-failed'};

  function syncRunFilters() {
    for (const [name, id] of Object.entries(RUN_FILTER_BUTTONS)) {
      const button = document.getElementById(id);
      if (button) button.setAttribute('aria-current', name === runFilter ? 'true' : 'false');
    }
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  const viewerId = () => currentUser?.id || currentUser?.username;

  function runScope() {
    const workspace = workspaceId(), automation = current?.id, viewer = viewerId();
    return {workspace, automation, viewer, editor: editorRequest, key: JSON.stringify([viewer, workspace, automation])};
  }

  function currentRunScope(target) {
    return !form.hidden && !mainPanel.hidden && target.viewer === viewerId() && target.editor === editorRequest &&
      target.workspace === workspaceId() && target.automation === current?.id;
  }

  const runPath = ({workspace, automation}) => `/v1/workspaces/${workspace}/automations/${automation}`;
  const submissionAction = source => source ? `/runs/${source}/retry` : '/run';

  function submissionStorageKey(target) {
    const id = /^[a-f0-9]{32}$/;
    if (native && target.viewer && id.test(target.workspace) && id.test(target.automation)) return 'ot-automation-run:' + target.key;
  }

  function storeRunSubmission(target, submission) {
    if (submission) runSubmissions.set(target.key, submission);
    else runSubmissions.delete(target.key);
    const key = submissionStorageKey(target);
    if (!key) return;
    try {
      if (submission) {
        const {source, idempotency} = submission;
        view.sessionStorage.setItem(key, JSON.stringify({source, idempotency}));
      } else view.sessionStorage.removeItem(key);
    } catch { /* The in-page retry still works when tab storage is unavailable. */ }
  }

  function restoreRunSubmission(target) {
    const key = submissionStorageKey(target);
    if (!key || runSubmissions.has(target.key)) return;
    try {
      const saved = JSON.parse(view.sessionStorage.getItem(key));
      if (!saved || typeof saved.idempotency !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(saved.idempotency) ||
          (saved.source !== undefined && (typeof saved.source !== 'string' || !/^[a-f0-9]{32}$/.test(saved.source)))) return;
      runSubmissions.set(target.key, {source: saved.source, idempotency: saved.idempotency, state: 'uncertain'});
    } catch { /* Ignore unavailable or invalid tab data. */ }
  }

  async function runRequestWithTimeout(method, path, body, headers) {
    const signal = globalThis.AbortSignal?.timeout?.(12000);
    return request(method, path, body, headers, signal).catch(() => ({status: 0, body: {}}));
  }

  let pendingConfirm = null;
  let confirmSerial = 0;

  function closeConfirm({restoreFocus = true} = {}) {
    if (!pendingConfirm) return;
    const {box, trigger} = pendingConfirm;
    pendingConfirm = null;
    if (box && box.parentNode) box.parentNode.removeChild(box);
    if (trigger) {
      trigger.hidden = false;
      if (restoreFocus && typeof trigger.focus === 'function') trigger.focus();
    }
  }

  function openConfirm({parent, trigger, prompt, action}) {
    closeConfirm();
    const questionId = 'automation-confirm-question-' + (++confirmSerial);
    const box = document.createElement('span');
    box.className = 'row-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', questionId);
    const question = document.createElement('span');
    question.id = questionId;
    question.textContent = prompt.question;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.dataset.confirmAction = 'cancel';
    cancel.addEventListener('click', () => closeConfirm());
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    confirm.dataset.confirmAction = 'ok';
    confirm.addEventListener('click', () => {
      const run = action;
      closeConfirm();
      run();
    });
    box.appendChild(question);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    parent.appendChild(box);
    pendingConfirm = {box, trigger, action};
    if (typeof cancel.focus === 'function') cancel.focus();
  }

  // One question at a time; Esc is the keyboard way out and never acts.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingConfirm) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    closeConfirm();
  });

  function editorSettings() {
    const {elements} = form;
    return JSON.stringify(editorFields({
      get: name => elements[name]?.value,
      has: name => Boolean(elements[name]?.checked),
    }));
  }

  function editorHasChanges() {
    return !form.hidden && !mainPanel.hidden && editorInitial && editorInitial !== editorSettings();
  }

  function warnBeforeLeaving(event) {
    if (!editorHasChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function watchEditorExit() {
    if (editorHasChanges()) view?.addEventListener?.('beforeunload', warnBeforeLeaving);
    else view?.removeEventListener?.('beforeunload', warnBeforeLeaving);
  }

  function rememberEditorSettings() {
    editorInitial = editorSettings();
    watchEditorExit();
  }

  function stopRunPoll() {
    if (runTimer) {
      globalThis.clearTimeout(runTimer);
      runTimer = 0;
    }
  }

  function resetRunPages() {
    runCursors = [''];
    pendingRunCursors = null;
    nextRunCursor = '';
    if (runPages) runPages.hidden = true;
  }

  function setRunPageControls(loading = false) {
    if (runPages) runPages.hidden = !nextRunCursor && runCursors.length === 1;
    if (runNewer) runNewer.disabled = loading || runCursors.length === 1;
    if (runOlder) runOlder.disabled = loading || !nextRunCursor;
  }

  function showRunHistory() {
    runPanel?.scrollIntoView?.({block: 'start'});
    runHeading?.focus({preventScroll: true});
  }

  const runResultKey = (target, item) => target.key + '/' + item.id;
  function savedRunWork(item, target) {
    const work = exactRunForTarget(item, target) && Object.hasOwn(item, 'saved_work')
      ? item.saved_work : savedRunResults.get(runResultKey(target, item));
    return typeof work?.id === 'string' && /^[a-f0-9]{32}$/.test(work.id) ? work : null;
  }

  async function saveRunResult(button, item, target) {
    const key = runResultKey(target, item);
    if (savingRunResults.has(key)) return;
    savingRunResults.add(key);
    button.disabled = true;
    button.textContent = '保存中…';
    let savedWork = null;
    try {
      const result = await request('POST', `${runPath(target)}/runs/${item.id}/artifact`, {});
      if (!currentRunScope(target)) return;
      const work = result.body.artifact;
      if (![200, 201].includes(result.status) || typeof work?.id !== 'string' || !/^[a-f0-9]{32}$/.test(work.id)) {
        show('error', messageFor(result.body.error, '保存到作品库失败。'));
        return;
      }
      savedWork = {id:work.id, title:work.title};
      savedRunResults.set(key, savedWork);
      const attach = run => run?.id === item.id ? {...run, saved_work: savedWork} : run;
      selectedRun = attach(selectedRun);
      recentRuns = recentRuns.map(attach);
      show('ok', '已保存到作品库。');
    } catch {
      if (currentRunScope(target)) show('error', '暂时无法确认是否已保存，可以重试。');
    } finally {
      savingRunResults.delete(key);
      button.disabled = false;
      button.textContent = '保存到作品库';
      if (currentRunScope(target)) {
        renderRuns(recentRuns);
        // A list request started before the save may still carry an empty receipt.
        if (savedWork) void loadRuns();
      }
    }
  }

  function resultExportControls(item, target) {
    const controls = document.createElement('div');
    controls.className = 'run-result-actions';
    const text = runResultText(item);
    const actions = [
      ['copy-result', '复制结果', () => view.navigator.clipboard.writeText(text), '已复制本次运行结果。'],
      ['download-result', '下载文本', () => {
        const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `automation-${item.id.slice(0, 8)}.txt`;
        link.click();
        globalThis.setTimeout(() => URL.revokeObjectURL(href), 1000);
      }, '已开始下载本次运行结果。'],
      ['copy-run-link', '复制运行链接', () => {
        const url = new URL(automationRunHref(target, item.id), view.location.origin);
        return view.navigator.clipboard.writeText(url.href);
      }, '已复制私有运行链接。打开时需要原有访问权限。'],
    ];
    for (const [name, label, invoke, success] of actions) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'secondary';
      action.dataset.runControl = name;
      action.textContent = label;
      action.addEventListener('click', async () => {
        try {
          await invoke();
          if (currentRunScope(target)) show('ok', success);
        } catch {
          if (currentRunScope(target)) show('error', '暂时无法完成此操作，请重试。');
        }
      });
      controls.appendChild(action);
    }
    return controls;
  }

  function runRelatedControls(item, target) {
    if (!exactRunForTarget(item, target)) return null;
    const latest = item.latest_retry;
    const status = latest && runStatusLabel(latest);
    const links = [
      [item.retry_of, 'retry-source', '查看原运行', 'failed'],
      [latest?.id, 'latest-retry', status ? '查看重试 · ' + status : '查看重试'],
    ].filter(([id]) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) && id !== item.id);
    if (!links.length) return null;
    const controls = document.createElement('div');
    controls.className = 'run-related';
    for (const [id, name, label, filter] of links) {
      const link = document.createElement('a');
      link.dataset.runControl = name;
      link.href = automationRunHref(target, id, filter);
      link.textContent = label;
      controls.appendChild(link);
    }
    return controls;
  }

  function renderRuns(items) {
    const list = document.getElementById('run-list');
    const empty = document.getElementById('run-empty');
    const panel = document.getElementById('run-panel');
    if (!list || !panel) return;
    recentRuns = items;
    panel.hidden = false;
    const visible = items.filter(item => matchesRunFilter(item, runFilter));
    const filtering = runFilter !== 'all';
    empty.hidden = items.length > 0 || filtering;
    const filterEmpty = document.getElementById('run-filter-empty');
    if (filterEmpty) filterEmpty.hidden = !(filtering && visible.length === 0);
    const target = runScope();
    const submission = runSubmissions.get(target.key);
    const hasRetry = visible.some(retryAllowed);
    const fingerprint = JSON.stringify([target.editor, teamNames.get(target.workspace), runFilter, visible, hasRetry && activeRun,
      hasRetry && submission?.state, hasRetry && submission?.source,
      visible.map(item => [savedRunWork(item, target), savingRunResults.has(runResultKey(target, item)),
        cancellingRuns.has(`${target.key}/${item.id}`)])]);
    if (runFingerprint === fingerprint) return;
    runFingerprint = fingerprint;
    const focused = document.activeElement;
    const focusRow = focused?.closest?.('[data-run-id]');
    const restore = focusRow && list.contains(focusRow);
    const focusedControl = focused?.dataset?.runControl;
    if (pendingConfirm?.trigger.dataset.runControl === 'cancel') closeConfirm({restoreFocus: false});
    list.textContent = '';
    let nextFocus = restore ? runHeading : null;
    for (const item of visible) {
      const row = document.createElement('li');
      row.className = 'run-row';
      row.dataset.runId = item.id;
      const head = document.createElement('div');
      head.className = 'run-head';
      // The whole head is the toggle, so one click opens exactly one run.
      // Opening never fetches: the payload already carries what the detail shows.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'run-toggle';
      toggle.dataset.runControl = 'toggle';
      if (restore && focusRow.dataset.runId === item.id) nextFocus = toggle;
      const open = expandedRuns.has(item.id);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const when = document.createElement('strong');
      when.textContent = item.started ? new Date(item.started * 1000).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '运行';
      const pill = document.createElement('span');
      pill.className = 'status-pill' + (item.status === 'succeeded' ? ' is-on' : '');
      pill.dataset.status = item.status || '';
      pill.textContent = runStatusLabel(item);
      toggle.appendChild(when);
      toggle.appendChild(pill);
      const detail = document.createElement('div');
      detail.className = 'run-detail';
      detail.hidden = !open;
      const fields = runDetailFields(item);
      if (fields.length) {
        const terms = document.createElement('dl');
        for (const field of fields) {
          const term = document.createElement('dt');
          term.textContent = field.label;
          const value = document.createElement('dd');
          value.textContent = field.value;
          terms.appendChild(term);
          terms.appendChild(value);
        }
        detail.appendChild(terms);
      } else {
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = runActive(item) ? '正在等待本次结果…' : RUN_DETAIL_EMPTY;
        detail.appendChild(note);
      }
      const related = runRelatedControls(item, target);
      if (related) {
        detail.appendChild(related);
        if (restore && focusRow.dataset.runId === item.id) {
          nextFocus = [...related.children].find(control => control.dataset.runControl === focusedControl) || nextFocus;
        }
      }
      if (item.status === 'succeeded' && runResultText(item).trim() && current?.id) {
        if (native && exactRunForTarget(item, target)) {
          const exports = resultExportControls(item, target);
          if (restore && focusRow.dataset.runId === item.id) {
            nextFocus = [...exports.children].find(control => control.dataset.runControl === focusedControl) || nextFocus;
          }
          detail.appendChild(exports);
        }
        const artifact = savedRunWork(item, target);
        const action = document.createElement(artifact ? 'a' : 'button');
        action.dataset.runControl = 'artifact';
        if (restore && focusRow.dataset.runId === item.id && focusedControl === 'artifact') nextFocus = action;
        if (artifact) {
          action.href = spaceHref(target.workspace, artifact.id);
          action.className = 'run-work-link';
          action.textContent = '打开作品';
          if (artifact.title) action.title = artifact.title;
        } else {
          action.type = 'button';
          action.disabled = savingRunResults.has(runResultKey(target, item));
          action.textContent = action.disabled ? '保存中…' : '保存到作品库';
          action.addEventListener('click', () => saveRunResult(action, item, target));
        }
        detail.appendChild(action);
        const team = teamNames.get(target.workspace);
        if (studioShare && native && team) {
          const share = document.createElement('button');
          share.type = 'button';
          share.className = 'secondary run-share-team';
          share.dataset.runControl = 'studio';
          share.textContent = '分享至团队协作';
          share.setAttribute('aria-haspopup', 'dialog');
          if (restore && focusRow.dataset.runId === item.id && focusedControl === 'studio') nextFocus = share;
          share.addEventListener('click', () => studioShare.open(share, target, item.id, team));
          detail.appendChild(share);
        }
      }
      if (item.error_code === 'model_unconfigured') {
        const settings = document.createElement('a');
        settings.href = '/settings#model-api';
        settings.className = 'run-work-link';
        settings.textContent = '配置模型 API';
        detail.appendChild(settings);
      }
      toggle.addEventListener('click', () => {
        const next = !expandedRuns.has(item.id);
        if (next) expandedRuns.add(item.id);
        else expandedRuns.delete(item.id);
        detail.hidden = !next;
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      });
      head.appendChild(toggle);
      if (item.status === 'queued' && current && current.id) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.dataset.runControl = 'cancel';
        cancel.disabled = cancellingRuns.has(`${target.key}/${item.id}`);
        cancel.textContent = cancel.disabled ? '正在取消…' : '取消这次运行';
        if (restore && focusRow.dataset.runId === item.id && focusedControl === 'cancel' && !cancel.disabled) nextFocus = cancel;
        cancel.addEventListener('click', () => {
          openConfirm({
            parent: head,
            trigger: cancel,
            prompt: cancellationPrompt(item),
            action: () => cancelRun({...target, run: item.id}),
          });
        });
        head.appendChild(cancel);
      }
      if (retryAllowed(item) && current && current.id) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.dataset.runControl = 'retry';
        const rechecking = submission?.state === 'uncertain' && submission.source === item.id;
        retry.disabled = !rechecking && Boolean(activeRun || submission);
        retry.textContent = rechecking ? '确认并重试' : '重新运行';
        if (restore && focusRow.dataset.runId === item.id && focusedControl === 'retry' && !retry.disabled) nextFocus = retry;
        retry.addEventListener('click', () => submitRun(target, item.id));
        head.appendChild(retry);
      }
      row.appendChild(head);
      row.appendChild(detail);
      list.appendChild(row);
    }
    nextFocus?.focus({preventScroll: true});
  }

  async function cancelRun(target) {
    if (!target || !target.workspace || !target.automation || !target.run) return;
    const key = `${target.key}/${target.run}`;
    if (cancellingRuns.has(key)) return;
    cancellingRuns.add(key);
    if (currentRunScope(target)) renderRuns(recentRuns);
    const result = await runRequestWithTimeout('POST', `${runPath(target)}/runs/${target.run}/cancel`, {});
    cancellingRuns.delete(key);
    if (!currentRunScope(target)) return;
    if (result.status !== 200) {
      show('error', result.status === 409 ? '运行状态已改变，无法取消。'
        : messageFor(result.body.error, '暂时无法确认已取消，正在更新运行状态。'));
    } else {
      const item = result.body.run;
      if (watchMatches(item, target) && watchedRuns.get(target.key)?.id === item.id) watchedRuns.set(target.key, item);
      show('ok', '已取消。');
    }
    await loadRuns();
  }

  function watchMatches(item, target) {
    return Boolean(item?.id && (!item.workspace_id || item.workspace_id === target.workspace) &&
      (!item.automation_id || item.automation_id === target.automation));
  }

  function syncRunControls() {
    const target = runScope();
    const submission = runSubmissions.get(target.key);
    const watched = watchedRuns.get(target.key);
    const uncertain = submission?.state === 'uncertain';
    const pending = submission?.state === 'pending';
    runButton.disabled = saveButton.disabled || pending || (activeRun && !uncertain);
    runButton.textContent = pending ? '正在提交…' : uncertain ? '确认并重试' : activeRun ? '已有运行' : '运行一次';
    const label = pending ? '正在提交本次运行…' : uncertain ? '暂时无法确认是否提交成功，可以重试。' : runStatusLabel(watched);
    if (manualRunStatus) {
      manualRunStatus.dataset.state = pending ? 'pending' : uncertain ? 'uncertain' : watched?.status || '';
      if (manualRunStatus.textContent !== label) manualRunStatus.textContent = label;
    }
    if (viewWatchedRun) {
      viewWatchedRun.hidden = !watched || uncertain || recentRuns.some(item => item.id === watched.id && matchesRunFilter(item, runFilter));
    }
  }

  async function recoverRunReceipt(target, stillCurrent) {
    if (!submissionStorageKey(target)) return;
    const submission = runSubmissions.get(target.key);
    if (submission?.state !== 'uncertain') return;
    const result = await runRequestWithTimeout('GET', runPath(target) + submissionAction(submission.source), undefined,
      {'Idempotency-Key': submission.idempotency});
    const item = result.body?.run;
    if (!stillCurrent() || runSubmissions.get(target.key) !== submission || submission.state !== 'uncertain') return;
    if (result.status !== 200 || !/^[a-f0-9]{32}$/.test(item?.id || '') ||
        item.workspace_id !== target.workspace || item.automation_id !== target.automation) return;
    return {item, submission};
  }

  async function submitRun(target, source) {
    if (!target.workspace || !target.automation || !currentRunScope(target)) return;
    let submission = runSubmissions.get(target.key);
    if (submission ? submission.state !== 'uncertain' || submission.source !== source : activeRun) return;
    if (!submission) submission = {source, idempotency: idempotencyKey()};
    submission.state = 'pending';
    storeRunSubmission(target, submission);
    if (submissionStorageKey(target)) {
      replaceAutomationLink({workspace_id: target.workspace, id: target.automation}, source ? {id:source} : null);
    }
    const intent = runIntent;
    show('', '');
    syncRunControls();
    if (!runPanel?.hidden) renderRuns(recentRuns);
    const result = await runRequestWithTimeout('POST', runPath(target) + submissionAction(source), {}, {'Idempotency-Key': submission.idempotency});
    if (runSubmissions.get(target.key) !== submission) return;
    const accepted = result.status === 200 || result.status === (source ? 201 : 202);
    const item = result.body.run;
    const confirmed = accepted && watchMatches(item, target);
    const uncertain = !confirmed && (accepted || result.status === 0 || result.status === 408 || result.status >= 500);
    if (uncertain) submission.state = 'uncertain';
    else storeRunSubmission(target, null);
    if (confirmed) watchedRuns.set(target.key, item);
    if (!currentRunScope(target)) return;
    if (!confirmed) {
      if (!uncertain) show('error', messageFor(result.body.error, source ? '重新运行失败。' : '无法启动这条自动化。'));
      syncRunControls();
      if (!runPanel?.hidden) renderRuns(recentRuns);
      await loadRuns();
      return;
    }
    const onLatest = (pendingRunCursors || runCursors).length === 1 && runFilter === 'all';
    if (!source && intent === runIntent) {
      runFilter = 'all';
      resetRunPages();
      syncRunFilters();
      pushRunFilter(runFilter);
    }
    activeRun = runActive(item);
    expandedRuns.add(item.id);
    const isRetry = source && item.retry_of === source && exactRunForTarget(item, target);
    if (isRetry) expandedRuns.add(source);
    const withRetry = row => isRetry && row?.id === source
      ? {...row, latest_retry:{id:item.id,status:item.status}} : row;
    selectedRun = withRetry(selectedRun);
    if ((pendingRunCursors || runCursors).length === 1 && runFilter === 'all') {
      renderRuns([item, ...(onLatest ? recentRuns.filter(run => run.id !== item.id).map(withRetry) : [])].slice(0, 20));
    } else if (isRetry) renderRuns(recentRuns.map(withRetry));
    syncRunControls();
    if (!source && intent === runIntent) showRunHistory();
    await loadRuns();
  }

  function scheduleRunPoll(pending) {
    if (!pending && !current?.enabled) return;
    runTimer = globalThis.setTimeout(() => {
      runTimer = 0;
      void loadRuns();
    }, pending ? (runActive(selectedRun) ? 1000 : 3000) : 12000);
  }

  async function loadRuns({cursors = pendingRunCursors || runCursors, focus = false} = {}) {
    stopRunPoll();
    const panel = document.getElementById('run-panel');
    if (!panel) return;
    if (!current?.id || !workspaceId() || form.hidden || mainPanel.hidden) {
      panel.hidden = true;
      return;
    }
    const target = runScope();
    const seq = ++runRequest;
    pendingRunCursors = cursors;
    const wanted = runFilter === 'all' ? '' : `&status=${runFilter}`;
    const cursor = cursors.at(-1);
    setRunPageControls(true);
    const path = `${runPath(target)}/runs`;
    const stillCurrent = () => seq === runRequest && currentRunScope(target);
    const receipt = recoverRunReceipt(target, stillCurrent);
    const listed = await runRequestWithTimeout('GET', `${path}?limit=20${wanted}${cursor ? '&cursor=' + cursor : ''}`);
    if (!stillCurrent()) return;
    pendingRunCursors = null;
    const ok = listed.status === 200 && Array.isArray(listed.body.items);
    const items = ok ? listed.body.items : [];
    if (ok) {
      runCursors = cursors;
      nextRunCursor = /^[0-9a-f]{32}$/.test(listed.body.cursor || '') ? listed.body.cursor : '';
      const pending = scopedActiveRun(listed.body.active_run, target.workspace, target.automation);
      if (pending) watchedRuns.set(target.key, pending);
      activeRun = Boolean(pending) || (typeof listed.body.has_pending === 'boolean' ? listed.body.has_pending : items.some(runActive));
      const upcoming = listed.body.schedule_status;
      if (listed.body.schedule_revision === current.revision &&
          (upcoming?.state !== current.schedule_status?.state || upcoming?.at !== current.schedule_status?.at ||
            upcoming?.clock_change !== current.schedule_status?.clock_change)) {
        current.schedule_status = upcoming;
        renderEditorSchedule();
        renderManualRunNote();
      }
      setRunPageControls();
      const found = selectedRun && items.find(item => item.id === selectedRun.id && exactRunForTarget(item, target));
      if (found) selectedRun = found;
      const showSelection = selectedRun && !cursor && !found && matchesRunFilter(selectedRun, runFilter);
      renderRuns(showSelection ? [selectedRun, ...items] : items);
      if (focus) showRunHistory();
    } else {
      setRunPageControls();
      panel.hidden = false;
    }
    if (historyError) historyError.hidden = ok;
    syncRunControls();
    const recovered = await receipt;
    if (!stillCurrent()) return;
    if (recovered && runSubmissions.get(target.key) === recovered.submission && recovered.submission.state === 'uncertain') {
      storeRunSubmission(target, null);
      const shown = items.find(item => item.id === recovered.item.id && !runActive(item)) || recovered.item;
      watchedRuns.set(target.key, shown);
      expandedRuns.add(shown.id);
      activeRun ||= runActive(shown);
      if (!cursor && matchesRunFilter(shown, runFilter)) {
        runFingerprint = '';
        renderRuns([shown, ...items.filter(item => item.id !== shown.id)].slice(0, 20));
      }
    }
    const watched = watchedRuns.get(target.key);
    let updated = watched && items.find(item => item.id === watched.id && watchMatches(item, target));
    const reportedActive = ok && scopedActiveRun(listed.body.active_run, target.workspace, target.automation);
    if (!updated && runActive(watched) && reportedActive?.id !== watched.id) {
      const exact = await runRequestWithTimeout('GET', `${path}/${encodeURIComponent(watched.id)}`);
      if (!stillCurrent()) return;
      if (watchedRuns.get(target.key) === watched && exact.status === 200 && exact.body.run?.id === watched.id && watchMatches(exact.body.run, target)) {
        updated = exact.body.run;
      }
    }
    if (updated && watchedRuns.get(target.key) === watched) watchedRuns.set(target.key, updated);
    syncRunControls();
    scheduleRunPoll(activeRun || runActive(watchedRuns.get(target.key)) || runSubmissions.get(target.key)?.state === 'pending');
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  function fillTemplates() {
    const select = form.elements.template_id;
    const selected = select.value || current?.template_id;
    select.textContent = '';
    const available = templates.some(item => item.id === 'custom')
      ? [...templates] : [{id: 'custom', title: '自定义'}, ...templates];
    if (current?.id && current.template_id && !available.some(item => item.id === current.template_id)) {
      available.push({id: current.template_id, title: '已保存的模板'});
    }
    for (const item of available) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      select.appendChild(option);
    }
    if (available.some(item => item.id === selected)) select.value = selected;
  }

  function loadTemplates(seq = loadRequest) {
    if (templateState === 'ready') return Promise.resolve();
    if (templateRequest?.seq === seq) return templateRequest.promise;
    templateState = 'loading';
    const promise = request('GET', '/v1/automation-templates').catch(() => null).then(catalog => {
      if (seq !== loadRequest) return;
      templateRequest = null;
      const items = catalog?.status === 200 && catalog.body?.items;
      templateState = Array.isArray(items) ? 'ready' : 'failed';
      templates = templateState === 'ready' ? items : [];
      if (!form.hidden) fillTemplates();
    });
    templateRequest = {seq, promise};
    return promise;
  }

  function renderMeetingSource(source) {
    if (!sourcePanel) return;
    sourcePanel.hidden = !source;
    const title = document.getElementById('meeting-action-source-title');
    const text = document.getElementById('meeting-action-source-text');
    const owner = document.getElementById('meeting-action-source-owner');
    const link = document.getElementById('meeting-action-source-link');
    title.textContent = source?.title || '';
    text.textContent = source?.text || '';
    owner.hidden = !source?.owner;
    owner.textContent = source?.owner ? '原负责人：' + source.owner : '';
    if (source) {
      const {workspace, meeting} = source.target;
      link.href = '/meetings#' + new URLSearchParams({workspace, meeting});
    } else link.removeAttribute?.('href');
  }

  function renderFollowupSource(source) {
    const memory = source?.target.memoryAction ? source : null;
    renderMeetingSource(memory ? null : source);
    const panel = document.getElementById('memory-action-source');
    if (panel) {
      panel.hidden = !memory;
      document.getElementById('memory-action-source-title').textContent = memory?.title || '';
      const notes = document.getElementById('memory-action-source-notes');
      notes.hidden = !memory?.notes;
      notes.textContent = memory?.notes || '';
      const revision = document.getElementById('memory-action-source-revision');
      revision.textContent = memory ? `行动项版本 ${memory.target.revision}` : '';
      const link = document.getElementById('memory-action-source-link');
      if (memory) {
        link.href = '/memory?' + new URLSearchParams({workspace: memory.target.workspace, page: 'todos', action: memory.target.memoryAction});
      } else link.removeAttribute?.('href');
    }
    form.elements.enabled.disabled = Boolean(followupSource);
  }

  function discardFollowupDraft() {
    if (!followupSource) return;
    followupSource = null;
    current = null;
    fillEditor(form, null, '');
    renderFollowupSource(null);
    form.hidden = true;
    watchEditorExit();
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
  }

  function openEditor(item, source = null, opener = null, run = null) {
    listReturn = opener && {opener, workspace: workspaceId(), category, query: search.value, scroll: main.scrollTop || 0};
    // A question belongs to the editor that raised it; entering another editor
    // drops the question instead of showing it again above a different item.
    closeConfirm({restoreFocus: false});
    globalThis.clearTimeout(listTimer);
    listRequest += 1;
    editorRequest += 1;
    if (linkRetry) linkRetry.hidden = true;
    saveButton.disabled = false;
    saveButton.textContent = '保存';
    backButton.disabled = false;
    current = item;
    followupSource = source;
    draftSave = null;
    recentRuns = [];
    selectedRun = run;
    if (selectedRun) {
      if (!matchesRunFilter(selectedRun, runFilter)) runFilter = 'all';
      syncRunFilters();
      expandedRuns.add(selectedRun.id);
    }
    const target = runScope();
    restoreRunSubmission(target);
    const pending = scopedActiveRun(item?.active_run, target.workspace, target.automation);
    if (pending) watchedRuns.set(target.key, pending);
    activeRun = Boolean(pending);
    runFingerprint = '';
    document.getElementById('run-list').textContent = '';
    document.getElementById('run-empty').hidden = true;
    document.getElementById('run-filter-empty').hidden = true;
    if (runPanel) runPanel.hidden = true;
    if (historyError) historyError.hidden = true;
    resetRunPages();
    if (runHistoryButton) runHistoryButton.hidden = !item?.id;
    stopRunPoll();
    listPanel.hidden = true;
    form.hidden = false;
    mainPanel.classList.add('is-editing');
    fillTemplates();
    fillEditor(form, item, currentUser && currentUser.username);
    renderFollowupSource(source || savedFollowupSource(item));
    renderEditorSchedule();
    form.elements.template_id.disabled = Boolean(item?.id);
    rememberEditorSettings();
    const heading = document.getElementById('editor-heading');
    if (heading) heading.textContent = item?.id ? item.title
      : source?.target.memoryAction ? '准备行动跟进' : source ? '创建会议跟进' : '新建自动化';
    document.getElementById('remove-automation').hidden = !item || !item.id;
    runButton.hidden = !item?.id;
    syncRunControls();
    renderManualRunNote();
    if (selectedRun) {
      renderRuns([selectedRun]);
      showRunHistory();
    }
    void loadRuns();
    if ((!item?.id && !source) || editorOptions?.open) void loadTemplates();
    main.scrollTop = 0;
    heading?.focus({preventScroll: true});
  }

  function renderManualRunNote() {
    if (!manualRunNote) return;
    manualRunNote.hidden = !current?.id && !followupSource;
    manualRunNote.textContent = followupSource ? '保存为暂停的自动化。保存后可手动运行一次。'
      : current?.schedule_status?.state === 'once_triggered' ? '可以用已保存的设置手动运行一次。' : current?.enabled
      ? '按计划自动运行。也可用已保存的设置额外运行一次。'
      : '自动运行已暂停。「运行一次」使用已保存的设置，运行后仍保持暂停。';
  }

  function renderEditorSchedule() {
    if (sampleButton) {
      sampleButton.hidden = !native || Boolean(current?.id || followupSource) || !RECURRING_KINDS.has(form.elements.kind.value);
      sampleButton.disabled = saveButton.disabled;
    }
    if (!nextRun) return;
    if (!current?.schedule_status || !current.schedule) {
      renderNextRun(nextRun);
      return;
    }
    const shown = scheduleFromForm(new FormData(form));
    const saved = current.schedule;
    const unchanged = form.elements.enabled.checked === current.enabled && Object.keys(shown).every(key =>
      (key === 'kind' && saved.kind === 'later' ? 'once' : saved[key]) === shown[key]);
    renderNextRun(nextRun, unchanged ? current : null);
  }

  function readLinkedAutomation(target) {
    const path = runPath(target);
    return Promise.all([
      runRequestWithTimeout('GET', path),
      target.run ? runRequestWithTimeout('GET', `${path}/runs/${target.run}`) : null,
    ]);
  }

  async function openLinkedAutomation(target, loadSeq, reading) {
    const seq = ++editorRequest;
    show('', '正在打开自动化…');
    const [result, exact] = await (reading || readLinkedAutomation(target));
    if (seq !== editorRequest || loadSeq !== loadRequest || workspaceId() !== target.workspace || !form.hidden) return;
    const item = result.body.automation;
    if (result.status === 200 && item?.id === target.automation && item.workspace_id === target.workspace) {
      const run = exact?.body.run;
      const selected = exact?.status === 200 && run?.id === target.run && exactRunForTarget(run, target) ? run : null;
      if (target.run && !selected) show('error', '暂时无法打开这次运行。你可以从运行记录重新选择。');
      else show('', '');
      openEditor(item, null, null, selected);
      return true;
    }
    show('error', [403, 404].includes(result.status) ? '这条自动化已不可用。' : '暂时无法打开自动化。');
    if (linkRetry) {
      linkRetry.textContent = '重新打开自动化';
      linkRetry.hidden = [403, 404].includes(result.status);
    }
  }

  async function readMeetingSource(target) {
    const query = new URLSearchParams({index: target.action, revision: target.revision});
    return request('GET', `/v1/workspaces/${target.workspace}/meetings/${target.meeting}/action?${query}`)
      .catch(() => ({status: 0, body: {}}));
  }

  function showMeetingSourceError(status) {
    const obsolete = [200, 403, 404, 409].includes(status);
    show('error', obsolete ? '行动项已更新、已完成或不可访问。请返回会议重新选择。' : '暂时无法读取会议行动项，请重试。');
    return obsolete;
  }

  async function openMeetingDraft(target, loadSeq) {
    const seq = ++editorRequest;
    const user = currentUser;
    show('', '正在读取会议行动项…');
    const isCurrent = () => seq === editorRequest && loadSeq === loadRequest && currentUser === user &&
      workspaceId() === target.workspace && form.hidden;
    const sourceQuery = new URLSearchParams({meeting: target.meeting, revision: target.revision, action: target.action});
    const sourceRequest = readMeetingSource(target);
    const existing = await request('GET', `/v1/workspaces/${target.workspace}/automations?${sourceQuery}`)
      .catch(() => ({status: 0, body: {}}));
    if (!isCurrent()) return;
    const item = existing.body?.automation;
    const saved = savedMeetingSource(item);
    if (existing.status === 200 && existing.body.viewer_username === user.username && /^[0-9a-f]{32}$/.test(item?.id || '') &&
        saved?.target.workspace === target.workspace && saved.target.meeting === target.meeting &&
        saved.target.action === target.action && saved.target.revision === target.revision) {
      show('', '');
      replaceAutomationLink(item);
      openEditor(item);
      return true;
    }
    const result = await sourceRequest;
    if (!isCurrent()) return;
    const source = result.status === 200 ? meetingSourceFromResponse(result.body, target, user.username) : null;
    if (source) {
      show('', '');
      openEditor(meetingActionDraft(source, user.username), source);
      return true;
    }
    const obsolete = showMeetingSourceError(result.status);
    if (linkRetry) {
      linkRetry.textContent = '重新打开行动项';
      linkRetry.hidden = obsolete;
    }
  }

  function showMemorySourceError(status) {
    const obsolete = [200, 403, 404, 409].includes(status);
    show('error', obsolete ? '记忆行动项已更新、已完成或不可访问。请返回记忆重新选择。' : '暂时无法读取记忆行动项，请重试。');
    return obsolete;
  }

  async function openMemoryActionDraft(target, loadSeq) {
    const seq = ++editorRequest;
    const user = currentUser;
    show('', '正在读取记忆行动项…');
    const query = new URLSearchParams({memory_action: target.memoryAction, revision: target.revision});
    const result = await runRequestWithTimeout('GET', `/v1/workspaces/${target.workspace}/automations?${query}`);
    if (seq !== editorRequest || loadSeq !== loadRequest || currentUser !== user ||
        workspaceId() !== target.workspace || !form.hidden) return;
    if (result.status === 200 && result.body.viewer_username === user.username) {
      const item = result.body.automation;
      const saved = savedMemoryActionSource(item);
      if (/^[0-9a-f]{32}$/.test(item?.id || '') && saved?.target.workspace === target.workspace &&
          saved.target.memoryAction === target.memoryAction && saved.target.revision === target.revision) {
        show('', '');
        replaceAutomationLink(item);
        openEditor(item);
        return true;
      }
      const action = result.body.action;
      if (action?.id === target.memoryAction && action.workspace_id === target.workspace && action.revision === target.revision &&
          action.status === 'open' && typeof action.title === 'string' && action.title.trim() && typeof action.notes === 'string') {
        const source = {target, title: action.title, notes: action.notes, due_at: action.due_at};
        show('', '');
        openEditor(memoryActionDraft(source, user.username), source);
        return true;
      }
    }
    const obsolete = showMemorySourceError(result.status);
    if (linkRetry) {
      linkRetry.textContent = '重新打开行动项';
      linkRetry.hidden = obsolete;
    }
  }

  function replaceAutomationLink(item, run = null) {
    const params = new URLSearchParams({workspace: item.workspace_id, automation: item.id});
    if (run) params.set('run', run.id);
    if (runFilter !== 'all') params.set('runs', runFilter);
    view?.history?.replaceState?.({runs: runFilter}, '', (view.location.pathname || '/automations') + '?' + params);
  }

  function selectCategory(value) {
    category = value;
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', tab.dataset.category === category ? 'true' : 'false');
    }
  }

  async function loadList({startup, quiet = false} = {}) {
    globalThis.clearTimeout(listTimer);
    const id = workspaceId();
    if (!id) return;
    const seq = ++listRequest;
    const list = document.getElementById('automation-list');
    const empty = document.getElementById('list-empty');
    const searchText = search.value;
    const refreshPending = () => {
      listTimer = globalThis.setTimeout(() => {
        if (!listPanel.hidden && workspaceId() === id && search.value === searchText && listRequest === seq) void loadList({quiet: true});
      }, document.hidden ? 12000 : 3500);
    };
    const renderItems = items => {
      const fingerprint = JSON.stringify(items);
      if (!quiet || listFingerprint !== fingerprint) {
        const focused = document.activeElement?.dataset?.automationId;
        listFingerprint = fingerprint;
        renderList(items, list, empty, (item, opener) => openEditor(item, null, opener));
        if (quiet && /^[a-f0-9]{32}$/.test(focused || '')) list.querySelector?.(`[data-automation-id="${focused}"]`)?.focus({preventScroll: true});
      }
      if (items.some(item => scopedActiveRun(item.active_run, id, item.id))) refreshPending();
    };
    if (category === 'work' || category === 'life') {
      const render = () => {
        const loading = templateState === 'idle' || templateState === 'loading';
        empty.textContent = {
          idle: '正在加载模板…', loading: '正在加载模板…', failed: '无法加载模板。', ready: '没有匹配的模板。',
        }[templateState];
        if (templateRetry) templateRetry.hidden = templateState !== 'failed';
        renderCatalog(catalogItems(templates, category, search.value), list, empty,
          (item, opener) => openEditor(draftFromTemplate(item, currentUser && currentUser.username), null, opener));
        setBusy(list, loading);
        setBusy(empty, loading);
      };
      if (!quiet || templateState !== 'ready') render();
      if (templateState === 'idle' || templateState === 'loading') {
        await loadTemplates();
        if (seq === listRequest && !listPanel.hidden && workspaceId() === id) render();
      }
      return;
    }
    if (templateRetry) templateRetry.hidden = true;
    const projected = startup?.workspace === id && category === 'mine' && !search.value.trim() ? startup.items : null;
    if (projected) {
      empty.textContent = '这个分类下还没有自动化。';
      setBusy(empty, false);
      renderItems(projected);
      return;
    }
    if (!quiet) {
      setBusy(list, true);
      list.textContent = '';
      empty.hidden = false;
      setBusy(empty, true);
      empty.textContent = '正在加载自动化…';
    }
    const listed = await request('GET', `/v1/workspaces/${id}/automations${listQuery(category, search.value)}`)
      .catch(() => ({status: 0, body: {}}));
    if (seq !== listRequest || workspaceId() !== id) return;
    setBusy(empty, false);
    setBusy(list, false);
    if (listed.status !== 200) {
      if (quiet && ![401, 403, 404].includes(listed.status)) {
        refreshPending();
        return;
      }
      list.textContent = '';
      empty.hidden = false;
      empty.textContent = messageFor(listed.body.error, '无法读取自动化列表。');
      return;
    }
    empty.textContent = '这个分类下还没有自动化。';
    renderItems(listed.body.items || []);
  }

  function fillWorkspaces(items) {
    const previous = workspaceId();
    workspaceSelect.textContent = '';
    teamNames.clear();
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
      if (item.kind === 'team' && item.name) teamNames.set(item.id, item.name);
    }
    if (items.some(item => item.id === previous)) workspaceSelect.value = previous;
  }

  async function load() {
    const seq = ++loadRequest;
    const target = editorTargetFromSearch(readSearch());
    const wantedTemplate = !target && templateFromSearch(readSearch());
    discardFollowupDraft();
    newButton.disabled = true;
    workspaceStatus.textContent = '';
    if (linkRetry) linkRetry.hidden = true;
    const sessionRequest = request('GET', '/v1/auth/session').catch(() => ({status: 0, body: {}}));
    const initialCatalogue = native && !target && !wantedTemplate && category === 'mine' && !search.value.trim()
      ? request('GET', '/v1/workspaces?scope=personal&include=automations').catch(() => null) : null;
    const session = await sessionRequest;
    if (seq !== loadRequest) return;
    if (session.status === 401) {
      currentUser = null;
      templates = [];
      templateState = 'idle';
      templateRequest = null;
      runSubmissions.clear();
      watchedRuns.clear();
      stopRunPoll();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      watchEditorExit();
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    const previousViewer = viewerId();
    currentUser = session.body.user;
    if (previousViewer && previousViewer !== viewerId()) {
      editorRequest += 1;
      templates = [];
      templateState = 'idle';
      templateRequest = null;
      runSubmissions.clear();
      watchedRuns.clear();
      stopRunPoll();
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = currentUser.username;
    const catalog = wantedTemplate ? loadTemplates(seq) : null;
    const linked = native && target?.automation ? readLinkedAutomation(target) : null;
    const personalRequest = initialCatalogue?.then(result => ownedPersonalCatalogue(result, session.body.user));
    let {initial: space, supplemental} = await readWorkspaceChoices(request, '/v1/workspaces?limit=100', personalRequest);
    if (target?.workspace && !space.body?.items?.some(item => item.id === target.workspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) space = shared;
      supplemental = null;
    }
    if (seq !== loadRequest) return;
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    const items = space.body.items || [];
    fillWorkspaces(items);
    if (!items.length) {
      document.getElementById('automation-list').textContent = '';
      document.getElementById('list-empty').hidden = false;
      document.getElementById('list-empty').textContent = '还没有工作区。';
      return;
    }
    newButton.disabled = false;
    document.getElementById('list-empty').textContent = '这个分类下还没有自动化。';
    form.hidden = true;
    watchEditorExit();
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    void supplemental?.then(result => {
      if (seq !== loadRequest) return;
      if (result.status === 200) fillWorkspaces(result.body.items);
      else workspaceStatus.textContent = '团队工作区暂时无法加载。';
    });
    if (target?.workspace && items.some(item => item.id === target.workspace)) {
      workspaceSelect.value = target.workspace;
      const opening = target.memoryAction ? openMemoryActionDraft(target, seq)
        : target.meeting ? openMeetingDraft(target, seq) : openLinkedAutomation(target, seq, linked);
      const selected = editorRequest;
      if (await opening || seq !== loadRequest || selected !== editorRequest || !form.hidden) return;
    } else if (target) {
      show('error', memoryActionTargetFromSearch(readSearch()) ? '记忆行动项链接已不可用。'
        : meetingTargetFromSearch(readSearch()) ? '会议行动项链接已不可用。' : '这条自动化链接已不可用。');
    }
    if (catalog) {
      const selected = editorRequest;
      await catalog;
      if (seq !== loadRequest || selected !== editorRequest || !form.hidden) return;
      const template = templates.find(item => item.id === wantedTemplate);
      if (template) {
        openEditor(draftFromTemplate(template, currentUser.username));
        return;
      }
    }
    const projectedWorkspace = space.body.items?.[0]?.id;
    const projectedItems = space.body.automations?.items;
    const startup = personalRequest && space === await personalRequest && Array.isArray(projectedItems) &&
      projectedItems.every(item => item?.workspace_id === projectedWorkspace && /^[0-9a-f]{32}$/.test(item.id))
      ? {workspace: projectedWorkspace, items: projectedItems} : null;
    if (seq === loadRequest) await loadList({startup});
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  workspaceSelect.addEventListener('change', () => {
    editorRequest += 1;
    clearEditorLink();
    closeConfirm({restoreFocus: false});
    discardFollowupDraft();
    current = null;
    form.hidden = true;
    watchEditorExit();
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    if (runPanel) runPanel.hidden = true;
    stopRunPoll();
    loadList();
  });
  linkRetry?.addEventListener('click', () => load());
  templateRetry?.addEventListener('click', () => {
    void loadTemplates();
    return loadList();
  });
  editorOptions?.addEventListener('toggle', () => {
    if (editorOptions.open && !form.hidden) void loadTemplates();
  });
  search.addEventListener('input', () => loadList());
  runHistoryButton?.addEventListener('click', () => {
    if (runPanel?.hidden) void loadRuns({focus: true});
    else showRunHistory();
  });
  runNewer?.addEventListener('click', () => {
    runIntent += 1;
    if (runCursors.length > 1) void loadRuns({cursors: runCursors.slice(0, -1), focus: true});
  });
  runOlder?.addEventListener('click', () => {
    runIntent += 1;
    if (nextRunCursor) void loadRuns({cursors: [...runCursors, nextRunCursor], focus: true});
  });
  viewWatchedRun?.addEventListener('click', () => {
    const watched = watchedRuns.get(runScope().key);
    if (!watched) return;
    runIntent += 1;
    expandedRuns.add(watched.id);
    runFilter = 'all';
    resetRunPages();
    syncRunFilters();
    pushRunFilter(runFilter);
    void loadRuns({focus: true});
  });
  document.getElementById('run-history-retry')?.addEventListener('click', () => void loadRuns());
  syncRunFilters();
  for (const [filter, id] of Object.entries(RUN_FILTER_BUTTONS)) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.addEventListener('click', async () => {
      if (filter === runFilter) return;
      runIntent += 1;
      runFilter = filter;
      resetRunPages();
      syncRunFilters();
      pushRunFilter(filter);
      await loadRuns();
    });
  }
  if (view && typeof view.addEventListener === 'function') {
    view.addEventListener('popstate', () => {
      const wanted = runFilterFromSearch(readSearch());
      if (wanted === runFilter) return;
      runIntent += 1;
      runFilter = wanted;
      resetRunPages();
      syncRunFilters();
      loadRuns();
    });
  }
  for (const tab of tabs) {
    tab.addEventListener('click', async () => {
      editorRequest += 1;
      clearEditorLink();
      selectCategory(tabCategory(tab.dataset.category));
      discardFollowupDraft();
      form.hidden = true;
      watchEditorExit();
      listPanel.hidden = false;
      closeConfirm({restoreFocus: false});
      mainPanel.classList.remove('is-editing');
      const runPanel = document.getElementById('run-panel');
      if (runPanel) runPanel.hidden = true;
      stopRunPoll();
      await loadList();
    });
  }

  newButton.addEventListener('click', () => {
    clearEditorLink();
    openEditor(null, null, newButton);
  });
  form.elements.kind.addEventListener('change', () => syncScheduleFields(form));
  scheduleSettings?.addEventListener('input', renderEditorSchedule);
  scheduleSettings?.addEventListener('change', renderEditorSchedule);

  async function returnToList() {
    const transition = ++editorRequest;
    const position = listReturn;
    listReturn = null;
    clearEditorLink();
    closeConfirm({restoreFocus: false});
    discardFollowupDraft();
    current = null;
    form.hidden = true;
    watchEditorExit();
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    const runPanel = document.getElementById('run-panel');
    if (runPanel) runPanel.hidden = true;
    stopRunPoll();
    const restore = position?.workspace === workspaceId() && position?.category === category && position?.query === search.value;
    const returnFocus = () => {
      const opener = restore ? position.opener : null;
      const automation = opener?.dataset.automationId;
      const template = opener?.dataset.templateId;
      const resolved = opener?.isConnected ? opener : Array.from(listPanel.querySelectorAll('button[data-automation-id], button[data-template-id]'))
        .find(button => automation ? button.dataset.automationId === automation : template && button.dataset.templateId === template);
      const control = resolved || newButton;
      main.scrollTop = restore && resolved ? position.scroll : 0;
      control.focus({preventScroll: true});
      control.scrollIntoView?.({block: 'nearest'});
    };
    returnFocus();
    const focused = document.activeElement;
    await loadList({quiet: restore});
    if (editorRequest === transition && focused && !focused.isConnected && document.activeElement === document.body) returnFocus();
  }

  backButton.addEventListener('click', () => {
    if (!editorHasChanges()) return returnToList();
    const editor = editorRequest;
    openConfirm({
      parent: editorConfirm,
      trigger: backButton,
      prompt: {question: '有未保存的修改。要放弃修改并返回列表吗？', confirmLabel: '放弃修改'},
      action: () => {
        if (editor === editorRequest && !form.hidden) return returnToList();
      },
    });
  });
  form.addEventListener('input', watchEditorExit);
  form.addEventListener('change', watchEditorExit);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saveButton.disabled) return;
    const values = readEditor(form);
    if (!native) delete values.notification_policy;
    const workspace = workspaceId();
    if (!workspace) {
      show('error', '先选择一个工作区。');
      return;
    }
    if (!values.title || !values.participants.length) {
      show('error', '请填写标题和至少一名参与成员。');
      return;
    }
    const item = current?.id ? current : null;
    const source = followupSource;
    const sample = Boolean(sampleButton && event.submitter === sampleButton && !sampleButton.hidden &&
      !item && !source && native && RECURRING_KINDS.has(values.schedule.kind));
    const editor = editorRequest;
    const loadSeq = loadRequest;
    const isCurrent = () => editorRequest === editor && loadRequest === loadSeq && workspaceId() === workspace && !form.hidden;
    if (source) values.enabled = false;
    const path = `/v1/workspaces/${workspace}/automations`;
    const {template_id, ...changes} = values;
    closeConfirm({restoreFocus: false});
    saveButton.disabled = true;
    if (sampleButton) sampleButton.disabled = true;
    backButton.disabled = true;
    saveButton.textContent = '保存中…';
    if (sample) sampleButton.textContent = '正在保存…';
    syncRunControls();
    let result;
    try {
      if (item) {
        result = await request('POST', `${path}/${item.id}`, {revision: item.revision, changes});
      } else {
        const ref = source?.target;
        const provenance = ref?.memoryAction ? {source_memory_action: {action_id: ref.memoryAction, revision: ref.revision}}
          : ref ? {source_meeting: {meeting_id: ref.meeting, revision: ref.revision, action_index: ref.action}} : {};
        const body = {...changes, template_id, ...provenance, ...(sample ? {run_sample: true} : {})};
        const content = JSON.stringify([workspace, body]);
        if (draftSave?.content !== content) draftSave = {content, key: idempotencyKey()};
        result = await request('POST', path, body, {'Idempotency-Key': draftSave.key});
      }
    } catch {
      if (isCurrent()) show('error', '暂时无法确认是否保存成功，请重试。');
      return;
    } finally {
      if (isCurrent()) {
        saveButton.disabled = false;
        backButton.disabled = false;
        saveButton.textContent = '保存';
        if (sampleButton) {
          sampleButton.disabled = false;
          sampleButton.textContent = '保存并试运行';
        }
        syncRunControls();
      }
    }
    if (!isCurrent()) return;
    if (source && result.body.error?.code === 'meeting_source_unavailable') {
      showMeetingSourceError(result.status);
      return;
    }
    if (source && result.body.error?.code === 'memory_source_unavailable') {
      showMemorySourceError(result.status);
      return;
    }
    if (result.status === 409) {
      show('error', '自动化已在别处更新，请重新打开后再保存。');
      await loadList();
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.automation;
    const returnedSample = result.body.sample_run;
    const startedSample = sample && exactRunForTarget(returnedSample, runScope()) ? returnedSample : null;
    if (startedSample) {
      selectedRun = startedSample;
      watchedRuns.set(runScope().key, startedSample);
      expandedRuns.add(startedSample.id);
      activeRun = runActive(startedSample);
      runFilter = 'all';
      syncRunFilters();
      replaceAutomationLink(current, startedSample);
    }
    if (source) {
      followupSource = null;
      replaceAutomationLink(current);
    }
    renderFollowupSource(savedFollowupSource(current));
    if (!item) {
      selectCategory('mine');
      search.value = '';
    }
    closeConfirm({restoreFocus: false});
    fillEditor(form, current, currentUser && currentUser.username);
    renderEditorSchedule();
    form.elements.template_id.disabled = true;
    rememberEditorSettings();
    const heading = document.getElementById('editor-heading');
    if (heading) heading.textContent = current.title;
    document.getElementById('remove-automation').hidden = false;
    runButton.hidden = false;
    if (runHistoryButton) runHistoryButton.hidden = false;
    renderManualRunNote();
    show('ok', startedSample ? '已保存。可在下方查看本次试运行结果。' : sample ? '自动化已保存。点击「运行一次」生成样例。'
      : source && result.status === 200 ? '已打开这条行动项的现有跟进。'
      : current.enabled ? '已保存，自动运行已启用。' : '已保存，自动运行未启用。');
    await loadRuns({focus: Boolean(startedSample)});
  });

  runButton.addEventListener('click', () => {
    if (runButton.disabled) return;
    const target = runScope();
    const submission = runSubmissions.get(target.key);
    if (!submission && editorHasChanges()) {
      openConfirm({
        parent: editorConfirm,
        trigger: runButton,
        prompt: {question: '有未保存的修改。使用已保存的设置运行一次？', confirmLabel: '运行已保存版本'},
        action: () => {
          if (!saveButton.disabled) return submitRun(target);
        },
      });
      return;
    }
    return submitRun(target, submission?.source);
  });

  const removeButton = document.getElementById('remove-automation');

  async function removeAutomation(target) {
    if (!target || !target.workspace || !target.automation) return;
    const result = await request('POST', `/v1/workspaces/${target.workspace}/automations/${target.automation}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    storeRunSubmission(target, null);
    current = null;
    clearEditorLink();
    form.hidden = true;
    watchEditorExit();
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    const runPanel = document.getElementById('run-panel');
    if (runPanel) runPanel.hidden = true;
    stopRunPoll();
    show('ok', '已删除。');
    await loadList();
  }

  removeButton.addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) return;
    // Bind the question to the automation and workspace it names right now.
    const target = runScope();
    openConfirm({
      parent: removeButton.parentNode || form,
      trigger: removeButton,
      prompt: deletePrompt(current),
      action: () => removeAutomation(target),
    });
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    closeConfirm({restoreFocus: false});
    discardFollowupDraft();
    current = null;
    savedRunResults.clear();
    runSubmissions.clear();
    watchedRuns.clear();
    stopRunPoll();
    globalThis.clearTimeout(listTimer);
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
