import {readChatDraftMentions, writeChatDraftMentions} from '../home/runtime-readiness.mjs';

const MAX_MENTIONS = 20;
const EVERYONE = Symbol('everyone');
const GROUP_ALL_TOKEN_PATTERN = /(^|[\s(（\[，。！？、,:：;；])[@＠](all|everyone|所有智能体|所有人|全体)(?=$|[\s)）\]，。！？、,:：;；!?]|\.(?=$|\s))/giu;
const EVERYONE_SEARCH = '所有人 所有智能体 全员 全体 everyone all';
const mentionsLimit = room => room?.direct ? 5 : MAX_MENTIONS;
const agentKey = agent => JSON.stringify([agent.owner_id, agent.id]);
const availableAgent = agent => Boolean(agent?.name && agent.owner_id && agent.id && !agent.archived);

function mentionText(body) {
  // Preserve offsets so editing an active mention leaves literal text intact.
  return body.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^\s)]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g,
    literal => ' '.repeat(literal.length));
}

export function hasGroupAllMention(body) {
  return Boolean(body && mentionText(body).match(GROUP_ALL_TOKEN_PATTERN));
}

export function hasEveryoneMention(body) {
  return [...mentionText(body ?? '').matchAll(GROUP_ALL_TOKEN_PATTERN)].some(match => match[2] !== '所有智能体');
}

function withoutGroupAllMention(body) {
  let text = '';
  let cursor = 0;
  for (const match of mentionText(body).matchAll(GROUP_ALL_TOKEN_PATTERN)) {
    text += body.slice(cursor, match.index + match[1].length);
    const end = match.index + match[0].length;
    cursor = body[end] === ' ' ? end + 1 : end;
  }
  return text + body.slice(cursor);
}

