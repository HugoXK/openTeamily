export function csrfCookie(raw) {
  const parts = String(raw || '').split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-ot_csrf' || name === 'ot_dev_csrf') return rest.join('=');
  }
  return '';
}

export function listQuery(search) {
  const needle = (search || '').trim();
  return needle ? ('?q=' + encodeURIComponent(needle)) : '';
}

export function visibleArtifacts(items, {kind = 'all', scope = 'all', username = ''} = {}) {
  let rows = [...(items || [])];
  if (scope === 'mine' && username) {
    rows = rows.filter((item) => item.created_by === username);
  }
  if (kind === 'meetings') return [];
  if (kind === 'messages') {
    return rows.filter((item) => item.source && item.source.kind === 'agent_message');
  }
  if (kind && kind !== 'all') {
    return rows.filter((item) => item.kind === kind);
  }
  return rows;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const workspaceSelect = document.getElementById('workspace');
  const search = document.getElementById('search');
  let currentUser = null;
  let workspaces = [];
  let current = null;
  let draftKind = 'document';
  let catalogKind = 'all';
  let catalogScope = 'all';
  let allItems = [];

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  function kindLabel(kind) {
    if (kind === 'website') return '网站';
    if (kind === 'media') return '媒体';
    if (kind === 'whiteboard') return '白板';
    return '文档';
  }

  function strokeId() {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  let boardState = {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
  let boardTool = 'path';
  let drawing = null;

  function drawBoard() {
    const canvas = document.getElementById('board-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of boardState.strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      if (stroke.type === 'path' && stroke.points && stroke.points.length) {
        ctx.lineWidth = stroke.width || 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
        for (let i = 1; i < stroke.points.length; i += 1) ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
        ctx.stroke();
      } else if (stroke.type === 'rect') {
        ctx.lineWidth = 2;
        ctx.strokeRect(stroke.x, stroke.y, stroke.width, stroke.height);
      } else if (stroke.type === 'ellipse') {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(stroke.x + stroke.width / 2, stroke.y + stroke.height / 2, Math.abs(stroke.width / 2), Math.abs(stroke.height / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (stroke.type === 'text') {
        ctx.font = (stroke.size || 16) + 'px system-ui,sans-serif';
        ctx.fillText(stroke.text, stroke.x, stroke.y);
      }
    }
  }

  function canvasPoint(event) {
    const canvas = document.getElementById('board-canvas');
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * (canvas.width / box.width);
    const y = (event.clientY - box.top) * (canvas.height / box.height);
    return [Math.max(0, Math.min(800, x)), Math.max(0, Math.min(600, y))];
  }

  function fillEditor(item) {
    form.elements.title.value = item && item.title ? item.title : '';
    form.elements.body.value = item && typeof item.body === 'string' ? item.body : '';
    const kind = (item && item.kind) || draftKind;
    const meta = document.getElementById('editor-meta');
    const labels = {website: '新网站', media: '新媒体', whiteboard: '新白板', document: '新文档'};
    if (item && item.id) {
      meta.textContent = `${kindLabel(kind)} · 修订 ${item.revision} · 作者 ${item.created_by || ''}`;
    } else {
      meta.textContent = labels[kind] || '新文档';
    }
    document.getElementById('body-label').hidden = kind === 'media' || kind === 'whiteboard';
    document.getElementById('media-editor').hidden = kind !== 'media';
    document.getElementById('board-editor').hidden = kind !== 'whiteboard';
    const image = document.getElementById('media-image');
    const audio = document.getElementById('media-audio');
    const video = document.getElementById('media-video');
    const mediaMeta = document.getElementById('media-meta');
    image.hidden = true; audio.hidden = true; video.hidden = true;
    image.removeAttribute('src'); audio.removeAttribute('src'); video.removeAttribute('src');
    if (kind === 'media') {
      if (item && item.id && item.media) {
        mediaMeta.textContent = `${item.media.filename || ''} · ${item.media.mime || ''} · ${item.media.bytes || 0} 字节`;
        const src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/file`;
        if ((item.media.mime || '').startsWith('image/')) { image.hidden = false; image.src = src; }
        else if ((item.media.mime || '').startsWith('audio/')) { audio.hidden = false; audio.src = src; }
        else if ((item.media.mime || '').startsWith('video/')) { video.hidden = false; video.src = src; }
      } else {
        mediaMeta.textContent = '选择一张图片或一段音视频，大小不超过 2 MB。';
      }
    }
    if (kind === 'whiteboard') {
      boardState = item && item.board ? item.board : {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
      drawBoard();
    }
    const source = document.getElementById('editor-source');
    if (item && item.source) {
      source.hidden = false;
      const from = item.source.kind === 'agent_message' ? '对话消息'
        : item.source.kind === 'agent_task' ? '代理任务' : '自动化运行';
      const name = item.source.automation_title || item.source.task_kind || '';
      source.textContent = `出处：${from}${name ? ' · ' + name : ''} · ${item.source.id}`;
    } else {
      source.hidden = true;
      source.textContent = '';
    }
    const preview = document.getElementById('website-preview');
    if (kind === 'website' && item && item.id && workspaceId()) {
      preview.hidden = false;
      preview.setAttribute('sandbox', '');
      preview.removeAttribute('srcdoc');
      preview.src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/preview`;
    } else {
      preview.hidden = true;
      preview.removeAttribute('src');
      preview.removeAttribute('srcdoc');
    }
  }

  function closeNewMenu() {
    const menu = document.getElementById('new-menu');
    const button = document.getElementById('new-menu-button');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function renderCatalog() {
    const username = currentUser && currentUser.username;
    const items = visibleArtifacts(allItems, {kind: catalogKind, scope: catalogScope, username});
    renderList(items, (item) => openEditor(item));
    const empty = document.getElementById('list-empty');
    const emptyAll = document.getElementById('empty-all');
    const emptyKind = document.getElementById('empty-kind');
    const emptyMeetings = document.getElementById('empty-meetings');
    const emptyMessage = document.getElementById('list-empty-message');
    const newWebsite = document.getElementById('new-website');
    if (!empty) return;
    const isEmpty = items.length === 0;
    empty.hidden = !isEmpty;
    if (!isEmpty) return;
    const noWorkspace = emptyMessage && emptyMessage.textContent === '还没有工作区。';
    const showAllEmpty = catalogKind === 'all' && catalogScope === 'all' && !noWorkspace;
    if (emptyAll) emptyAll.hidden = !showAllEmpty;
    if (emptyMeetings) emptyMeetings.hidden = catalogKind !== 'meetings';
    if (emptyKind) emptyKind.hidden = showAllEmpty || catalogKind === 'meetings' || noWorkspace;
    if (emptyMessage) emptyMessage.hidden = !noWorkspace;
    if (newWebsite) newWebsite.hidden = !(emptyKind && !emptyKind.hidden && catalogKind === 'website');
    if (emptyKind && !emptyKind.hidden) {
      const note = document.getElementById('empty-kind-note');
      if (note) {
        if (catalogKind === 'messages') note.textContent = '还没有从对话保存到作品库的消息。';
        else if (catalogScope === 'mine') note.textContent = '还没有你创建的作品。';
        else note.textContent = '这一类还没有作品。';
      }
    }
  }

  function renderList(items, onOpen) {
    const list = document.getElementById('artifact-list');
    const empty = document.getElementById('list-empty');
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'link';
      open.textContent = item.title;
      open.addEventListener('click', () => onOpen(item));
      const meta = document.createElement('span');
      meta.className = 'note';
      const source = item.source && item.source.kind === 'agent_message' ? ' · 消息' : '';
      meta.textContent = `${kindLabel(item.kind)} · ${item.created_by || ''}${source}`;
      row.appendChild(open);
      row.appendChild(meta);
      list.appendChild(row);
    }
  }

  async function openEditor(item) {
    closeNewMenu();
    current = item;
    listPanel.hidden = true;
    form.hidden = false;
    if (item && item.id && workspaceId()) {
      const seen = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${item.id}`);
      if (seen.status !== 200) {
        show('error', messageFor(seen.body.error, '无法打开文档。'));
        return;
      }
      current = seen.body.artifact;
    }
    fillEditor(current);
    document.getElementById('remove-artifact').hidden = !current || !current.id;
    const sharePanel = document.getElementById('share-panel');
    sharePanel.hidden = !current || !current.id;
    document.getElementById('share-once').hidden = true;
    document.getElementById('share-once').textContent = '';
    const versionPanel = document.getElementById('version-panel');
    versionPanel.hidden = !current || !current.id;
    if (current && current.id) {
      await loadShares();
      await loadVersions();
    } else {
      document.getElementById('share-list').textContent = '';
      document.getElementById('version-list').textContent = '';
    }
  }

  async function loadShares() {
    const list = document.getElementById('share-list');
    const empty = document.getElementById('share-empty');
    list.textContent = '';
    if (!current || !current.id || !workspaceId()) return;
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取分享链接。'));
      return;
    }
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = item.revoked ? `已撤销 · ${item.prefix}…` : `有效 · ${item.prefix}…`;
      row.appendChild(meta);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares/${item.id}/revoke`, {});
          if (result.status !== 200) {
            show('error', messageFor(result.body.error, '撤销失败。'));
            return;
          }
          document.getElementById('share-once').hidden = true;
          document.getElementById('share-once').textContent = '';
          show('ok', '分享链接已撤销。');
          await loadShares();
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  function exportHref(revision) {
    const base = `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`;
    return revision ? `${base}/versions/${revision}/export` : `${base}/export`;
  }

  async function loadVersions() {
    const list = document.getElementById('version-list');
    const empty = document.getElementById('version-empty');
    list.textContent = '';
    if (!current || !current.id || !workspaceId()) return;
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/versions`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取版本历史。'));
      return;
    }
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = `修订 ${item.revision} · ${item.title || ''} · ${item.created_by || ''}`;
      row.appendChild(meta);
      const download = document.createElement('a');
      download.href = exportHref(item.revision);
      download.textContent = '导出';
      row.appendChild(download);
      if (item.revision !== current.revision) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.textContent = '恢复为新修订';
        restore.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/restore`, {
            revision: current.revision,
            to: item.revision,
          });
          if (result.status !== 200) {
            show('error', messageFor(result.body.error, '恢复失败。'));
            return;
          }
          current = result.body.artifact;
          fillEditor(current);
          show('ok', `已恢复为修订 ${current.revision}。`);
          await loadVersions();
        });
        row.appendChild(restore);
      }
      list.appendChild(row);
    }
  }

  async function loadList() {
    const id = workspaceId();
    if (!id) return;
    const listed = await request('GET', `/v1/workspaces/${id}/artifacts${listQuery(search.value)}`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取作品库。'));
      return;
    }
    allItems = listed.body.items || [];
    renderCatalog();
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = currentUser.username;
    const space = await request('GET', '/v1/workspaces?limit=100');
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = space.body.items || [];
    const previous = workspaceSelect.value;
    workspaceSelect.textContent = '';
    for (const item of workspaces) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    if (!workspaces.length) {
      allItems = [];
      document.getElementById('artifact-list').textContent = '';
      const emptyMessage = document.getElementById('list-empty-message');
      if (emptyMessage) emptyMessage.textContent = '还没有工作区。';
      renderCatalog();
      return;
    }
    const emptyMessage = document.getElementById('list-empty-message');
    if (emptyMessage) emptyMessage.textContent = '这个工作区还没有作品。';
    form.hidden = true;
    listPanel.hidden = false;
    await loadList();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  workspaceSelect.addEventListener('change', () => loadList());
  search.addEventListener('input', () => loadList());

  document.getElementById('new-artifact').addEventListener('click', () => {
    draftKind = 'document';
    closeNewMenu();
    openEditor({kind: 'document'});
  });

  document.getElementById('new-website').addEventListener('click', () => {
    draftKind = 'website';
    openEditor({kind: 'website'});
  });

  document.getElementById('new-media').addEventListener('click', () => {
    draftKind = 'media';
    document.getElementById('media-file').value = '';
    closeNewMenu();
    openEditor({kind: 'media'});
  });

  document.getElementById('new-board').addEventListener('click', () => {
    draftKind = 'whiteboard';
    boardState = {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
    closeNewMenu();
    openEditor({kind: 'whiteboard'});
  });

  function bindCreate(id, start) {
    const button = document.getElementById(id);
    if (button) button.addEventListener('click', start);
  }

  bindCreate('empty-new-document', () => {
    draftKind = 'document';
    openEditor({kind: 'document'});
  });

  const newMenuButton = document.getElementById('new-menu-button');
  if (newMenuButton) {
    newMenuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = document.getElementById('new-menu');
      if (!menu) return;
      const open = menu.hidden;
      menu.hidden = !open;
      newMenuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  document.addEventListener('click', (event) => {
    const wrap = document.querySelector('.new-menu-wrap');
    if (wrap && !wrap.contains(event.target)) closeNewMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNewMenu();
  });

  for (const button of document.querySelectorAll('.artifact-kinds [data-kind]')) {
    button.addEventListener('click', () => {
      catalogKind = button.getAttribute('data-kind') || 'all';
      for (const item of document.querySelectorAll('.artifact-kinds [data-kind]')) {
        if (item.getAttribute('data-kind') === catalogKind) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
      renderCatalog();
    });
  }
  for (const button of document.querySelectorAll('.artifact-scopes [data-scope]')) {
    if (button.disabled) continue;
    button.addEventListener('click', () => {
      catalogScope = button.getAttribute('data-scope') || 'all';
      for (const item of document.querySelectorAll('.artifact-scopes [data-scope]')) {
        if (item.getAttribute('data-scope') === catalogScope) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
      renderCatalog();
    });
  }

  document.getElementById('cancel-editor').addEventListener('click', async () => {
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    await loadList();
  });

  async function uploadMedia(path, extraFields) {
    const file = document.getElementById('media-file').files[0];
    const title = form.elements.title.value.trim();
    if (!title) {
      show('error', '请填写标题。');
      return null;
    }
    if (!file && !(current && current.id)) {
      show('error', '请选择一个媒体文件。');
      return null;
    }
    if (!file && current && current.id) {
      return request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                     {revision: current.revision, changes: {title}});
    }
    const body = new FormData();
    body.append('title', title);
    body.append('kind', 'media');
    body.append('file', file);
    if (extraFields) Object.entries(extraFields).forEach(([key, value]) => body.append(key, value));
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (!(current && current.id)) headers['Idempotency-Key'] = idempotencyKey();
    const response = await fetcher(path, {method: 'POST', headers, credentials: 'same-origin', body});
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!workspaceId()) {
      show('error', '先选择一个工作区。');
      return;
    }
    const title = form.elements.title.value.trim();
    const body = form.elements.body.value;
    const kind = (current && current.kind) || draftKind;
    if (!title) {
      show('error', '请填写标题。');
      return;
    }
    let result;
    if (kind === 'media') {
      result = await uploadMedia(
        current && current.id
          ? `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/file`
          : `/v1/workspaces/${workspaceId()}/artifacts`,
        current && current.id ? {revision: String(current.revision)} : null,
      );
      if (!result) return;
    } else if (kind === 'whiteboard') {
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, board: boardState}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'whiteboard', board: boardState},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (current && current.id) {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                             {revision: current.revision, changes: {title, body}});
    } else {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                             {title, body, kind},
                             {'Idempotency-Key': idempotencyKey()});
    }
    if (result.status === 409) {
      show('error', '文档已在别处更新，或标题已被占用，请重新打开后再保存。');
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.artifact;
    draftKind = current.kind || draftKind;
    fillEditor(current);
    document.getElementById('remove-artifact').hidden = false;
    document.getElementById('share-panel').hidden = false;
    show('ok', '已保存。');
    await loadShares();
  });

  document.getElementById('remove-artifact').addEventListener('click', async () => {
    if (!current || !current.id || !workspaceId()) return;
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    show('ok', '已删除。');
    await loadList();
  });

  const canvas = document.getElementById('board-canvas');
  canvas.addEventListener('pointerdown', event => {
    if (document.getElementById('board-editor').hidden) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const color = document.getElementById('board-color').value || '#111111';
    if (boardTool === 'text') {
      const text = globalThis.prompt('文字', '');
      if (text) {
        boardState.strokes = boardState.strokes.concat([{id: strokeId(), type: 'text', color, x: point[0], y: point[1], size: 16, text: text.slice(0, 200)}]);
        drawBoard();
      }
      return;
    }
    drawing = {id: strokeId(), type: boardTool, color, width: 2, x: point[0], y: point[1], points: [point]};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    if (drawing.type === 'path') drawing.points.push(point);
    else {
      drawing.width = Math.max(1, point[0] - drawing.x);
      drawing.height = Math.max(1, point[1] - drawing.y);
    }
    const live = boardState.strokes.concat([drawing]);
    const saved = boardState.strokes;
    boardState.strokes = live;
    drawBoard();
    boardState.strokes = saved;
  });
  canvas.addEventListener('pointerup', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    let stroke = drawing;
    if (drawing.type === 'path') {
      drawing.points.push(point);
      if (drawing.points.length >= 2) stroke = {id: drawing.id, type: 'path', color: drawing.color, width: 2, points: drawing.points};
      else stroke = null;
    } else {
      stroke = {id: drawing.id, type: 'rect', color: drawing.color, x: drawing.x, y: drawing.y, width: Math.max(1, point[0] - drawing.x), height: Math.max(1, point[1] - drawing.y)};
    }
    drawing = null;
    if (stroke) boardState.strokes = boardState.strokes.concat([stroke]);
    drawBoard();
  });
  document.getElementById('board-draw').addEventListener('click', () => { boardTool = 'path'; });
  document.getElementById('board-rect').addEventListener('click', () => { boardTool = 'rect'; });
  document.getElementById('board-text').addEventListener('click', () => { boardTool = 'text'; });
  document.getElementById('board-clear').addEventListener('click', () => {
    boardState.strokes = [];
    drawBoard();
  });

  document.getElementById('create-share').addEventListener('click', async () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再创建分享链接。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares`, {});
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法创建分享链接。'));
      return;
    }
    const share = result.body.share || {};
    const once = document.getElementById('share-once');
    once.hidden = false;
    once.textContent = share.path ? ('链接只显示一次：' + share.path) : '链接已创建，请立即复制。';
    show('ok', '已创建只读分享链接，完整地址只显示这一次。');
    await loadShares();
  });

  document.getElementById('export-artifact').addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再导出。');
      return;
    }
    globalThis.location.assign(exportHref());
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    current = null;
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
