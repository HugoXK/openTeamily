const MAX_MENTIONS = 20;
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
  if (!input || !list || !chips) return {
    refresh() {}, clear() {}, openPicker() {}, canPick: () => false, keydown: () => false, message: body => ({body}),
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
  let options = [];
  let active = 0;
  const selected = new Map();
  let picking = null;

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    options = [];
  }

  function renderSelected() {
    chips.replaceChildren(...Array.from(selected, ([key, agent]) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = agent.owner_name ? `@${agent.name} · ${agent.owner_name} ×` : `@${agent.name} ×`;
      button.setAttribute('aria-label', text(`移除对 ${agent.name}${agent.owner_name ? `（${agent.owner_name}）` : ''} 的提及`,
        `Remove mention of ${agent.name}${agent.owner_name ? ` (${agent.owner_name})` : ''}`));
      button.addEventListener('click', () => {
        selected.delete(key);
        renderSelected();
        input.focus();
      });
      return button;
    }));
    chips.hidden = selected.size === 0;
  }

  function refresh() {
    const group = context();
    if (launcher) launcher.hidden = !group?.agents.some(availableAgent);
    if (scope !== group?.scope) {
      scope = group?.scope;
      selected.clear();
      renderSelected();
      close();
      if (picker?.open) picker.close();
    }
    return group;
  }

  function choose(agent) {
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!query || !group?.agents.some(candidate => agentKey(candidate) === agentKey(agent) && !candidate.archived) || selected.size >= MAX_MENTIONS) {
      close();
      return;
    }
    const end = input.selectionStart;
    input.value = input.value.slice(0, query.start) + input.value.slice(end);
    input.setSelectionRange(query.start, query.start);
    selected.set(agentKey(agent), agent);
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
    if (!group || !query || selected.size >= MAX_MENTIONS) { close(); return; }
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
    selectedLabel.textContent = text(`已选 ${size}`, `${size} selected`);
    applyButton.disabled = Boolean(picking.reply && !size);
    for (const box of results.querySelectorAll('input')) box.disabled = !box.checked && size >= MAX_MENTIONS;
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
    picking = {scope: group.scope, roster, choices: new Set([...selected.keys()].filter(key => roster.has(key))), reply, onApply};
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
    for (const key of choices) selected.set(key, roster.get(key));
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
      selected.clear();
      renderSelected();
      close();
      if (picker?.open) picker.close();
      if (launcher) launcher.hidden = true;
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
      return {body, agent_mentions: Array.from(selected.values(), agent => ({owner_id: agent.owner_id, agent_id: agent.id}))};
    },
  };
}
