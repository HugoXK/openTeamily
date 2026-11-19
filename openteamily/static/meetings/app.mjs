function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatTime(seconds) {
  if (!seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function inputTime(seconds) {
  const date = seconds ? new Date(Number(seconds) * 1000) : new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseAttendees(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[,，]/)) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export const MEMBER_ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};
export const ATTENDEE_EMPTY = '无匹配成员';
export const ATTENDEE_UNAVAILABLE = '读不到成员列表';
export const ATTENDEE_MIN = 2;
export const ATTENDEE_LIMIT = 6;

export function attendeeQuery(text) {
  const parts = String(text || '').split(/[,，]/);
  return parts[parts.length - 1].trim();
}

export function matchMembers(members, query, used) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < ATTENDEE_MIN) return [];
  const taken = new Set(parseAttendees(used).map(name => name.toLowerCase()));
  return (members || [])
    .filter(item => item && item.username && !taken.has(String(item.username).toLowerCase()))
    .filter(item => String(item.username).toLowerCase().includes(needle))
    .slice(0, ATTENDEE_LIMIT);
}

export function attendeeInsert(text, username) {
  const parts = String(text || '').split(/[,，]/);
  parts[parts.length - 1] = ' ' + username;
  return parts.join(',').replace(/^\s+/, '').replace(/[\s,]+$/, '') + ', ';
}

