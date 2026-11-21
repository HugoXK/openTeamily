import {csrfCookie, pendingSignupSession, waitForRuntime} from './runtime-readiness.mjs';

export function mountRuntimeStarting(document, {
  view = document.defaultView ?? globalThis, fetcher = globalThis.fetch.bind(globalThis),
} = {}) {
  const title = document.getElementById('runtime-title');
  const status = document.getElementById('runtime-status');
  const progress = document.getElementById('runtime-progress');
  const retry = document.getElementById('runtime-retry');
  let checking = false;

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
    const check = () => waitForRuntime(() => read('/v1/auth/runtime-readiness'), {expectedUser});
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
      if (view.location.pathname === '/runtime-starting') view.location.replace('/chat' + (view.location.hash || ''));
      else view.location.reload();
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
