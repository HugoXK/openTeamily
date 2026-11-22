import {readChatDraftMentions, writeChatDraftMentions} from '../home/runtime-readiness.mjs';

const MAX_MENTIONS = 20;
const mentionsLimit = room => room?.direct ? 5 : MAX_MENTIONS;
const agentKey = agent => JSON.stringify([agent.owner_id, agent.id]);
const availableAgent = agent => Boolean(agent?.name && agent.owner_id && agent.id && !agent.archived);

export function activeMentionQuery(text, caret) {
  const match = /(?:^|[\s(（、，。])@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  return match ? {start: caret - match[1].length - 1, query: match[1]} : null;
}

export function mountAgentMentions(doc, context) {
  const input = doc.getElementById('chat-body');
  const list = doc.getElementById('chat-agent-mention-options');
  const chips = doc.getElementById('chat-agent-mentions');
  const staleStatus = doc.getElementById('chat-agent-mention-status');
  if (!input || !list || !chips) return {
    refresh() {}, clear() {}, forget() {}, openPicker() {}, canPick: () => false, keydown: () => false,
    restoreDirect: () => false, prepareDirectLink: () => false, message: body => ({body}),
  };
  const pickerNode = id => doc.getElementById(`chat-agent-picker-${id}`);
  const launcher = pickerNode('open');
  const picker = doc.getElementById('chat-agent-picker');
  const results = pickerNode('results');
  const queryField = pickerNode('search');
  const applyButton = pickerNode('confirm');
  const selectedLabel = pickerNode('count');
  const text = (zh, en) => doc.documentElement?.lang?.startsWith('en') ? en : zh;

  let scope = null;
  let roster;
  let available = new Map();
  let options = [];
  let active = 0;
  const selected = new Map();
  const savedSelections = new Map();
  let picking = null;

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    options = [];
  }

  function renderSelected({preserveFocus = false} = {}) {
    const focusedKey = preserveFocus && doc.activeElement?.dataset?.agentMentionKey;
    let stale = false;
    let nextFocus;
    chips.replaceChildren(...Array.from(selected, ([key]) => {
      const agent = available.get(key);
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.agentMentionKey = key;
      if (key === focusedKey) nextFocus = button;
      if (agent) {
        const label = agent.owner_name ? `${agent.name} · ${agent.owner_name}` : agent.name;
        button.textContent = `@${label} ×`;
        button.setAttribute('aria-label', text(`移除对 ${agent.name}${agent.owner_name ? `（${agent.owner_name}）` : ''} 的提及`,
          `Remove mention of ${agent.name}${agent.owner_name ? ` (${agent.owner_name})` : ''}`));
      } else {
        stale = true;
        button.textContent = text('智能体已不可用 ×', 'Agent unavailable ×');
        button.setAttribute('aria-label', text('移除不可用的智能体', 'Remove unavailable agent'));
      }
      button.addEventListener('click', () => {
        selected.delete(key);
        remember();
        renderSelected();
        input.focus();
      });
      return button;
    }));
    chips.hidden = selected.size === 0;
    if (staleStatus) staleStatus.hidden = !stale;
    if (stale) input.setAttribute('aria-describedby', 'chat-agent-mention-status');
    else input.removeAttribute('aria-describedby');
    nextFocus?.focus({preventScroll: true});
  }

  function remember() {
    if (!scope) return;
    const targets = [...selected.values()];
    if (targets.length) savedSelections.set(scope, targets);
    else savedSelections.delete(scope);
    writeChatDraftMentions(doc.defaultView, scope, targets);
  }

  function restoreTargets(targets) {
    for (const target of targets) selected.set(agentKey({owner_id: target.owner_id, id: target.agent_id}), target);
  }

  function refresh() {
    const group = context();
    const changedScope = scope !== group?.scope;
    if (changedScope) {
      scope = group?.scope;
      selected.clear();
      if (scope) {
        const targets = savedSelections.get(scope) || readChatDraftMentions(doc.defaultView, scope);
        restoreTargets(targets);
      }
      close();
      if (picker?.open) picker.close();
      list.setAttribute('aria-label', group?.direct ? text('提及私聊智能体', 'Mention chat agents')
        : text('提及群智能体', 'Mention group agents'));
      const searchLabel = pickerNode('search-label');
      if (searchLabel) searchLabel.textContent = group?.direct ? text('搜索私聊智能体', 'Search chat agents')
        : text('搜索群智能体', 'Search group agents');
    }
    if (changedScope || roster !== group?.agents) {
      roster = group?.agents;
      available = new Map((roster || []).filter(availableAgent).map(agent => [agentKey(agent), agent]));
      renderSelected({preserveFocus: !changedScope});
    }
    if (launcher) launcher.hidden = available.size === 0;
    return group;
  }

  function choose(agent) {
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!query || !available.has(agentKey(agent)) || selected.size >= mentionsLimit(group)) {
      close();
      return;
    }
    const end = input.selectionStart;
    input.value = input.value.slice(0, query.start) + input.value.slice(end);
    input.setSelectionRange(query.start, query.start);
    selected.set(agentKey(agent), {owner_id: agent.owner_id, agent_id: agent.id});
    remember();
    renderSelected();
    close();
    input.dispatchEvent?.(new Event('input', {bubbles: true}));
    input.focus();
  }

  function highlight() {
    Array.from(list.children).forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
    input.setAttribute('aria-activedescendant', list.children[active].id);
  }

  function suggest(event) {
    if (event?.isComposing) return;
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!group || !query || selected.size >= mentionsLimit(group)) { close(); return; }
    const needle = query.query.toLowerCase();
    options = group.agents.filter(agent => availableAgent(agent) && !selected.has(agentKey(agent))
      && agent.name.toLowerCase().includes(needle)).slice(0, 8);
    if (!options.length) { close(); return; }
    active = 0;
    list.replaceChildren(...options.map((agent, index) => {
      const option = doc.createElement('button');
      option.type = 'button';
      option.id = `chat-agent-mention-option-${index}`;
      option.setAttribute('role', 'option');
      option.textContent = agent.owner_name ? `${agent.name} · ${agent.owner_name}` : agent.name;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(agent));
      return option;
    }));
    list.hidden = false;
    highlight();
  }

  input.addEventListener('input', suggest);
  input.addEventListener('compositionend', suggest);
  input.addEventListener('blur', close);

  function setPickerCount() {
    const size = picking.choices.size;
    selectedLabel.textContent = picking.direct ? text(`已选 ${size} / ${picking.limit}`, `${size} of ${picking.limit} selected`)
      : text(`已选 ${size}`, `${size} selected`);
    applyButton.disabled = Boolean(picking.reply && !size);
    for (const box of results.querySelectorAll('input')) box.disabled = !box.checked && size >= picking.limit;
  }

  function renderPicker() {
    const view = picking;
    const filter = queryField.value.trim().toLocaleLowerCase();
    const people = [...view.roster].filter(([, agent]) => `${agent.name} ${agent.owner_name || ''}`.toLocaleLowerCase().includes(filter));
    results.replaceChildren(...people.map(([key, agent]) => {
      const label = doc.createElement('label');
      label.className = 'chat-agent-picker-choice';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = view.choices.has(key);
      const name = doc.createElement('span');
      name.textContent = agent.name;
      if (agent.owner_name) {
        const owner = doc.createElement('small');
        owner.textContent = agent.owner_name;
        name.append(owner);
      }
      label.append(box, name);
      box.addEventListener('change', () => {
        if (view !== picking || !picker.open) return;
        if (box.checked) view.choices.add(key);
        else view.choices.delete(key);
        setPickerCount();
      });
      return label;
    }));
    pickerNode('empty').hidden = people.length > 0;
    setPickerCount();
  }

  function openPicker({reply, onApply} = {}) {
    const group = refresh();
    if (!picker || picker.open || !group || input.disabled) return false;
    const roster = new Map(group.agents.filter(availableAgent).map(agent => [agentKey(agent), agent]));
    if (!roster.size) return false;
    picking = {scope: group.scope, roster, choices: new Set([...selected.keys()].filter(key => roster.has(key))),
      direct: group.direct, limit: mentionsLimit(group), reply, onApply};
    queryField.value = '';
    pickerNode('quote').hidden = !reply;
    pickerNode('quote-author').textContent = reply?.author || '';
    pickerNode('quote-text').textContent = reply?.excerpt || '';
    close();
    renderPicker();
    picker.showModal();
    pickerNode('title').focus({preventScroll: true});
    return true;
  }

  launcher?.addEventListener('click', () => openPicker());
  pickerNode('cancel')?.addEventListener('click', () => picker.close());
  queryField?.addEventListener('input', () => { if (picking && picker.open) renderPicker(); });
  picker?.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  picker?.addEventListener('close', () => {
    if (picker.open) return;
    picking = null;
    results.replaceChildren();
    queryField.value = '';
    pickerNode('quote-author').textContent = '';
    pickerNode('quote-text').textContent = '';
  });
  pickerNode('form')?.addEventListener('submit', event => {
    event.preventDefault();
    const view = picking;
    const group = refresh();
    if (!view || !picker.open || view.scope !== group?.scope || input.disabled || applyButton.disabled) return;
    const roster = new Map(group.agents.filter(availableAgent).map(agent => [agentKey(agent), agent]));
    const choices = [...view.choices].filter(key => roster.has(key));
    if (choices.length !== view.choices.size) {
      view.roster = roster;
      view.choices = new Set(choices);
      renderPicker();
      selectedLabel.textContent = text('可选成员已更新，请重新确认。', 'Available agents changed. Review your selection again.');
      queryField.focus();
      return;
    }
    selected.clear();
    for (const key of choices) {
      const agent = roster.get(key);
      selected.set(key, {owner_id: agent.owner_id, agent_id: agent.id});
    }
    remember();
    renderSelected();
    picker.close();
    view.onApply?.();
    input.focus({preventScroll: true});
  });

  return {
    refresh,
    openPicker,
    canPick: () => Boolean(picker && refresh()?.agents.some(availableAgent) && !input.disabled),
    clear() {
      scope = null;
      roster = undefined;
      available.clear();
      selected.clear();
      renderSelected();
      close();
      if (picker?.open) picker.close();
      if (launcher) launcher.hidden = true;
    },
    forget(targetScope) {
      savedSelections.delete(targetScope);
      writeChatDraftMentions(doc.defaultView, targetScope, []);
      if (scope !== targetScope) return;
      selected.clear();
      renderSelected();
      close();
      if (picker?.open) picker.close();
    },
    restoreDirect(targets) {
      if (!refresh()?.direct || selected.size || !Array.isArray(targets)) return false;
      restoreTargets(targets);
      remember();
      renderSelected();
      return true;
    },
    prepareDirectLink({ownerId, agentId}) {
      const group = refresh();
      const key = agentKey({owner_id:ownerId,id:agentId});
      if (!group?.direct || !available.has(key)) return false;
      if (!selected.size && !input.value.trim()) {
        restoreTargets([{owner_id:ownerId,agent_id:agentId}]);
        remember();
        renderSelected();
      }
      return true;
    },
    keydown(event) {
      if (event.isComposing || list.hidden || !options.length) return false;
      const keys = ['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Tab'];
      if (!keys.includes(event.key) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      event.preventDefault();
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' || event.key === 'Tab') choose(options[active]);
      else {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        highlight();
      }
      return true;
    },
    message(body) {
      const group = refresh();
      if (!group || !selected.size) return {body};
      if (selected.size > mentionsLimit(group) || [...selected.keys()].some(key => !available.has(key))) return null;
      return {body, agent_mentions: [...selected.values()], ...(group.direct ? {direct_agent_request: true} : {})};
    },
  };
}
