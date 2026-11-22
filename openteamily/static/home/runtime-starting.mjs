import {csrfCookie, pendingSignupSession, readChatDrafts, signupDraftScope, waitForRuntime, writeChatDrafts} from './runtime-readiness.mjs';

export function mountRuntimeStarting(document, {
  view = document.defaultView ?? globalThis, fetcher = globalThis.fetch.bind(globalThis),
} = {}) {
  const title = document.getElementById('runtime-title');
  const status = document.getElementById('runtime-status');
  const progress = document.getElementById('runtime-progress');
  const retry = document.getElementById('runtime-retry');
  const draftPanel = document.getElementById('runtime-draft');
  const draft = document.getElementById('runtime-first-message');
  const continueButton = document.getElementById('runtime-continue');
  let checking = false;
  let draftScope, draftOwner, draftHash;
  let composing = false;
  let runtimeReady = false;
  let leaving = false;

  function saveDraft() {
    if (!draftScope || view.location.hash !== draftHash) return true;
    const drafts = readChatDrafts(view, draftOwner);
    const text = draft.value || '';
    if ((drafts.get(draftScope) ?? '') === text) return true;
    if (text) drafts.set(draftScope, text);
    else drafts.delete(draftScope);
    return writeChatDrafts(view, draftOwner, drafts);
  }

  function openChat() {
    if (leaving) return;
    leaving = true;
    if (view.location.pathname === '/runtime-starting') view.location.replace('/chat' + (view.location.hash || ''));
    else view.location.reload();
  }

  function finish() {
    if (!runtimeReady || leaving) return;
    if (composing) {
      status.textContent = '聊天已就绪，完成当前输入后会自动打开。';
      return;
    }
    if (!saveDraft()) {
      status.textContent = '聊天已就绪。浏览器暂时无法保留草稿，请复制文本后继续。';
      continueButton.hidden = false;
      return;
    }
    openChat();
  }

  draft?.addEventListener('compositionstart', () => { composing = true; });
  draft?.addEventListener('compositionend', () => {
    composing = false;
    queueMicrotask(finish);
  });
  draft?.addEventListener('input', () => {
    if (!composing) saveDraft();
    if (runtimeReady) finish();
  });
  continueButton?.addEventListener('click', openChat);

  async function read(path, options = {}) {
    const response = await fetcher(path, {
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(8000),
      ...options, headers: {Accept: 'application/json', ...options.headers},
    });
    const body = await response.json().catch(() => null);
    return {status: response.status, body};
  }

  async function start() {
    if (checking) return;
    checking = true;
    retry.hidden = true;
    if (progress) progress.hidden = false;
    title.textContent = '正在启动你的专属智能体';
    status.textContent = '正在准备你的私人聊天。就绪后会自动继续。';
    const expectedUser = pendingSignupSession(view);
    const csrf = csrfCookie(document.cookie);
    const check = () => waitForRuntime(async () => {
      const reply = await read('/v1/auth/runtime-readiness');
      if (!draftScope && draftPanel && draft && reply.status === 200 && reply.body?.user_id === expectedUser) {
        const scope = signupDraftScope(view, expectedUser);
        if (scope) {
          draftScope = scope;
          draftOwner = expectedUser;
          draftHash = view.location.hash;
          draft.value = readChatDrafts(view, draftOwner).get(scope) ?? '';
          draftPanel.hidden = false;
        }
      }
      return reply;
    }, {expectedUser});
    let state = await check();
    if (state === 'setup') {
      const result = await read('/v1/personal-agent', {method: 'POST', headers: {'X-CSRF-Token': csrf}})
        .catch(() => null);
      if (result?.status === 401) state = 'signed-out';
      else if (result?.status === 200 || result?.status === 201) {
        state = result.body?.personal_agent?.runtime_provisioning?.readiness === 'ready' ? 'ready' : await check();
      } else state = 'unavailable';
    }
    if (state === 'signed-out' || state === 'signup-mismatch') {
      // The login page confirms the same-tab signup and presents its manual login form on a mismatch.
      view.location.replace('/login' + (view.location.hash || ''));
      return;
    }
    if (state === 'ready') {
      runtimeReady = true;
      if (progress) progress.hidden = true;
      finish();
      return;
    }
    title.textContent = '专属智能体暂未就绪';
    status.textContent = state === 'timeout'
      ? '你的专属智能体仍在启动。点击重试即可继续检查。'
      : '暂时无法连接到你的专属智能体。请重试。';
    if (progress) progress.hidden = true;
    retry.hidden = false;
    checking = false;
  }

  retry.addEventListener('click', start);
  return start();
}

if (typeof document !== 'undefined') mountRuntimeStarting(document);
