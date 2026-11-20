export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;

const MEDIA_TYPES = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', m4a:'audio/mp4',
};

function fileType(file) {
  const extension = file.name.toLowerCase().split('.').at(-1);
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : file.type;
}
const formatBytes = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB'
  : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';

function mediaElement(document, mime, url, title, pending) {
  if (!url) return null;
  if (mime?.startsWith('image/')) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = title;
    if (!pending) image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }
  if (mime?.startsWith('video/') || mime?.startsWith('audio/')) {
    const media = document.createElement(mime.startsWith('video/') ? 'video' : 'audio');
    media.src = url;
    media.controls = !pending;
    media.preload = pending ? 'metadata' : 'none';
    media.playsInline = true;
    media.setAttribute('aria-label', title);
    return media;
  }
  return null;
}

export function renderChatFile(document, attachment, {pending = false} = {}) {
  const card = document.createElement('article');
  card.className = 'chat-file';
  const title = attachment.title || '附件';
  const media = mediaElement(document, attachment.mime, attachment.path, title, pending);
  if (media) card.append(media);
  const details = document.createElement('div');
  details.className = 'chat-file-details';
  const info = document.createElement('span');
  info.className = 'chat-file-info';
  const name = document.createElement('strong');
  name.textContent = title;
  info.append(name);
  if (Number.isSafeInteger(attachment.bytes)) {
    const size = document.createElement('small');
    size.textContent = formatBytes(attachment.bytes);
    info.append(size);
  }
  details.append(info);
  if (!pending && attachment.path) {
    const link = document.createElement('a');
    link.href = attachment.path + (attachment.bytes === undefined ? '' : '?download=1');
    if (attachment.bytes !== undefined) link.download = title;
    link.textContent = '下载';
    link.setAttribute('aria-label', '下载' + title);
    details.append(link);
  }
  card.append(details);
  return card;
}

function encodeFile(view, file) {
  return new Promise((resolve, reject) => {
    const reader = new view.FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function uploadFile(view, url, headers, data, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new view.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.timeout = 90_000;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.onload = () => resolve({status: xhr.status, body: xhr.response || {}});
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Upload interrupted'));
    xhr.send(JSON.stringify(data));
  });
}

function errorText(result) {
  const code = result.body?.error?.code;
  if (code === 'attachment_storage_full') return '附件存储空间已满。';
  if (code === 'attachment_type_blocked') return '文件格式不受支持，或内容与扩展名不符。';
  if (result.status === 413) return '文件太大，最大支持 8 MB。';
  if ([401, 403, 404].includes(result.status)) return '无法访问这段会话。';
  return '发送失败，点击重试。';
}

export function mountChatFiles(document, {context, ownerId, csrfToken, createKey, sent}) {
  const input = document.getElementById('chat-attachment');
  if (!input) return {render() {}, reset() {}};
  const view = document.defaultView;
  const messageList = document.getElementById('message-list');
  const empty = document.getElementById('chat-empty');
  const scroller = document.getElementById('message-scroller');
  const status = document.getElementById('chat-upload-error');
  const jobs = new Set();
  const make = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };

  function render() {
    const current = context();
    for (const job of jobs) {
      if (current?.scope === job.destination.scope) messageList.append(job.node);
      else job.node.remove();
    }
    if (messageList.children.length) empty.hidden = true;
  }

  function remove(job) {
    jobs.delete(job);
    job.node.remove();
    if (job.preview) view.URL.revokeObjectURL(job.preview);
    empty.hidden = messageList.children.length > 0;
  }

  async function drain() {
    const waiting = [...jobs].find(job => job.phase === 'waiting');
    if (!waiting || [...jobs].some(job => job.phase === 'sending')) return;
    const job = waiting;
    job.phase = 'sending';
    job.feedback.textContent = '正在上传…';
    job.progress.hidden = false;
    job.progress.value = 0;
    job.actions.hidden = true;
    try {
      const file = {title: job.file.name, mime: fileType(job.file), data: await encodeFile(view, job.file)};
      if (!jobs.has(job)) return;
      if (ownerId() !== job.destination.owner) {
        remove(job);
        return;
      }
      const result = await uploadFile(view, job.destination.path, {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-CSRF-Token': csrfToken(), 'Idempotency-Key': job.key,
      }, {attachment:file}, percentage => { job.progress.value = percentage; });
      if (!jobs.has(job)) return;
      if (![200, 201].includes(result.status) || !result.body?.message?.attachment) {
        throw new Error(errorText(result));
      }
      remove(job);
      sent(job.destination, result.body.message);
    } catch (error) {
      if (!jobs.has(job)) return;
      job.phase = 'failed';
      job.progress.hidden = true;
      job.feedback.textContent = error?.message === 'Upload interrupted' ? '连接中断，点击重试。'
        : error instanceof Error ? error.message : '发送失败，点击重试。';
      job.actions.hidden = false;
    } finally {
      void drain();
    }
  }

  function enqueue(file, destination) {
    const mime = fileType(file);
    const preview = mime?.startsWith('image/') || mime?.startsWith('video/') ? view.URL.createObjectURL(file) : '';
    const node = make('li');
    node.className = 'mine';
    node.dataset.filePending = '1';
    const card = renderChatFile(document, {title:file.name, bytes:file.size, mime, path:preview}, {pending:true});
    const feedback = make('p', '等待上传…');
    feedback.setAttribute('role', 'status');
    const progress = make('progress');
    progress.hidden = true;
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute('aria-label', '上传进度');
    const actions = make('div');
    actions.className = 'chat-file-actions';
    actions.hidden = true;
    const retry = make('button', '重试');
    const discard = make('button', '移除');
    retry.type = discard.type = 'button';
    const job = {destination, key:createKey(), file, preview, node, feedback, progress, actions, phase:'waiting'};
    retry.addEventListener('click', () => {
      job.phase = 'waiting';
      job.actions.hidden = true;
      job.feedback.textContent = '等待上传…';
      void drain();
    });
    discard.addEventListener('click', () => remove(job));
    actions.append(retry, discard);
    card.append(feedback, progress, actions);
    node.append(card);
    jobs.add(job);
  }

  input.addEventListener('change', () => {
    const destination = context();
    const picked = [...input.files];
    input.value = '';
    if (!destination || !picked.length) return;
    status.textContent = '';
    const accepted = picked.filter(file => file.size > 0 && file.size <= MAX_CHAT_FILE_BYTES);
    if (accepted.length !== picked.length) status.textContent = '空文件和超过 8 MB 的文件无法发送。';
    for (const file of accepted) enqueue(file, destination);
    render();
    if (accepted.length) scroller.scrollTop = scroller.scrollHeight;
    void drain();
  });
  return {render, reset() {
    for (const job of jobs) remove(job);
    status.textContent = '';
  }};
}
