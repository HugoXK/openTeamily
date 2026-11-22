export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

const signupSessionKey = 'ot-expected-signup-session';
const signupLifetimeMs = 5 * 60 * 1000;
const platformUserId = /^[0-9a-f]{32}$/;
const accountDraftPrefix = 'openteamily.chat-drafts:';
const coldDraftHandoffKey = 'openteamily.cold-chat-draft';
const signupChatPath = /^\/chat#workspace=([a-f0-9]{32})&agent=([a-f0-9]{32})$/;
const messageLimit = 4000;
export const signupSessionError = '账户已创建，但登录会话尚未确认。请使用本实例 HTTPS 地址，允许同源 Cookie，然后尝试登录；不要重复注册。';
const validSignupUser = id => typeof id === 'string' && platformUserId.test(id);

export function rememberSignupSession(view, id, now = Date.now(), chat = '') {
  if (!validSignupUser(id)) return false;
  try {
    if (!view?.sessionStorage) return false;
    view.sessionStorage.setItem(signupSessionKey, JSON.stringify({
      id, expires: now + signupLifetimeMs, ...(signupChatPath.test(chat) ? {chat} : {}),
    }));
    return true;
  } catch {
    return false;
  }
}

function signupSession(view, now, consume = false) {
  try {
    const stored = view?.sessionStorage?.getItem(signupSessionKey);
    if (!stored) return null;
    if (consume) view.sessionStorage.removeItem(signupSessionKey);
    const value = JSON.parse(stored);
    const {id, expires} = value;
    return validSignupUser(id)
      && Number.isFinite(expires) && expires > now && expires <= now + signupLifetimeMs ? value : null;
  } catch {
    return null;
  }
}

export function pendingSignupSession(view, now = Date.now(), {consume = false} = {}) {
  return signupSession(view, now, consume)?.id ?? null;
}

export function signupDraftScope(view, owner, now = Date.now()) {
  const session = signupSession(view, now);
  if (!owner || session?.id !== owner || session.chat !== '/chat' + view.location.hash) return null;
  const target = signupChatPath.exec(session.chat);
  return target ? JSON.stringify([owner, target[1], 'agent', target[2], null]) : null;
}

export function personalDraftScope(view, owner, personal) {
  if (!validSignupUser(owner) || view.location.search) return null;
  const target = signupChatPath.exec('/chat' + view.location.hash);
  if (!target || target[1] !== personal?.workspace_id || target[2] !== personal.agent_id) return null;
  return JSON.stringify([owner, target[1], 'agent', target[2], null]);
}

export function rememberColdDraftHandoff(view, scope) {
  try {
    const storage = view?.sessionStorage;
    if (!storage) return false;
    storage.setItem(coldDraftHandoffKey, scope);
    return true;
  } catch { return false; }
}

export function takeColdDraftHandoff(view, scope) {
  try {
    const storage = view?.sessionStorage;
    if (!scope || storage?.getItem(coldDraftHandoffKey) !== scope) return null;
    storage.removeItem(coldDraftHandoffKey);
    return scope;
  } catch { return null; }
}

export function chatDraftOwner(scope) {
  try {
    const [owner, workspace, kind, agent, conversation] = JSON.parse(scope);
    if (typeof owner !== 'string' || !owner || typeof workspace !== 'string' || !workspace) return null;
    if (kind === 'agent' && typeof agent === 'string' && agent) return owner;
    if (kind === 'social' && typeof conversation === 'string' && conversation) return owner;
  } catch {}
  return null;
}

export function readChatDrafts(view, owner) {
  const drafts = new Map();
  try {
    const stored = JSON.parse(view?.sessionStorage?.getItem(accountDraftPrefix + owner) || '{}');
    for (const [scope, value] of Object.entries(stored || {})) {
      if (chatDraftOwner(scope) === owner && typeof value === 'string' && value.length > 0 && value.length <= messageLimit) drafts.set(scope, value);
    }
  } catch {}
  return drafts;
}

export function writeChatDrafts(view, owner, drafts) {
  try {
    const storage = view?.sessionStorage;
    if (!storage) return false;
    const name = accountDraftPrefix + owner;
    if (drafts.size) storage.setItem(name, JSON.stringify(Object.fromEntries(drafts)));
    else storage.removeItem(name);
    return true;
  } catch { return false; }
}

export function takeSignupSession(view, now = Date.now()) {
  return pendingSignupSession(view, now, {consume: true});
}

export function confirmSignupSession(view, response) {
  const expected = pendingSignupSession(view);
  if (!expected) return true;
  const actual = response.body?.user?.id;
  const definitive = response.status === 200 && validSignupUser(actual);
  if (definitive || response.status === 401) takeSignupSession(view);
  return definitive && actual === expected;
}

export async function waitForRuntime(read, {
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 73, expectedUser,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(attempt <= 10 ? 300 : attempt <= 37 ? 1000 : 3000);
    const reply = await read().catch(() => null);
    if (reply?.status === 401) return 'signed-out';
    if (reply?.status !== 200) continue;
    const {state, user_id: user} = reply.body || {};
    if (expectedUser) {
      if (!validSignupUser(user)) continue;
      if (user !== expectedUser) return 'signup-mismatch';
    }
    if (['ready', 'unmanaged', 'unavailable', 'setup', 'stopped'].includes(state)) return state;
  }
  return 'timeout';
}