async function request(method, path, body, extra) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('meeting-form');
  const workspaceSelect = document.getElementById('workspace');
  if (!status || !loginPanel || !mainPanel || !form) return;
  let current = null;
  let meetings = [];
  let actions = [];
  const attendeeInput = document.getElementById('meeting-attendees');
  const attendeeList = document.getElementById('attendee-matches');
  let memberCache = {workspace: '', items: [], failed: false};
  let attendeeActive = -1;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function base() {
    return `/v1/workspaces/${workspaceId()}/meetings`;
  }

  function hideAttendees() {
    attendeeActive = -1;
    attendeeList.hidden = true;
    attendeeList.replaceChildren();
  }

  async function workspaceMembers() {
    const id = workspaceId();
    if (!id) return [];
    if (memberCache.workspace === id) return memberCache.items;
    const result = await request('GET', `/v1/workspaces/${id}/members`);
    memberCache = result.status === 200
      ? {workspace: id, items: result.body.items || [], failed: false}
      : {workspace: id, items: [], failed: true};
    return memberCache.items;
  }

  function attendeeOptions() {
    return [...attendeeList.querySelectorAll('button[data-username]')];
  }

  function highlightAttendee(index) {
    const options = attendeeOptions();
    if (!options.length) {
      attendeeActive = -1;
      return;
    }
    attendeeActive = (index + options.length) % options.length;
    options.forEach((option, at) => {
      option.setAttribute('aria-selected', at === attendeeActive ? 'true' : 'false');
    });
  }

  function chooseAttendee(username) {
    attendeeInput.value = attendeeInsert(attendeeInput.value, username);
    hideAttendees();
    attendeeInput.focus();
  }

  function attendeeNote(text) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = text;
    attendeeList.append(li);
  }

  async function refreshAttendees() {
    const query = attendeeQuery(attendeeInput.value);
    if (query.length < ATTENDEE_MIN) {
      hideAttendees();
      return;
    }
    const members = await workspaceMembers();
    if (attendeeQuery(attendeeInput.value) !== query) return;
    attendeeList.replaceChildren();
    if (memberCache.failed) {
      attendeeNote(ATTENDEE_UNAVAILABLE);
    } else {
      const matches = matchMembers(members, query, attendeeInput.value);
      if (!matches.length) attendeeNote(ATTENDEE_EMPTY);
      for (const member of matches) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.username = member.username;
        button.textContent = `${member.username} · ${MEMBER_ROLE_LABELS[member.role] || member.role}` +
          (member.suspended ? ' · 已停用' : '');
        button.addEventListener('click', () => chooseAttendee(member.username));
        li.append(button);
        attendeeList.append(li);
      }
    }
    attendeeActive = -1;
    attendeeList.hidden = false;
  }

  function renderActions() {
    const holder = document.getElementById('action-list');
    holder.replaceChildren();
    actions.forEach((action, index) => {
      const row = document.createElement('div');
      row.className = 'action-row';
      const text = document.createElement('input');
      text.type = 'text';
      text.maxLength = 500;
      text.placeholder = '行动项';
      text.value = action.text || '';
      text.addEventListener('input', () => { action.text = text.value; });
      const owner = document.createElement('input');
      owner.type = 'text';
      owner.maxLength = 80;
      owner.placeholder = '负责人';
      owner.value = action.owner || '';
      owner.addEventListener('input', () => { action.owner = owner.value; });
      const done = document.createElement('label');
      done.className = 'action-done';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(action.done);
      box.addEventListener('change', () => { action.done = box.checked; });
      done.append(box, document.createTextNode('完成'));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        actions.splice(index, 1);
        renderActions();
      });
      row.append(text, owner, done, remove);
      holder.append(row);
    });
  }

  function renderList() {
    const list = document.getElementById('meeting-list');
    list.replaceChildren();
    document.getElementById('meetings-empty').hidden = meetings.length > 0;
    for (const meeting of meetings) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meeting-row';
      button.dataset.meeting = meeting.id;
      if (current && current.id === meeting.id) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = meeting.title;
      const meta = document.createElement('span');
      meta.className = 'preview';
      meta.textContent = formatTime(meeting.started_at) + ' · ' + (meeting.attendees || []).length + ' 人 · ' +
        meeting.done_count + '/' + meeting.action_count + ' 行动项';
      button.append(title, meta);
      li.append(button);
      list.append(li);
    }
  }

  function fill(meeting) {
    hideAttendees();
    current = meeting;
    form.hidden = false;
    document.getElementById('meeting-empty').hidden = true;
    document.getElementById('meeting-title').value = meeting ? meeting.title : '';
    document.getElementById('meeting-started-at').value = inputTime(meeting ? meeting.started_at : null);
    document.getElementById('meeting-attendees').value = meeting ? (meeting.attendees || []).join(', ') : '';
    document.getElementById('meeting-summary').value = meeting ? (meeting.summary || '') : '';
    document.getElementById('meeting-transcript').value = meeting ? (meeting.transcript || '') : '';
    actions = meeting ? (meeting.action_items || []).map(item => ({...item})) : [];
    renderActions();
    document.getElementById('remove-meeting').hidden = !meeting || !meeting.id;
    document.getElementById('meeting-meta').textContent = meeting && meeting.id
      ? '修订 ' + meeting.revision + ' · 创建者 ' + meeting.created_by : '新会议';
    renderList();
  }

  async function loadList(selectId) {
    const result = await request('GET', `${base()}?limit=100`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法加载会议。'));
      return;
    }
    meetings = result.body.items || [];
    renderList();
    if (selectId) {
      await openMeeting(selectId);
    } else if (meetings.length && !current) {
      await openMeeting(meetings[0].id);
    } else {
      fill(null);
    }
  }

  async function openMeeting(id) {
    const result = await request('GET', `${base()}/${id}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开会议。'));
      return;
    }
    fill(result.body.meeting);
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = session.body.user.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const previous = workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    if (!workspaces.length) {
      form.hidden = true;
      document.getElementById('meeting-empty').hidden = false;
      document.getElementById('meetings-empty').hidden = false;
      show('error', '还没有工作区。请先到聊天页创建。');
      return;
    }
    await loadList();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const title = document.getElementById('meeting-title').value.trim();
    const started = document.getElementById('meeting-started-at').value;
    const startedAt = Math.floor(new Date(started).getTime() / 1000);
    if (!title) { show('error', '请填写标题。'); return; }
    if (!Number.isFinite(startedAt)) { show('error', '请选择开始时间。'); return; }
    const changes = {
      title,
      started_at: startedAt,
      attendees: parseAttendees(document.getElementById('meeting-attendees').value),
      summary: document.getElementById('meeting-summary').value,
      transcript: document.getElementById('meeting-transcript').value,
      action_items: actions.filter(action => (action.text || '').trim()),
    };
    let result;
    if (current && current.id) {
      result = await request('POST', `${base()}/${current.id}`,
                             {revision: current.revision, changes});
    } else {
      const key = 'meeting-' + (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()));
      result = await request('POST', base(), changes, {'Idempotency-Key': key});
    }
    if (result.status === 409) {
      show('error', '会议已在别处更新，或标题已被占用。');
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    await loadList(result.body.meeting.id);
    show('ok', '会议已保存。');
  });

  attendeeInput.addEventListener('input', () => { refreshAttendees(); });

  attendeeInput.addEventListener('keydown', event => {
    if (attendeeList.hidden && event.key !== 'Escape') return;
    const options = attendeeOptions();
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive + 1);
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive - 1);
    } else if (event.key === 'Enter' && options.length) {
      event.preventDefault();
      chooseAttendee(options[attendeeActive >= 0 ? attendeeActive : 0].dataset.username);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideAttendees();
    }
  });

  document.getElementById('new-meeting').addEventListener('click', () => {
    if (!workspaceId()) { show('error', '请先选择工作区。'); return; }
    fill(null);
  });

  document.getElementById('add-action').addEventListener('click', () => {
    if (actions.length >= 50) return;
    actions.push({text: '', owner: '', done: false});
    renderActions();
  });

  document.getElementById('cancel-meeting').addEventListener('click', () => {
    fill(current);
  });

  document.getElementById('remove-meeting').addEventListener('click', async () => {
    if (!current || !current.id) return;
    const result = await request('POST', `${base()}/${current.id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    await loadList();
    show('ok', '会议已删除。');
  });

  document.getElementById('meeting-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-meeting]');
    if (button) await openMeeting(button.dataset.meeting);
  });

  workspaceSelect.addEventListener('change', () => {
    hideAttendees();
    memberCache = {workspace: '', items: [], failed: false};
    current = null;
    actions = [];
    form.hidden = true;
    loadList();
  });

  const login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/login', {
        username: login.elements.username.value,
        password: login.elements.password.value,
      });
      if (result.status !== 200) {
        show('error', messageFor(result.body && result.body.error, '无法登录。'));
        return;
      }
      login.reset();
      await load();
    });
  }

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      await request('POST', '/v1/auth/logout', {});
      await load();
    });
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
