const grantId = /^otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function mountAgentSharing(document, {request, context, idempotencyKey}) {
  const node = id => document.getElementById('agent-share-' + id);
  const dialog = node('dialog');
  const recipient = node('recipient');
  const instructions = node('instructions');
  const quickStarts = node('quick-starts');
  const status = node('status');
  const submit = node('submit');
  const text = (zh, en) => document.documentElement?.lang?.startsWith('en') ? en : zh;
  const person = profile => [profile?.display_name, profile?.handle && '@' + profile.handle].filter(Boolean).join(' · ');
  const keys = new Map();
  let view;

  for (const [id, zh, en] of [
    ['title','私下分享智能体','Share agent privately'], ['recipient-label','收件人','Recipient'],
    ['recipients-more','加载更多收件人','More recipients'], ['content-label','随副本分享','Include in the copy'],
    ['instructions-label','已保存的指令','Saved instructions'], ['quick-starts-label','已保存的快捷开场','Saved quick starts'],
    ['note','对方可将名称、简介和分类复制到个人工作区，并另行配置工具。','The recipient can copy the name, summary, and category into their personal workspace and configure tools there.'],
    ['submit','创建分享','Create share'], ['link-label','收件人链接','Recipient link'],
    ['sent-title','已发出的分享','Sent shares'], ['sent-more','加载更多分享','More shares'], ['close','关闭','Close'],
  ]) node(id).textContent = text(zh,en);

  function current(state) {
    const selected = context();
    return view === state && dialog.open && selected?.user === state.user && selected.workspace === state.workspace &&
      selected.agent.id === state.agent.id && selected.agent.revision === state.agent.revision;
  }

  function controls(state) {
    recipient.disabled = state.busy || !state.recipients.items.length;
    instructions.disabled = state.busy || !state.agent.instructions;
    quickStarts.disabled = state.busy || !state.agent.quick_starts?.length;
    submit.disabled = state.busy || !state.canCreate || !state.recipients.items.some(row => row.owner_id === recipient.value);
    node('close').disabled = state.busy;
    for (const kind of ['recipients','sent']) {
      const page = state[kind];
      const more = node(kind + '-more');
      more.hidden = !page.next && !page.failed;
      more.disabled = page.loading || state.busy;
    }
  }

  function showLink(state, grant) {
    const path = '/discover?' + new URLSearchParams({tab:'agents', share:grant.id});
    const origin = document.defaultView?.location?.origin;
    state.linkId = grant.id;
    node('link').value = origin ? origin + path : path;
    node('link-field').hidden = false;
  }

  async function copyLink(state, grant) {
    showLink(state, grant);
    try {
      await document.defaultView.navigator.clipboard.writeText(node('link').value);
      if (current(state)) status.textContent = text('已复制收件人链接。', 'Recipient link copied.');
    } catch {
      if (!current(state)) return;
      node('link').focus();
      node('link').select();
      status.textContent = text('请选中并复制链接。', 'Select and copy the link.');
    }
  }

  function button(label, action) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', action);
    return control;
  }

  function renderSent(state) {
    node('sent').replaceChildren(...state.sent.items.map(grant => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const labels = {active: text('有效','Active'), revoked: text('已撤销','Revoked'), closed: text('已关闭','Closed')};
      label.textContent = person(grant.recipient) + ' · ' + labels[grant.state];
      row.append(label);
      if (grant.state !== 'active') return row;
      const copy = button(text('复制链接','Copy link'), () => { if (current(state)) void copyLink(state,grant); });
      const revoke = button(text('撤销','Revoke'), () => {
        if (!current(state) || state.busy) return;
        const confirm = button(text('确认撤销','Confirm revoke'), () => void revokeGrant(state,grant));
        const cancel = button(text('取消','Cancel'), () => { confirm.remove(); cancel.remove(); revoke.hidden = false; revoke.focus(); });
        revoke.hidden = true;
        row.append(cancel,confirm);
        cancel.focus();
      });
      row.append(copy,revoke);
      return row;
    }));
  }

  function renderRecipients(items) {
    const previous = recipient.value;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = text('选择收件人','Select recipient');
    recipient.replaceChildren(placeholder, ...items.map(profile => {
      const option = document.createElement('option');
      option.value = profile.owner_id;
      option.textContent = person(profile);
      return option;
    }));
    recipient.value = items.some(profile => profile.owner_id === previous) ? previous : '';
  }

  async function load(state, kind) {
    const page = state[kind];
    if (!current(state) || state.busy || page.loading) return;
    page.loading = true;
    controls(state);
    const query = new URLSearchParams({limit:'30'});
    if (page.next) query.set('after', page.next);
    const path = kind === 'sent' ? state.path : '/v1/agent-copy-grants/recipients';
    const result = await request('GET', path + '?' + query).catch(() => null);
    if (!current(state)) return;
    page.loading = false;
    page.failed = result?.status !== 200;
    if (page.failed) status.textContent = text('加载失败，请重试。','Could not load shares. Try again.');
    else {
      const items = Array.isArray(result.body.items) ? result.body.items : [];
      const key = kind === 'sent' ? 'id' : 'owner_id';
      const found = new Map(page.items.map(row => [row[key],row]));
      for (const item of items) {
        if (kind === 'sent') {
          if (!grantId.test(item.id) || item.source_agent_id !== state.agent.id) continue;
          if (item.state === 'active' && found.has(item.id) && found.get(item.id).state !== 'active') continue;
        } else if (typeof item.owner_id !== 'string') continue;
        found.set(item[key],item);
      }
      page.items = [...found.values()];
      page.next = result.body.next_cursor || '';
      if (kind === 'sent') renderSent(state);
      else {
        renderRecipients(page.items);
        if (!page.items.length) status.textContent = text('暂无可分享的联系人或队友。','No eligible contacts or teammates.');
      }
    }
    controls(state);
  }

  async function revokeGrant(state, grant) {
    if (!current(state) || state.busy) return;
    state.busy = true;
    controls(state);
    const result = await request('POST', `${state.path}/${grant.id}/revoke`, {}).catch(() => null);
    if (!current(state)) return;
    state.busy = false;
    controls(state);
    if (result?.status !== 200 || result.body.grant?.id !== grant.id) {
      status.textContent = result?.body?.error?.message || text('无法撤销分享。','Could not revoke the share.');
      return;
    }
    state.sent.items = state.sent.items.map(item => item.id === grant.id ? result.body.grant : item);
    if (state.linkId === grant.id) {
      node('link-field').hidden = true;
      node('link').value = '';
    }
    renderSent(state);
    status.textContent = text('已撤销分享。','Share revoked.');
    node('close').focus({preventScroll:true});
  }

  node('form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = view;
    if (!state || !current(state) || submit.disabled) return;
    const body = {recipient_owner_id:recipient.value, revision:state.agent.revision,
      share_instructions:!instructions.disabled && instructions.checked, share_quick_starts:!quickStarts.disabled && quickStarts.checked};
    const fingerprint = JSON.stringify([state.user,state.path,body]);
    const key = keys.get(fingerprint) || idempotencyKey();
    keys.set(fingerprint,key);
    state.busy = true;
    controls(state);
    status.textContent = text('正在创建分享…','Creating share…');
    const result = await request('POST', state.path, body, {'Idempotency-Key':key}).catch(() => null);
    if (!current(state)) return;
    state.busy = false;
    const grant = result?.body?.grant;
    if (![200,201].includes(result?.status) || !grantId.test(grant?.id || '') || grant.source_agent_id !== state.agent.id) {
      status.textContent = result?.body?.error?.message || text('无法确认是否已创建分享，请重试。','Could not confirm the share. Try again.');
    } else {
      keys.delete(fingerprint);
      state.sent.items = [grant,...state.sent.items.filter(item => item.id !== grant.id)];
      renderSent(state);
      showLink(state,grant);
      status.textContent = text('已创建分享。','Share created.');
      recipient.value = '';
    }
    controls(state);
  });
  recipient.addEventListener('change', () => { if (view) controls(view); });
  for (const kind of ['recipients','sent']) node(kind+'-more').addEventListener('click', () => { if (view) void load(view,kind); });
  node('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (view?.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    view = null;
    recipient.replaceChildren();
    node('sent').replaceChildren();
    node('name').textContent = status.textContent = node('link').value = '';
    node('link-field').hidden = true;
  });

  return {
    open() {
      const selected = context();
      if (!selected || dialog.open) return;
      const {agent,workspace} = selected;
      const state = view = {...selected, path:`/v1/workspaces/${workspace}/agents/${agent.id}/shares`,
        recipients:{items:[]}, sent:{items:[]}, canCreate:!agent.archived && !agent.native_deleted};
      node('form').hidden = !state.canCreate;
      node('name').textContent = agent.name;
      status.textContent = '';
      node('link-field').hidden = true;
      node('link').value = '';
      instructions.checked = quickStarts.checked = false;
      renderRecipients([]);
      renderSent(state);
      controls(state);
      dialog.showModal();
      if (state.canCreate) void load(state,'recipients');
      void load(state,'sent');
    },
    close() {
      view = null;
      if (dialog.open) dialog.close();
    },
  };
}
