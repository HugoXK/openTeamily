// Persisted private model operations. Provider output is text, never executable markup.
export function mountMessageUtilities(document, {request, context, composerContext = context, notify,
  stickersAvailable, activateStickers, closeStickers}) {
  const dialog = document.getElementById('message-assist-dialog');
  const announcement = document.getElementById('announcement-dialog');
  if (!dialog || !announcement) return {open() {}, refreshAnnouncement() {}};
  let target = null, timer = null, generation = 0, busy = false, retryKey = null;
  const field = document.getElementById('message-assist-instruction');
  const error = document.getElementById('message-assist-status');
  const history = document.getElementById('message-assist-history');
  const same = captured => { const now = context(); return now && captured && now.wid === captured.wid && now.cid === captured.cid; };
  const base = c => `/v1/workspaces/${c.wid}/social/conversations/${c.cid}`;
  const key = () => globalThis.crypto.randomUUID().replaceAll('-', '');
  function stop() { clearTimeout(timer); generation += 1; }
  dialog.addEventListener('close', () => { stop(); target = null; });
  document.getElementById('message-assist-close').addEventListener('click', () => dialog.close());
  async function load() {
    if (!target || dialog.open === false) return;
    const captured = target, token = ++generation;
    try {
      const result = await request('GET', base(captured) + '/assists');
      if (target !== captured || token !== generation) return;
      if (result.status !== 200) throw new Error('无法读取私人处理历史。');
      const rows = (result.body.items || []).filter(r => r.message_id === captured.item.id);
      history.replaceChildren();
      for (const row of rows) {
        const li = document.createElement('li');
        const heading = document.createElement('strong'); heading.textContent = `${row.operation === 'translate' ? '翻译' : '问 AI'} · ${row.instruction} · 来源修订 ${row.source_revision}`;
        const text = document.createElement('p'); text.style.whiteSpace = 'pre-wrap';
        text.textContent = row.status === 'succeeded' ? row.text : `${row.status}${row.error_code ? ' · ' + row.error_code : ''}`;
        li.append(heading, text); history.append(li);
      }
      if (!rows.length) history.textContent = '还没有这条消息的处理记录。';
      if (rows.some(r => ['queued', 'running'].includes(r.status))) timer = setTimeout(load, 1500);
    } catch (e) { if (target === captured) error.textContent = e.message || '网络错误，读取失败。请重新打开。'; }
  }
  document.getElementById('message-assist-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !same(target)) { error.textContent = '请重新打开当前会话中的消息。'; return; }
    const captured = target;
    const payload = {message_id: captured.item.id, revision: captured.item.revision || 1, operation: captured.operation, instruction: field.value.trim()};
    const serialized = JSON.stringify(payload);
    if (!retryKey || retryKey.payload !== serialized) retryKey = {payload: serialized, value: key()};
    busy = true; const button = document.getElementById('message-assist-submit'); button.disabled = true;
    error.textContent = '正在提交…';
    try {
      const response = await request('POST', base(captured) + '/assists', payload, {'Idempotency-Key': retryKey.value});
      if (target !== captured) return;
      if (![200, 201].includes(response.status)) { error.textContent = response.body.error?.message || '无法创建任务；请检查模型配置和自己的在线运行时。'; return; }
      error.textContent = '任务已持久化；等待运行时实际返回。不发送到群聊。';
      stop(); await load();
    } catch { if (target === captured) error.textContent = '网络错误，任务结果未知；保持原问题重试不会重复创建。'; }
    finally { busy = false; button.disabled = false; }
  });
  let announcementTarget = null;
  const announcementText = document.getElementById('announcement-body');
  const announcementStatus = document.getElementById('announcement-status');
  async function readAnnouncement(captured) {
    const result = await request('GET', base(captured) + '/announcement');
    if (result.status !== 200) throw new Error('无法读取群公告。');
    return result.body;
  }
  async function refreshAnnouncement() {
    const c = context();
    const preview = document.getElementById('group-announcement-preview');
    if (preview) preview.textContent = c && c.kind === 'group' ? '正在读取公告…' : '';
    if (!c || c.kind !== 'group') return;
    try { const result = await readAnnouncement(c); if (same(c) && preview) preview.textContent = result.announcement.body || '还没有群公告。'; }
    catch { if (same(c) && preview) preview.textContent = '群公告读取失败，请打开公告后重试。'; }
  }
  const publish = document.getElementById('group-announcement-open');
  if (publish) publish.addEventListener('click', async () => {
    const c = context(); if (!c || c.kind !== 'group') return;
    announcementStatus.textContent = '正在读取…'; announcementText.value = '';
    const save = document.getElementById('announcement-save'); save.disabled = true;
    announcementTarget = null; announcement.showModal();
    try {
      const result = await readAnnouncement(c); if (!same(c)) throw new Error('会话已切换，请重新打开。');
      announcementTarget = {...c, revision: result.announcement.revision};
      announcementText.value = result.announcement.body; announcementText.disabled = !result.can_edit; save.disabled = !result.can_edit;
      announcementStatus.textContent = result.can_edit ? '工作区管理员可以编辑；提交后所有群成员可见。清空并保存可撤下公告。' : '只有工作区管理员群成员可以编辑。';
    } catch (e) { announcementStatus.textContent = e.message; }
  });
  document.getElementById('announcement-close').addEventListener('click', () => announcement.close());
  document.getElementById('announcement-form').addEventListener('submit', async event => {
    event.preventDefault(); const c = announcementTarget; if (!c || !same(c)) return;
    const save = document.getElementById('announcement-save'); if (save.disabled) return; save.disabled = true;
    try {
      const result = await request('POST', base(c) + '/announcement', {body: announcementText.value, revision: c.revision});
      if (result.status !== 200) { announcementStatus.textContent = result.body.error?.message || '保存失败；请关闭并重开以读取最新修订。'; return; }
      announcement.close(); await refreshAnnouncement(); notify('ok', '群公告已保存。');
    } catch { announcementStatus.textContent = '网络错误，结果未知；请关闭并重新打开检查。'; }
    finally { save.disabled = false; }
  });
  const picker = document.getElementById('resource-picker');
  const choices = document.getElementById('resource-picker-list');
  const pickerKind = document.getElementById('resource-picker-kind');
  const pickerStatus = document.getElementById('resource-picker-status');
  const more = document.getElementById('resource-picker-more');
  let pickerContext = null, cursor = '', pickerGeneration = 0;
  const pickerSame = c => { const now = composerContext(); return now && c && now.wid === c.wid && now.cid === c.cid && now.source === c.source && now.scope === c.scope; };
  async function listResources(append = false) {
    const c = pickerContext, token = ++pickerGeneration, kind = pickerKind.value;
    if (!pickerSame(c)) { pickerStatus.textContent = '会话已切换，请重新打开。'; return; }
    if (!append) { cursor = ''; choices.replaceChildren(); }
    pickerStatus.textContent = '正在读取…'; more.hidden = true;
    try {
      const query = '?limit=50' + (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const result = await request('GET', `/v1/workspaces/${c.wid}/${kind}${query}`);
      if (token !== pickerGeneration || !pickerSame(c)) return;
      if (result.status !== 200) throw new Error('资料读取失败。');
      const rows = (result.body.items || []).filter(r => kind === 'memory' || r.kind === 'document');
      for (const row of rows) {
        const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.textContent = row.title;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const seen = await request('GET', `/v1/workspaces/${c.wid}/${kind}/${row.id}`);
            if (token !== pickerGeneration || pickerContext !== c || !picker.open || !pickerSame(c) || pickerKind.value !== kind) return;
            if (seen.status !== 200) throw new Error('这份资料已不可用。');
            const item = seen.body.page || seen.body.artifact;
            const fragment = `\n\n参考资料：${item.title}（修订 ${item.revision}）\n` + JSON.stringify(item.body || '');
            const composer = document.getElementById('chat-body');
            if (composer.value.length + fragment.length > 4000) throw new Error('内容超过消息上限；未截断或插入。请打开原文选择较短片段。');
            composer.value += fragment; composer.dispatchEvent(new Event('input', {bubbles:true}));
            picker.close(); composer.focus();
          } catch(e) { pickerStatus.textContent = e.message || '网络错误，未插入内容。'; }
          finally { button.disabled = false; }
        });
        li.append(button); choices.append(li);
      }
      cursor = result.body.cursor || ''; more.hidden = !cursor;
      pickerStatus.textContent = choices.children.length ? '选择一份资料，正文将放入输入框供你检查。' : '本页没有文档或记忆。';
    } catch(e) { if (token === pickerGeneration) pickerStatus.textContent = e.message || '网络错误。'; }
  }
  function openPicker(kind) {
    pickerContext = composerContext(); if (!pickerContext) { notify('error', '请先打开一个会话。'); return; }
    pickerKind.value = kind; picker.showModal(); listResources();
  }
  document.getElementById('composer-resource-open')?.addEventListener('click', () => openPicker('artifacts'));
  document.getElementById('composer-memory-open')?.addEventListener('click', () => openPicker('memory'));
  pickerKind?.addEventListener('change', () => listResources());
  more?.addEventListener('click', () => listResources(true));
  document.getElementById('resource-picker-close')?.addEventListener('click', () => picker.close());
  picker?.addEventListener('close', () => { pickerGeneration += 1; pickerContext = null; });
  const emojiDialog=document.getElementById('composer-emoji-dialog');
  const emojiList=document.getElementById('composer-emoji-list');
  const mediaTabs = document.getElementById('composer-media-tabs');
  const emojiTab = document.getElementById('composer-emoji-tab');
  const stickerTab = document.getElementById('composer-sticker-tab');
  const emojiPanel = document.getElementById('composer-emoji-panel');
  const stickerPanel = document.getElementById('composer-sticker-panel');
  const stickerStatus = document.getElementById('composer-sticker-status');
  let emojiTarget=null;

  function selectMediaTab(tab) {
    if (!mediaTabs) return;
    const showStickers = tab === stickerTab;
    for (const item of [emojiTab, stickerTab]) {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    emojiPanel.hidden = showStickers;
    stickerPanel.hidden = !showStickers;
    if (!showStickers) return;
    Promise.resolve().then(() => activateStickers?.()).catch(() => {
      if (!emojiDialog.open || stickerPanel.hidden) return;
      stickerStatus.textContent = document.documentElement.lang.startsWith('en')
        ? 'Could not open stickers. Select the tab to try again.' : '贴纸暂时打不开，请重新点一下贴纸标签。';
    });
  }

  emojiTab?.addEventListener('click', () => selectMediaTab(emojiTab));
  stickerTab?.addEventListener('click', () => selectMediaTab(stickerTab));
  mediaTabs?.addEventListener('keydown', event => {
    const tabs = [emojiTab, stickerTab];
    const active = tabs.indexOf(document.activeElement);
    if (active < 0) return;
    const next = {ArrowLeft: 1 - active, ArrowRight: 1 - active, Home: 0, End: 1}[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    for (const [index, tab] of tabs.entries()) tab.tabIndex = index === next ? 0 : -1;
    tabs[next].focus();
  });
  document.getElementById('composer-emoji-open')?.addEventListener('click',()=>{
    const c=composerContext(),composer=document.getElementById('chat-body');
    if(!c||composer.disabled){notify('error','请先打开可发送的会话。');return;}
    emojiTarget={context:c,start:composer.selectionStart,end:composer.selectionEnd};
    if (mediaTabs) {
      mediaTabs.hidden = !stickersAvailable?.();
      if (mediaTabs.hidden) {
        emojiPanel.removeAttribute('role');
        emojiPanel.removeAttribute('aria-labelledby');
      } else {
        emojiPanel.setAttribute('role', 'tabpanel');
        emojiPanel.setAttribute('aria-labelledby', emojiTab.id);
      }
      selectMediaTab(emojiTab);
    }
    emojiDialog.showModal();
    if (mediaTabs && !mediaTabs.hidden) emojiTab.focus();
    else emojiList?.firstElementChild?.focus();
  });
  for(const emoji of ['😀','👍','❤️','🎉','🙏','🤔','✅','🚀','👀','💡','📌','✨']){
    if(!emojiList)break;
    const button=document.createElement('button');button.type='button';button.textContent=emoji;button.setAttribute('aria-label','插入 '+emoji);
    button.addEventListener('click',()=>{
      const composer=document.getElementById('chat-body');
      if(!emojiTarget||!pickerSame(emojiTarget.context)){notify('error','会话已切换，请重新打开表情。');emojiDialog.close();return;}
      const start=Number.isInteger(emojiTarget.start)?emojiTarget.start:composer.value.length,end=Number.isInteger(emojiTarget.end)?emojiTarget.end:start;
      const next=composer.value.slice(0,start)+emoji+composer.value.slice(end);
      if(next.length>4000){notify('error','消息超过上限；没有插入或发送。');return;}
      composer.value=next;composer.dispatchEvent(new Event('input',{bubbles:true}));emojiDialog.close();composer.focus();
    });
    emojiList.append(button);
  }
  document.getElementById('composer-emoji-close')?.addEventListener('click',()=>emojiDialog.close());
  emojiDialog?.addEventListener('close',()=>{emojiTarget=null;closeStickers?.();});
  return {
    refreshAnnouncement,
    open(item, operation) {
      const c = context(); if (!c) return;
      stop(); retryKey = null; target = {...c, item, operation};
      field.value = operation === 'translate' ? '简体中文' : '';
      document.getElementById('message-assist-heading').textContent = operation === 'translate' ? '翻译消息' : '问 AI';
      error.textContent = '使用你的模型覆盖配置或平台默认模型，通过你自己的在线运行时处理。仅自己可见；不会调用连接器或发送消息。';
      history.replaceChildren(); dialog.showModal(); field.focus(); load();
    },
  };
}

// Account settings alter rendering, not stored message bytes or copy/forward payloads.
export function renderMessageText(document, root, text, folding = 'standard', linkPreviews = false) {
  root.replaceChildren();
  const limit = folding === 'compact' ? 240 : folding === 'none' ? Infinity : 800;
  if (String(text || '').length <= limit) root.textContent = text || '';
  else {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = String(text).slice(0, limit) + '… 展开全文';
    const content = document.createElement('span'); content.setAttribute('style','white-space:pre-wrap'); content.textContent = text;
    details.append(summary, content); root.append(details);
  }
  if (!linkPreviews) return;
  const seen = new Set();
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    try {
      const url=new URL(match[0].replace(/[.,;!?)。，；！）]+$/u,''));
      if(url.username||url.password||seen.has(url.href))continue;
      seen.add(url.href);
      const card=document.createElement('a');card.className='chat-link-card';card.href=url.href;card.target='_blank';card.rel='noopener noreferrer';
      card.textContent=url.hostname+' · '+url.pathname;card.title='链接地址预览；未抓取外部网页。';root.append(card);
      if(seen.size>=3)break;
    } catch { /* Invalid URLs remain plain text; never request metadata or run schemes. */ }
  }
}
