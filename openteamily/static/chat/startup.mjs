export function chatStartFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  return Object.fromEntries(['workspace', 'agent', 'conversation', 'message', 'social']
    .map(key => [key, params.get(key) || '']));
}

export function startChatReads(read, start, allowLocal) {
  const sessionRequest = read('/v1/auth/session');
  const params = new URLSearchParams({scope: 'personal', include: 'chat'});
  if (start.workspace) params.set('workspace', start.workspace);
  const id = /^[a-f0-9]{32}$/;
  if (!start.social && id.test(start.workspace) && id.test(start.agent) && (!start.conversation || id.test(start.conversation))) {
    params.set('entry_agent', start.agent);
    if (start.conversation) {
      params.set('entry_conversation', start.conversation);
      params.set('directory', '0');
    }
  }
  const localRequest = allowLocal ? read('/v1/workspaces?' + params, AbortSignal.timeout(2200)) : null;
  return {sessionRequest, localRequest};
}

let early;
const view = typeof window === 'undefined' ? null : window;
if (view?.document.querySelector('meta[name="openteamily-instance"]')) {
  const {href, hash} = view.location;
  // These two GETs are already routed by the gateway. Starting them directly
  // lets the account check and private snapshot overlap the rest of Chat's modules.
  const read = async (path, signal) => {
    try {
      const response = await view.fetch(path, {credentials: 'same-origin', headers: {Accept: 'application/json'}, signal});
      return {status: response.status, body: await response.json().catch(() => ({}))};
    } catch {
      return {status: 0, body: {}};
    }
  };
  const openingPublicAgent = new URLSearchParams(hash.replace(/^#/, '')).has('public-agent');
  early = {document: view.document, href, ...startChatReads(read, chatStartFromHash(hash), !openingPublicAgent)};
}

export function takeChatReads(document) {
  const requests = early;
  early = null;
  return requests && requests.document === document && requests.href === document.defaultView?.location.href ? requests : null;
}