export function activeMentionQuery(text, caret) {
  const match = /(?:^|[\s(（\[，。！？、,:：;；])[@＠]([^\s@＠]{0,40})$/u.exec(mentionText(text).slice(0, caret));
  return match ? {start: caret - match[1].length - 1, query: match[1]} : null;
}

export function mountAgentMentions(doc, context, onSelectionChange = () => {}) {
  const input = doc.getElementById('chat-body');
  const list = doc.getElementById('chat-agent-mention-options');
  const chips = doc.getElementById('chat-agent-mentions');
  const staleStatus = doc.getElementById('chat-agent-mention-status');
  if (!input || !list || !chips) return {
    refresh() {}, clear() {}, forget() {}, openPicker() {}, canPick: () => false, keydown: () => false,
    restoreDraft: targets => !targets?.length, restoreDirect: () => false, prepareDirectLink: () => false,
    message: body => ({body}),
  };
  const pickerNode = id => doc.getElementById(`chat-agent-picker-${id}`);
  const launcher = pickerNode('open');
  const launcherLabel = launcher?.querySelector('.chat-agent-picker-label');
  const picker = doc.getElementById('chat-agent-picker');
  const results = pickerNode('results');
  const queryField = pickerNode('search');
  const applyButton = pickerNode('confirm');
  const selectedLabel = pickerNode('count');
  const text = (zh, en) => doc.documentElement?.lang?.startsWith('en') ? en : zh;
  const everyoneToken = () => text('@所有人 ', '@all ');

  let scope = null;
  let roster;
  let available = new Map();
  let options = [];
  let active = 0;
  let groupAllMention = false;
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
    const group = context();
    groupAllMention = Boolean(group && !group.direct && hasGroupAllMention(input.value));
    const focusedKey = preserveFocus && doc.activeElement?.dataset?.agentMentionKey;
    let stale = false;
    let nextFocus;
    chips.replaceChildren(...Array.from(groupAllMention ? [] : selected, ([key]) => {
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
    chips.hidden = groupAllMention || selected.size === 0;
    if (staleStatus) staleStatus.hidden = !stale;
    if (stale) input.setAttribute('aria-describedby', 'chat-agent-mention-status');
    else input.removeAttribute('aria-describedby');
    nextFocus?.focus({preventScroll: true});
    onSelectionChange(groupAllMention ? [] : [...selected.values()], stale);
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

  function restoreDraft(targets = [], {directOnly = false} = {}) {
    const group = refresh();
    if (selected.size || (directOnly && !group?.direct) || (targets.length && !group)) return false;
    if (targets.length) {
      restoreTargets(targets);
      remember();
      renderSelected();
    }
    return true;
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
        : text('选择群聊提及对象', 'Choose group mentions'));
      const action = group?.direct ? text('请智能体回复', 'Ask agents to reply') : text('选择提及对象', 'Choose mentions');
      if (launcherLabel) launcherLabel.textContent = group?.direct ? text('智能体', 'Agents') : text('提及', 'Mention');
      launcher?.setAttribute('aria-label', action);
      launcher?.setAttribute('title', action);
      const searchLabel = pickerNode('search-label');
      if (searchLabel) searchLabel.textContent = group?.direct ? text('搜索私聊智能体', 'Search chat agents')
        : text('搜索提及对象', 'Search mentions');
      if (queryField) queryField.placeholder = group?.direct ? text('搜索智能体名称或所有者', 'Search agent names or owners')
        : text('搜索所有人、智能体或所有者', 'Search everyone, agent names or owners');
    }
    if (changedScope || roster !== group?.agents) {
      roster = group?.agents;
      available = new Map((roster || []).filter(availableAgent).map(agent => [agentKey(agent), agent]));
      renderSelected({preserveFocus: !changedScope});
    }
    if (launcher) launcher.hidden = !group || (group.direct && available.size === 0);
    return group;
  }

  function insertEveryone(start, end) {
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    if (hasEveryoneMention(before + after)) {
      input.value = before + after;
      return start;
    }
    const prefix = withoutGroupAllMention(before) + everyoneToken();
    input.value = prefix + withoutGroupAllMention(after);
    return prefix.length;
  }

  function choose(agent) {
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!query || !group || (agent === EVERYONE ? group.direct
      : !available.has(agentKey(agent)) || (!groupAllMention && selected.size >= mentionsLimit(group)))) {
      close();
      return;
    }
    const before = input.value.slice(0, query.start);
    const after = input.value.slice(input.selectionStart);
    let caret = query.start;
    if (agent === EVERYONE) {
      caret = insertEveryone(query.start, input.selectionStart);
      selected.clear();
    } else {
      input.value = group.direct ? before + after : withoutGroupAllMention(before + after);
      if (!group.direct) caret = withoutGroupAllMention(before).length;
      if (groupAllMention) selected.clear();
      selected.set(agentKey(agent), {owner_id: agent.owner_id, agent_id: agent.id});
    }
    input.setSelectionRange(caret, caret);
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
    if (groupAllMention !== Boolean(group && !group.direct && hasGroupAllMention(input.value))) renderSelected();
    const query = input.selectionStart === input.selectionEnd || input.selectionEnd == null
      ? activeMentionQuery(input.value, input.selectionStart) : null;
    if (!group || !query) { close(); return; }
    const needle = query.query.toLowerCase();
    const matches = !groupAllMention && selected.size >= mentionsLimit(group) ? [] : group.agents.filter(agent =>
      availableAgent(agent) && (groupAllMention || !selected.has(agentKey(agent))) &&
      [agent.name, agent.owner_name].some(value => value?.toLowerCase().includes(needle)));
    if (!group.direct && EVERYONE_SEARCH.includes(needle)) matches.unshift(EVERYONE);
    options = matches.slice(0, 8);
    if (!options.length) { close(); return; }
    active = 0;
    list.replaceChildren(...options.map((agent, index) => {
      const option = doc.createElement('button');
      option.type = 'button';
      option.id = `chat-agent-mention-option-${index}`;
      option.setAttribute('role', 'option');
      if (agent === EVERYONE) option.dataset.mentionEveryone = '';
      option.textContent = agent === EVERYONE ? text('所有人', 'Everyone')
        : agent.owner_name ? `${agent.name} · ${agent.owner_name}` : agent.name;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(agent));
      return option;
    }));
    list.hidden = false;
    highlight();
  }

  input.addEventListener('input', suggest);
  input.addEventListener('compositionend', suggest);
  input.addEventListener('click', () => { if (!list.hidden) suggest(); });
  input.addEventListener('blur', close);

  function setPickerCount() {
    const size = picking.choices.size;
    selectedLabel.textContent = picking.everyone ? text('已选所有人', 'Everyone selected')
      : picking.direct ? text(`已选 ${size} / ${picking.limit}`, `${size} of ${picking.limit} selected`)
      : text(`已选 ${size}`, `${size} selected`);
    applyButton.disabled = Boolean(picking.reply && !size && !picking.everyone);
    for (const box of results.querySelectorAll('input')) {
      const everyone = Object.hasOwn(box.dataset, 'mentionEveryone');
      box.checked = everyone ? picking.everyone : picking.choices.has(box.dataset.mentionKey);
      box.disabled = !everyone && !box.checked && size >= picking.limit;
    }
  }

  function renderPicker() {
    const view = picking;
    const filter = queryField.value.trim().toLocaleLowerCase();
    const people = [...view.roster].filter(([, agent]) => `${agent.name} ${agent.owner_name || ''}`.toLocaleLowerCase().includes(filter));
    if (!view.direct && EVERYONE_SEARCH.includes(filter)) people.unshift([EVERYONE]);
    results.replaceChildren(...people.map(([key, agent]) => {
      const everyone = key === EVERYONE;
      const label = doc.createElement('label');
      label.className = 'chat-agent-picker-choice';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      if (everyone) {
        label.dataset.mentionEveryone = '';
        box.dataset.mentionEveryone = '';
      } else box.dataset.mentionKey = key;
      box.checked = everyone ? view.everyone : view.choices.has(key);
      const name = doc.createElement('span');
      name.textContent = everyone ? text('所有人', 'Everyone') : agent.name;
      if (everyone || agent.owner_name) {
        const owner = doc.createElement('small');
        owner.textContent = everyone ? (view.roster.size ? text('提及群成员，并请群内智能体回复', 'Notify the group and ask its agents to reply')
          : text('提及群内所有成员', 'Mention everyone in the group')) : agent.owner_name;
        name.append(owner);
      }
      label.append(box, name);
      box.addEventListener('change', () => {
        if (view !== picking || !picker.open) return;
        if (everyone) {
          view.everyone = box.checked;
          if (box.checked) view.choices.clear();
        } else if (box.checked) {
          view.everyone = false;
          view.choices.add(key);
        } else view.choices.delete(key);
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
    if (group.direct && !roster.size) return false;
    const everyone = !group.direct && hasEveryoneMention(input.value);
    const draft = input.value;
    const caret = input.selectionStart;
    const bareMention = caret === input.selectionEnd && activeMentionQuery(draft, caret)?.query === '' ? caret : null;
    picking = {scope:group.scope, roster, choices:new Set(groupAllMention ? [] : [...selected.keys()].filter(key => roster.has(key))),
      everyone, direct:group.direct, limit:mentionsLimit(group), reply, onApply, draft, bareMention};
    pickerNode('title').textContent = group.direct ? text('请智能体回复', 'Ask agents to reply') : text('选择提及对象', 'Choose mentions');
    pickerNode('help').textContent = group.direct ? text('选中的智能体会在你发送消息后回复。', 'Selected agents reply after you send the message.')
      : text('选择智能体或所有人，确认后把提及加到草稿。', 'Choose agents or everyone to add a mention to your draft.');
    pickerNode('empty').textContent = group.direct ? text('没有匹配的智能体。', 'No matching agents.')
      : text('没有匹配的提及对象。', 'No matching mentions.');
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
    const before = input.value;
    if (!group.direct) {
      if (view.everyone && !hasEveryoneMention(before)) {
        const caret = before === view.draft && view.bareMention !== null
          ? insertEveryone(view.bareMention - 1, view.bareMention) : insertEveryone(0, 0);
        input.setSelectionRange?.(caret, caret);
      }
      if (!view.everyone && (choices.length || hasEveryoneMention(before))) input.value = withoutGroupAllMention(before);
    }
    remember();
    renderSelected();
    picker.close();
    if (input.value !== before) input.dispatchEvent?.(new Event('input', {bubbles:true}));
    view.onApply?.();
    input.focus({preventScroll: true});
  });

  return {
    refresh,
    restoreDraft,
    openPicker,
    canPick: () => { const group = refresh(); return Boolean(picker && group && (!group.direct || group.agents.some(availableAgent)) && !input.disabled); },
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
    restoreDirect: targets => restoreDraft(targets, {directOnly:true}),
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
      if (event.isComposing || event.keyCode === 229 || list.hidden || !options.length) return false;
      if (['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        close();
        return false;
      }
      const keys = ['Escape', 'ArrowDown', 'ArrowUp', 'Enter'];
      if (!keys.includes(event.key) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      event.preventDefault();
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter') choose(options[active]);
      else {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        highlight();
      }
      return true;
    },
    message(body) {
      const group = refresh();
      if (group && !group.direct && hasGroupAllMention(body)) return {body};
      if (!group || !selected.size) return {body};
      if (selected.size > mentionsLimit(group) || [...selected.keys()].some(key => !available.has(key))) return null;
      return {body, agent_mentions: [...selected.values()], ...(group.direct ? {direct_agent_request: true} : {})};
    },
  };
}
