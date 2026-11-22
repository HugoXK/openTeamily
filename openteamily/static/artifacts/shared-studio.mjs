import {studioDocumentHref} from '../shell/studio-link.mjs';
import {mountStudioHistory} from './studio-history.mjs';
import {mountStudioDiscussion} from './studio-discussion.mjs';

const ID = /^[a-f0-9]{32}$/;
const ROLES = new Set(['owner', 'admin', 'member']);
const UPDATE_INTERVAL = 4000;

export function mountSharedStudio(document, {request, onClose}) {
  const get = id => document.getElementById('studio-' + id);
  const button = get('open');
  const dialog = get('dialog');
  if (!button || typeof dialog?.showModal !== 'function') return null;

  const catalog = get('catalog');
  const list = get('list');
  const form = get('form');
  const titleInput = get('title');
  const bodyInput = get('body');
  const compare = get('compare');
  const save = get('save');
  const remove = get('delete');
  const closeButton = get('close');
  const add = get('add');
  const copyLink = get('copy-link');
  const discuss = get('discuss');
  const linkWrap = get('link-wrap');
  const view = document.defaultView;
  let scope = null;
  let screen;
  let poll;

  function show(text = '', kind = '') {
    const status = get('status');
    status.textContent = text;
    status.dataset.kind = kind;
  }

  const clearPoll = () => view.clearTimeout(poll);
  const documentPath = (state, id = state.base?.id) => state.path + (id ? '/' + id : '');
  const isCurrent = state => dialog.open && screen === state;
  const content = () => ({title: titleInput.value.trim(), body: bodyInput.value});
  const sameContent = (left, right) => left.title === right.title && left.body === right.body;
  const isDirty = state => !form.hidden && (state?.base
    ? !sameContent(content(), state.base)
    : Boolean(titleInput.value.trim() || bodyInput.value));
  const canDiscuss = state => state?.base && !state.busy && !state.remote && !state.blocked &&
    !state.unavailable && !isDirty(state);
  const discussion = mountStudioDiscussion(document, {
    request,
    source: () => dialog.open && scope && canDiscuss(screen)
      ? {owner:scope.account, workspace:scope.id, document:screen.base} : null,
    openChat: path => view.location.assign(path),
  });
  discuss?.addEventListener('click', () => discussion?.open());

  function send(method, path, body, signal) {
    const timeout = AbortSignal.timeout(12000);
    return request(method, path, body, {signal: signal ? AbortSignal.any([signal, timeout]) : timeout})
      .catch(() => ({status: 0, body: {}}));
  }

  const history = mountStudioHistory(document, {
    context: () => screen?.base && isCurrent(screen) ? {
      path:documentPath(screen), revision:screen.base.revision, dirty:isDirty(screen),
      busy:screen.busy, blocked:screen.blocked || Boolean(screen.remote), unavailable:screen.unavailable,
    } : null,
    send,
    async restoreVersion(path, revision, to) {
      const state = screen;
      if (!state?.base || !isCurrent(state) || state.busy || state.blocked || state.remote ||
          state.unavailable || isDirty(state) || state.base.revision !== revision || documentPath(state) !== path) {
        return 'conflict';
      }
      state.busy = true;
      clearPoll();
      controls(state);
      const result = await send('POST', path + '/restore', {revision,to}, state.controller.signal);
      if (!isCurrent(state)) return '';
      state.busy = false;
      const item = responseDocument(result, state.base.id);
      if (item) {
        showForm(state, item);
        show('已恢复为版本 ' + item.revision + '。', 'success');
        queueUpdate(state);
        return 'restored';
      }
      const conflict = result.status === 409;
      if (conflict) state.blocked = true;
      controls(state);
      void checkUpdates(state, true);
      return conflict ? 'conflict' : '';
    },
  });

  function controls(state) {
    const {base, busy, remote, blocked, unavailable} = state;
    closeButton.disabled = busy;
    add.disabled = busy;
    titleInput.readOnly = bodyInput.readOnly = busy;
    save.disabled = busy || Boolean(remote || blocked || unavailable) || !titleInput.value.trim() || !isDirty(state);
    remove.hidden = !base?.can_delete || unavailable;
    remove.disabled = busy || Boolean(remote || blocked);
    copyLink.hidden = !base || unavailable;
    if (discuss) {
      discuss.hidden = !base || unavailable;
      discuss.disabled = !canDiscuss(state);
    }
    get('conflict').hidden = !remote;
    get('use-server').disabled = get('rebase').disabled = busy || unavailable;
    get('revision').textContent = base
      ? '版本 ' + base.revision + (base.updated_by ? ' · ' + base.updated_by : '')
      : '保存后，此工作区成员可一起编辑。';
    history.sync();
  }

  function stopScreen() {
    discussion?.close();
    history.dismiss();
    clearPoll();
    screen?.controller.abort();
    screen = null;
    titleInput.value = bodyInput.value = get('link').value = '';
    get('server-title').textContent = get('server-body').textContent = '';
    list.replaceChildren();
  }

  function newScreen(mode) {
    stopScreen();
    screen = {
      path: '/v1/workspaces/' + scope.id + '/studio/documents',
      mode, controller: new AbortController(),
      base: null, remote: null, attempt: null, busy: false, blocked: false, unavailable: false,
    };
    catalog.hidden = mode !== 'catalog';
    form.hidden = true;
    linkWrap.hidden = true;
    list.replaceChildren();
    compare.open = false;
    get('heading').textContent = mode === 'catalog' ? '团队协作' : mode === 'new' ? '新建团队文档' : '团队文档';
    show();
    controls(screen);
    return screen;
  }

  function mayLeave() {
    if (screen?.busy) return false;
    return !isDirty(screen) || view.confirm('要放弃团队文档中未保存的修改吗？');
  }

  function showForm(state, item, fields = item) {
    state.base = item;
    state.remote = null;
    state.blocked = false;
    state.unavailable = false;
    titleInput.value = fields?.title || '';
    bodyInput.value = fields?.body || '';
    get('link').value = item ? new URL(studioDocumentHref(scope.id, item.id), view.location.origin).href : '';
    form.hidden = false;
    compare.open = false;
    controls(state);
  }

  function responseDocument(result, id) {
    const item = result.body?.document;
    return (result.status === 200 || result.status === 201) && ID.test(item?.id || '')
      && (!id || item.id === id) && typeof item.title === 'string' && typeof item.body === 'string'
      && Number.isSafeInteger(item.revision) && item.revision >= 1 ? item : null;
  }

  function unavailable(state) {
    state.unavailable = true;
    clearPoll();
    controls(state);
    show('已无法读取此文档。你仍可以复制当前内容。', 'error');
  }

  function applyRemote(state, latest) {
    if (latest.revision < state.base.revision) return;
    if (latest.revision === state.base.revision) {
      state.base = latest;
      controls(state);
      return;
    }
    if (!isDirty(state) || sameContent(content(), latest)) {
      showForm(state, latest);
      show('已同步团队文档。', 'success');
      return;
    }
    state.remote = latest;
    get('server-title').textContent = '版本 ' + latest.revision + ' · ' + latest.title;
    get('server-body').textContent = latest.body;
    controls(state);
    show();
  }

  function queueUpdate(state) {
    clearPoll();
    if (isCurrent(state) && state.base && !state.unavailable && document.visibilityState !== 'hidden') {
      poll = view.setTimeout(() => void checkUpdates(state), UPDATE_INTERVAL);
    }
  }

  async function checkUpdates(state, force = false) {
    if (!isCurrent(state) || !state.base || state.busy || state.polling || state.unavailable) return;
    state.polling = true;
    const known = state.remote?.revision || state.base.revision;
    const result = await send('GET', documentPath(state) + (force || state.blocked ? '' : '?revision=' + known),
      undefined, state.controller.signal);
    state.polling = false;
    if (!isCurrent(state) || state.unavailable) return;
    if (!state.busy) {
      const latest = responseDocument(result, state.base.id);
      if (latest) applyRemote(state, latest);
      else if (result.status === 401 || result.status === 403 || result.status === 404) {
        unavailable(state);
        return;
      }
    }
    queueUpdate(state);
  }

  async function openDocument(id) {
    if (!ID.test(id || '')) return;
    const state = newScreen('edit');
    show('正在打开团队文档…');
    const result = await send('GET', documentPath(state, id), undefined, state.controller.signal);
    if (!isCurrent(state)) return;
    const item = responseDocument(result, id);
    if (!item) {
      const failure = result.status === 403 || result.status === 404
        ? '团队文档不存在，或你没有访问权限。' : '暂时无法打开团队文档。';
      await loadCatalog(failure);
      return;
    }
    show();
    showForm(state, item);
    queueUpdate(state);
    get('back').focus();
  }

  async function loadCatalog(failure = '') {
    const state = newScreen('catalog');
    const refresh = get('refresh');
    refresh.disabled = true;
    show('正在读取团队文档…');
    const result = await send('GET', state.path, undefined, state.controller.signal);
    if (!isCurrent(state)) return;
    refresh.disabled = false;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      show(result.status === 403 || result.status === 404
        ? '你已无法访问此工作区的团队文档。' : '暂时无法读取团队文档，请刷新列表。', 'error');
      add.disabled = true;
      return;
    }
    show(failure || (result.body.items.length ? '' : '还没有团队文档。'), failure ? 'error' : '');
    for (const item of result.body.items) {
      if (!ID.test(item?.id || '') || typeof item.title !== 'string') continue;
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.className = 'secondary';
      open.type = 'button';
      open.textContent = item.title;
      open.addEventListener('click', () => void openDocument(item.id));
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = '版本 ' + item.revision + (item.updated_by ? ' · ' + item.updated_by : '');
      row.append(open, meta);
      list.append(row);
    }
  }

  async function open(id) {
    if (!scope || dialog.open) return false;
    get('workspace-name').textContent = scope.name;
    dialog.showModal();
    closeButton.focus();
    if (id) await openDocument(id);
    else await loadCatalog();
    return true;
  }

  function close() {
    if (!mayLeave()) return;
    stopScreen();
    dialog.close();
    onClose?.();
    if (!button.hidden) button.focus();
  }

  button.addEventListener('click', () => void open());
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  get('back').addEventListener('click', () => {
    if (!mayLeave()) return;
    void loadCatalog();
    add.focus();
  });
  add.addEventListener('click', () => {
    const state = newScreen('new');
    showForm(state, null);
    titleInput.focus();
  });
  get('refresh').addEventListener('click', () => void loadCatalog());
  form.addEventListener('input', () => {
    if (screen) controls(screen);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = screen;
    if (!isCurrent(state) || save.disabled) return;
    const draft = content();
    const creating = !state.base;
    const payload = creating ? (state.attempt ??= {...draft, client_key: view.crypto.randomUUID()})
      : {...draft, revision: state.base.revision};
    state.busy = true;
    clearPoll();
    controls(state);
    show('正在保存…');
    const result = await send('POST', documentPath(state), payload, state.controller.signal);
    if (!isCurrent(state)) return;
    state.busy = false;
    const item = responseDocument(result, state.base?.id);
    if (item) {
      const retainedDraft = creating && !sameContent(draft, payload);
      showForm(state, item, retainedDraft ? draft : item);
      get('heading').textContent = '团队文档';
      show(retainedDraft ? '文档已创建，后续修改仍待保存。' : '已保存。', 'success');
    } else if (result.status === 409 && !creating && result.body?.error?.code === 'revision_conflict') {
      state.blocked = true;
      show('服务器有新版本。正在读取更新…', 'error');
      void checkUpdates(state, true);
    } else if (!creating && [401, 403, 404].includes(result.status)) {
      unavailable(state);
    } else {
      if (creating && [400, 401, 403, 404, 422].includes(result.status)) state.attempt = null;
      const error = result.body?.error?.code;
      show(error === 'document_deleted' ? '之前创建的团队文档已被删除。请返回列表重新新建。'
        : error === 'idempotency_conflict' ? '无法确认文档是否已经创建。请返回列表查看。'
        : '暂时无法确认保存，当前草稿仍保留。请重试。', 'error');
    }
    controls(state);
    queueUpdate(state);
  });

  get('use-server').addEventListener('click', () => {
    const state = screen;
    if (!state?.remote || state.busy || !view.confirm('要放弃当前草稿并采用服务器版本吗？')) return;
    showForm(state, state.remote);
    show('已采用服务器版本。', 'success');
    titleInput.focus();
  });
  get('rebase').addEventListener('click', () => {
    const state = screen;
    if (!state?.remote || state.busy) return;
    showForm(state, state.remote, content());
    show('已保留草稿。再次保存会替换刚查看的服务器版本。');
    titleInput.focus();
  });

  remove.addEventListener('click', async () => {
    const state = screen;
    if (!state?.base?.can_delete || state.busy || state.remote || state.blocked || state.unavailable ||
        !view.confirm('要删除此团队文档吗？此操作会影响所有团队成员。')) return;
    state.busy = true;
    clearPoll();
    controls(state);
    const result = await send('POST', documentPath(state) + '/remove',
      {revision: state.base.revision}, state.controller.signal);
    if (!isCurrent(state)) return;
    state.busy = false;
    if (result.status === 200 || result.status === 204) {
      await loadCatalog();
      return;
    }
    if (result.status === 409 && result.body?.error?.code === 'revision_conflict') {
      state.blocked = true;
      show('服务器有新版本。正在读取更新…', 'error');
      void checkUpdates(state, true);
    } else if ([401, 403, 404].includes(result.status)) {
      show('无法删除此文档。正在检查当前权限…', 'error');
      await checkUpdates(state, true);
      if (!isCurrent(state)) return;
      if (!state.unavailable) show('无法删除此文档，请检查权限。', 'error');
    } else show('暂时无法确认删除，请检查团队文档。', 'error');
    controls(state);
    queueUpdate(state);
  });

  copyLink.addEventListener('click', async () => {
    const state = screen;
    if (!state?.base || !scope) return;
    const input = get('link');
    try {
      await view.navigator.clipboard.writeText(input.value);
      if (isCurrent(state)) show('已复制文档链接。', 'success');
    } catch {
      if (!isCurrent(state)) return;
      linkWrap.hidden = false;
      input.select();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearPoll();
    else if (screen?.base) void checkUpdates(screen);
  });
  view.addEventListener('beforeunload', event => {
    if (!dialog.open || (!screen?.busy && !isDirty(screen))) return;
    event.preventDefault();
    event.returnValue = '';
  });

  return {
    setWorkspace(team, account) {
      const next = account && ID.test(team?.id || '') && team.kind === 'team' &&
        ROLES.has(team.role) ? {id: team.id, name: team.name, account} : null;
      if (dialog.open && (next?.id !== scope?.id || next?.account !== scope?.account)) {
        stopScreen();
        dialog.close();
        onClose?.();
      }
      scope = next;
      button.hidden = !scope;
    },
    open,
  };
}
