import {PUBLIC_AGENT_MESSAGE_LIMIT} from '../shell/public-agent-link.mjs';

const textOf = value => typeof value === 'string' && value.length <= PUBLIC_AGENT_MESSAGE_LIMIT ? value : '';

function draftOwner(scope) {
  try {
    const [owner, workspace, kind, agent, conversation] = JSON.parse(scope);
    if (typeof owner !== 'string' || !owner || typeof workspace !== 'string' || !workspace) return null;
    if (kind === 'agent' && typeof agent === 'string' && agent) return owner;
    if (kind === 'social' && typeof conversation === 'string' && conversation) return owner;
  } catch {}
  return null;
}

export function mountPublicDraft(document, {onChange = () => {}} = {}) {
  const input = document.getElementById('chat-body');
  const recovery = document.getElementById('public-draft-recovery');
  const recoveryText = document.getElementById('public-draft-recovery-text');
  const memory = new Map();
  const recovered = new Map();
  const accountDrafts = new Map();
  const dirtyAccounts = new Set();
  let active = null;
  let writeTimer;
  const prefix = 'openteamily.public-agent-draft:';
  const recoveryPrefix = 'openteamily.public-agent-draft-recovery:';
  const accountPrefix = 'openteamily.chat-drafts:';

  function read(scope, keyPrefix) {
    try { return document.defaultView?.sessionStorage?.getItem(keyPrefix + scope); } catch {}
  }

  function save(scope, keyPrefix, text) {
    try {
      const storage = document.defaultView?.sessionStorage;
      if (text) storage?.setItem(keyPrefix + scope, text);
      else storage?.removeItem(keyPrefix + scope);
    } catch {}
  }

  function showRecovery(text) {
    recovery.hidden = !text;
    recovery.open = false;
    recoveryText.value = text || '';
  }

  function draftsOf(owner) {
    if (!accountDrafts.has(owner)) {
      const drafts = new Map();
      try {
        const stored = JSON.parse(read(owner, accountPrefix) || '{}');
        for (const [scope, value] of Object.entries(stored || {})) {
          if (draftOwner(scope) === owner && textOf(value)) drafts.set(scope, value);
        }
      } catch {}
      accountDrafts.set(owner, drafts);
    }
    return accountDrafts.get(owner);
  }

  function flush() {
    globalThis.clearTimeout(writeTimer);
    writeTimer = undefined;
    for (const owner of dirtyAccounts) {
      const drafts = draftsOf(owner);
      save(owner, accountPrefix, drafts.size ? JSON.stringify(Object.fromEntries(drafts)) : '');
    }
    dirtyAccounts.clear();
  }

  function lookup(scope, publicChat = false) {
    if (publicChat) return memory.get(scope) ?? textOf(read(scope, prefix));
    const owner = draftOwner(scope);
    return (owner ? draftsOf(owner).get(scope) : memory.get(scope)) || '';
  }

  function update(scope, publicChat, text) {
    const previous = lookup(scope, publicChat);
    if (previous === text) return;
    const owner = publicChat ? null : draftOwner(scope);
    const drafts = owner ? draftsOf(owner) : memory;
    if (text) drafts.set(scope, text);
    else drafts.delete(scope);
    if (publicChat) save(scope, prefix, text);
    if (owner) {
      dirtyAccounts.add(owner);
      writeTimer ??= globalThis.setTimeout(flush, 200);
    }
    onChange(scope, text, previous);
  }

  function persist({now = true} = {}) {
    if (active) update(active.scope, active.publicChat, input.value || '');
    if (now) flush();
  }

  input.addEventListener('input', () => persist({now: false}));
  document.defaultView?.addEventListener?.('pagehide', () => persist());
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
  document.getElementById('public-draft-recovery-clear').addEventListener('click', () => {
    if (!active?.publicChat) return;
    recovered.set(active.scope, '');
    save(active.scope, recoveryPrefix, '');
    showRecovery('');
    input.focus({preventScroll: true});
  });
  return {
    enter(scope, publicChat = false) {
      if (active?.scope === scope && active.publicChat === publicChat) return;
      if (active) persist({now: false});
      const initialText = active ? '' : (input.value || '');
      active = {scope, publicChat};
      input.value = textOf(lookup(scope, publicChat)) || (publicChat ? '' : initialText);
      showRecovery(publicChat ? recovered.get(scope) ?? read(scope, recoveryPrefix) : '');
    },
    move(fromScope, toScope) {
      if (fromScope === toScope || draftOwner(fromScope) !== draftOwner(toScope)) return;
      if (active?.scope === fromScope) {
        if (active.publicChat) return;
        const text = input.value || '';
        active.scope = toScope;
        update(fromScope, false, '');
        update(toScope, false, text);
      } else {
        const text = lookup(fromScope);
        if (!text || lookup(toScope) || (active?.scope === toScope && input.value)) return;
        update(toScope, false, text);
        update(fromScope, false, '');
        if (active?.scope === toScope) input.value = text;
      }
      flush();
    },
    lookup,
    forget(scope) {
      if (active?.scope === scope) input.value = '';
      update(scope, active?.scope === scope && active.publicChat, '');
      flush();
    },
    fill(text) {
      if (!active?.publicChat || input.disabled) return false;
      if (!input.value) {
        input.value = text;
        persist();
      }
      input.focus({preventScroll: true});
      return true;
    },
    fillOpening(text) {
      if (!active?.publicChat || input.disabled) return '';
      const existing = input.value;
      const combined = existing && existing !== text ? existing + '\n\n' + text : text;
      if (combined.length <= PUBLIC_AGENT_MESSAGE_LIMIT) {
        input.value = combined;
        persist();
        input.focus({preventScroll: true});
        return 'filled';
      }
      const previous = recovered.get(active.scope) ?? read(active.scope, recoveryPrefix);
      const backup = previous ? previous + '\n\n' + text : text;
      recovered.set(active.scope, backup);
      save(active.scope, recoveryPrefix, backup);
      showRecovery(backup);
      document.getElementById('public-draft-recovery-summary').focus({preventScroll: true});
      return 'saved';
    },
    persist,
    clear() {
      if (active) persist();
      active = null;
      memory.clear();
      recovered.clear();
      accountDrafts.clear();
      input.value = '';
      showRecovery('');
    },
  };
}
