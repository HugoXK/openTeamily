import {artifactKindLabel} from '../shell/thumb.mjs';

const FORMATS = {
  document: [['docx','Word DOCX'], ['pdf','文本 PDF']],
  slides: [['pptx','PowerPoint PPTX'], ['pdf','提纲 PDF']],
  spreadsheet: [['xlsx','Excel XLSX']],
  dashboard: [['xlsx','Excel XLSX'], ['pdf','数据 PDF']],
};

function appendText(parent, tag, text) {
  const element = parent.ownerDocument.createElement(tag);
  element.textContent = String(text ?? '');
  parent.append(element);
  return element;
}

function previewWorkbook(root, sheets) {
  const chooser = appendText(root,'select','');
  chooser.setAttribute('aria-label','预览工作表');
  const contents = appendText(root,'div','');
  for (const [index, sheet] of sheets.entries()) {
    const option = appendText(chooser,'option',sheet.name);
    option.value = String(index);
  }
  function display() {
    contents.replaceChildren();
    const rows = sheets[Number(chooser.value)]?.rows || [];
    const width = Math.max(0, ...rows.map(row => row.length));
    if (rows.length > 20 || width > 10) appendText(contents,'p','显示前 20 行、前 10 列。导出可查看完整工作表。');
    const table = appendText(contents,'table','');
    for (const row of rows.slice(0,20)) {
      const line = appendText(table,'tr','');
      for (const value of row.slice(0,10)) appendText(line,'td',value);
    }
  }
  chooser.addEventListener('change',display);
  display();
}

export function renderWorkVersion(root, version, exportPath) {
  root.replaceChildren();
  if (typeof version.body === 'string') {
    if (version.kind === 'website') appendText(root,'p','已保存的网站源代码');
    appendText(root,'pre',version.body || '此版本的正文为空。');
  } else if (version.slides?.slides?.length) {
    for (const slide of version.slides.slides) {
      appendText(root,'h3',slide.title);
      const list = appendText(root,'ul','');
      for (const bullet of slide.bullets) appendText(list,'li',bullet);
    }
  } else if (version.spreadsheet?.sheets?.length) {
    previewWorkbook(root, version.spreadsheet.sheets);
  } else if (version.dashboard?.widgets?.length) {
    for (const widget of version.dashboard.widgets) {
      appendText(root,'h3',widget.title);
      if (widget.type === 'metric') {
        appendText(root,'p',widget.value);
        if (widget.note) appendText(root,'p',widget.note);
      } else if (widget.type === 'table') {
        const table = appendText(root,'table','');
        for (const row of [widget.columns,...widget.rows]) {
          const line = appendText(table,'tr','');
          for (const value of row) appendText(line,'td',value);
        }
      } else if (widget.type === 'bar') {
        const list = appendText(root,'ul','');
        for (const [index, label] of widget.labels.entries()) appendText(list,'li',label + ' · ' + widget.values[index]);
      }
    }
  } else if (version.kind === 'whiteboard' || /^image\/(?:png|jpeg|webp|gif)$/.test(version.media?.mime || '')) {
    const image = appendText(root,'img','');
    image.src = exportPath;
    image.alt = version.title;
  } else if (/^(?:video\/(?:mp4|webm)|audio\/(?:mpeg|mp4|ogg|wav|webm))$/.test(version.media?.mime || '')) {
    const media = appendText(root,version.media.mime.startsWith('video/') ? 'video' : 'audio','');
    media.controls = true;
    media.preload = 'none';
    media.src = exportPath;
  } else {
    appendText(root,'p',version.media?.filename || '此版本可导出查看。');
  }
}

export function mountWorkVersion(document, {read, closeAddress}) {
  const get = name => document.getElementById('work-version-' + name);
  const dialog = get('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const title = get('title'), meta = get('meta'), preview = get('preview'), status = get('status');
  const tools = get('tools'), format = get('format'), download = get('download');
  const field = get('link'), copy = get('copy'), retry = get('retry');
  const view = document.defaultView;
  let state;

  function close({user = false} = {}) {
    const previous = state;
    state = null;
    previous?.controller.abort();
    if (dialog.open) dialog.close();
    preview.replaceChildren();
    field.value = status.textContent = '';
    field.hidden = true;
    if (user && previous?.current()) {
      closeAddress(previous);
      previous.trigger?.focus({preventScroll:true});
    }
  }

  function syncExport(target) {
    const selected = format.value;
    download.href = target.path + '/export' + (selected === 'original' ? '' : '?format=' + encodeURIComponent(selected));
  }

  async function load(target) {
    status.textContent = '正在读取此版本…';
    tools.hidden = retry.hidden = true;
    const signal = AbortSignal.any([target.controller.signal, AbortSignal.timeout(12000)]);
    const result = await read(target.path, signal).catch(() => ({status:0,body:{}}));
    if (state !== target || !target.current()) return;
    const version = result.body?.version;
    if (result.status !== 200 || version?.revision !== target.revision || typeof version.title !== 'string') {
      retry.hidden = result.status === 404;
      status.textContent = result.status === 404 ? '此版本已不存在，或你没有访问权限。' : '无法读取此版本，请重试。';
      return;
    }
    title.textContent = version.title;
    meta.textContent = '只读 · 修订 ' + version.revision + ' · ' + artifactKindLabel(version.kind,version.media?.mime);
    format.replaceChildren();
    const choices = Object.hasOwn(FORMATS,version.kind) ? FORMATS[version.kind] : [];
    for (const [value, label] of [['original','原格式'],...choices]) {
      const option = appendText(format,'option',label);
      option.value = value;
    }
    renderWorkVersion(preview,version,target.path + '/export');
    syncExport(target);
    status.textContent = '';
    tools.hidden = false;
  }

  get('close').addEventListener('click',()=>close({user:true}));
  dialog.addEventListener('cancel',event=>{
    event.preventDefault();
    close({user:true});
  });
  format.addEventListener('change',()=>{ if (state?.current()) syncExport(state); });
  retry.addEventListener('click',()=>{ if (state?.current()) void load(state); });
  copy.addEventListener('click',async ()=>{
    const target = state;
    const link = field.value;
    try {
      await view.navigator.clipboard.writeText(link);
      if (state === target) status.textContent = '已复制版本链接。';
    } catch {
      if (state !== target) return;
      field.hidden = false;
      field.focus();
      field.select();
      status.textContent = '已选中版本链接，可手动复制。';
    }
  });

  return {
    close,
    open(target) {
      close();
      state = {...target,controller:new AbortController()};
      title.textContent = target.title;
      meta.textContent = '只读 · 修订 ' + target.revision;
      field.value = new URL(target.href, view.location.origin).href;
      dialog.showModal();
      void load(state);
    },
  };
}
