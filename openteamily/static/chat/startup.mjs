import '../shell/dsbot-api.mjs';
import { publicAgentIntentFromHash } from '../shell/public-agent-link.mjs';
import { dsbotServed } from './dsbot.mjs';

export function startChatReads(read, workspace, allowLocal) {
  const sessionRequest = read('/v1/auth/session');
  const localRequest = allowLocal ? read('/v1/workspaces?scope=personal&include=chat'
    + (workspace ? '&workspace=' + encodeURIComponent(workspace) : ''), AbortSignal.timeout(2200)) : null;
  return {sessionRequest, localRequest};
}

let early;
const view = typeof window === 'undefined' ? null : window;
if (view && dsbotServed(view.document)) {
  const {href, hash} = view.location;
  const workspace = new URLSearchParams(hash.slice(1)).get('workspace');
  const read = async (path, signal) => {
    try {
      const response = await view.fetch(path, {credentials: 'same-origin', headers: {Accept: 'application/json'}, signal});
      return {status: response.status, body: await response.json().catch(() => ({}))};
    } catch {
      return {status: 0, body: {}};
    }
  };
  early = {document: view.document, href, ...startChatReads(read, workspace, !publicAgentIntentFromHash(hash))};
}

export function takeChatReads(document) {
  const requests = early;
  early = null;
  return requests && requests.document === document && requests.href === document.defaultView?.location.href ? requests : null;
}
