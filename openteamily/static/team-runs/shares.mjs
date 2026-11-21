const ID = /^[0-9a-f]{32}$/;
const SHARE_ID = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const LABELS = {
  succeeded: '已完成', failed: '未完成', cancelled: '已取消', blocked: '等待前序修复',
  waiting: '等待前序', queued: '等待执行', running: '执行中',
};

export function createTeamRunShares({document, request}) {
  const panel = document.getElementById('team-shared-runs');
  const actions = document.getElementById('share-team-run');
  if (!panel || !actions) return {selectWorkspace() {}, selectRun() {}};
  const initial = new URLSearchParams(document.defaultView?.location?.hash.slice(1));
  let linked = initial.getAll('shared').length === 1 && SHARE_ID.test(initial.get('shared') || '') ? initial.get('shared') : '';
  let scope, run, selection, summaries = [];
  let listRequest = 0;
  let detailRequest = 0;
  let pending = false;
  let hasLoaded = false;
  let denied = false;

  function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  const heading = element('h2', '团队共享');
  const head = element('div', null, 'shared-runs-heading');
  const feedback = element('p', '', 'shared-runs-feedback');
  feedback.setAttribute('role', 'status');
  const list = element('ul', null, 'shared-runs-list');
  const detail = element('article', null, 'shared-run-detail');
  detail.hidden = true;
  const refresh = button('刷新团队共享', () => load());
  head.append(heading, refresh);
  panel.append(head, feedback, list, detail);

  function path(id = '') {
    return '/v1/workspaces/' + scope.id + '/shared-runs' + (id ? '/' + id : '');
  }

  async function send(method, url, body) {
    try { return await request(method, url, body); } catch { return {status: 0}; }
  }

  function renderList() {
    list.replaceChildren();
    for (const share of summaries) {
      if (!SHARE_ID.test(share.id)) continue;
      const row = element('li');
      const open = button(share.title, () => openShare(share.id, true));
      open.dataset.sharedRun = share.id;
      open.setAttribute('aria-expanded', String(selection?.id === share.id));
      row.append(open, element('small', [share.author, LABELS[share.status]].filter(Boolean).join(' · ')));
      list.append(row);
    }
  }

  async function load() {
    if (!scope) return;
    const owner = scope, requestId = ++listRequest;
    refresh.disabled = true;
    feedback.textContent = '正在读取团队共享…';
    const result = await send('GET', path());
    if (owner !== scope || requestId !== listRequest) return;
    refresh.disabled = false;
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      if ([401, 403, 404].includes(result.status)) {
        denied = true;
        detailRequest += 1;
        summaries = [];
        selection = null;
        detail.hidden = true;
        detail.replaceChildren();
        renderList();
        renderActions();
      }
      feedback.textContent = '无法读取团队共享，请重试。';
      return;
    }
    denied = false;
    summaries = result.body.items;
    hasLoaded = true;
    feedback.textContent = summaries.length ? '' : '团队还没有共享的协作结果。';
    renderList();
    renderActions();
    if (selection) await openShare(selection.id);
  }

  function renderDetail(share, focus) {
    const title = element('h3', share.title);
    title.tabIndex = -1;
    const close = button('关闭快照', () => {
      detailRequest += 1;
      selection = null;
      detail.hidden = true;
      detail.replaceChildren();
      renderList();
      list.querySelector('[data-shared-run="' + share.id + '"]')?.focus();
    });
    const toolbar = element('div', null, 'shared-runs-heading');
    toolbar.append(title, close);
    detail.replaceChildren(toolbar, element('p', share.goal, 'shared-run-goal'));
    if (share.own) {
      const revoke = button('撤回团队共享', () => confirm(revoke, '撤回后，团队成员将无法查看这份快照。', '确认撤回',
        () => revokeShare(share.id)));
      toolbar.append(revoke);
    }
    const steps = element('ol', null, 'shared-run-steps');
    for (const step of share.snapshot?.steps ?? []) {
      const row = element('li');
      row.append(element('strong', [step.agent_name, LABELS[step.status]].filter(Boolean).join(' · ')));
      if (step.output) row.append(element('p', step.output));
      steps.append(row);
    }
    detail.append(steps);
    detail.hidden = false;
    if (focus) title.focus();
  }

  async function openShare(id, focus = false) {
    if (!scope || !SHARE_ID.test(id)) return;
    const owner = scope, requestId = ++detailRequest;
    const result = await send('GET', path(id));
    if (owner !== scope || requestId !== detailRequest) return;
    const share = result.body?.share;
    if (result.status !== 200 || share?.id !== id) {
      if (result.status === 404 && selection?.id === id) {
        selection = null;
        detail.hidden = true;
        detail.replaceChildren();
        renderList();
        refresh.focus();
      }
      feedback.textContent = result.status === 404 ? '这份共享快照已不可用。' : '无法打开共享快照，请重试。';
      return;
    }
    selection = share;
    renderList();
    renderDetail(share, focus);
  }

  function confirm(trigger, message, label, action) {
    const box = element('div', null, 'shared-run-confirm');
    const accept = button(label, async () => {
      accept.disabled = true;
      await action();
      box.remove();
      if (trigger.isConnected) {
        trigger.hidden = false;
        trigger.focus();
      } else actions.querySelector('button')?.focus();
    });
    const cancel = button('取消', () => {
      box.remove();
      trigger.hidden = false;
      trigger.focus();
    });
    trigger.hidden = true;
    box.append(element('p', message), accept, cancel);
    trigger.after(box);
    accept.focus();
  }

  function renderActions() {
    const available = scope && !denied && run?.workspace_id === scope.id && TERMINAL.has(run.status);
    const existing = available && summaries.some(share => share.own && share.run_id === run.id);
    const signature = available ? run.id + ':' + existing + ':' + pending : '';
    if (signature === (actions.dataset.runActions ?? '')) return;
    actions.dataset.runActions = signature;
    actions.hidden = !available;
    actions.replaceChildren();
    if (!available) return;
    const id = run.id;
    const share = button(existing ? '更新团队快照' : '共享结果给团队', () =>
      confirm(share, '共享后，团队成员可以查看任务目标、步骤状态和输出摘要。', '确认共享', () => publish(id)));
    share.disabled = pending;
    actions.append(share);
  }

  function report(message) {
    feedback.textContent = message;
    const actionFeedback = element('span', message, 'shared-runs-feedback');
    actionFeedback.setAttribute('role', 'status');
    actions.querySelector('.shared-runs-feedback')?.remove();
    if (!actions.hidden) actions.append(actionFeedback);
  }

  async function publish(id) {
    if (!scope || pending) return;
    const owner = scope;
    pending = true;
    const result = await send('POST', '/v1/workspaces/' + owner.id + '/team-runs/' + id + '/share', {});
    if (owner !== scope) return;
    pending = false;
    if (result.status !== 200 || !SHARE_ID.test(result.body?.share?.id || '')) {
      report('无法共享结果，请重试。');
      return;
    }
    await load();
    if (owner === scope) report('已共享给团队。');
  }

  async function revokeShare(id) {
    if (!scope || pending) return;
    const owner = scope;
    pending = true;
    const result = await send('POST', path(id) + '/revoke', {});
    if (owner !== scope) return;
    pending = false;
    if (result.status !== 200) {
      report('无法撤回共享，请重试。');
      return;
    }
    if (selection?.id === id) {
      detailRequest += 1;
      selection = null;
      detail.hidden = true;
      detail.replaceChildren();
      refresh.focus();
    }
    await load();
    if (owner === scope) report('已撤回团队共享。');
  }

  function selectWorkspace(workspace) {
    const valid = workspace && ID.test(workspace.id) && ['team', 'workspace'].includes(workspace.kind);
    if (valid && scope?.id === workspace.id) return;
    scope = valid ? {...workspace} : null;
    run = null;
    selection = null;
    summaries = [];
    pending = false;
    hasLoaded = false;
    denied = false;
    panel.hidden = !scope;
    detail.hidden = true;
    detail.replaceChildren();
    renderList();
    renderActions();
    if (!scope) return;
    const shared = initial.get('workspace') === scope.id ? linked : '';
    if (shared) linked = '';
    void load().then(() => {
      if (shared && hasLoaded && scope?.id === workspace.id) return openShare(shared, true);
    });
  }

  function selectRun(next) {
    run = next;
    renderActions();
  }

  return {selectWorkspace, selectRun};
}
