const POLL_MS = 900;
const typeLabel = kind => kind === 'video' ? '视频通话' : '语音通话';
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

export function mountChatCalls(document, {request, context} = {}) {
  const element = id => document.getElementById(id);
  const launcher = element('chat-call');
  if (!launcher) return {refresh() {}, sync() {}};
  const dialog = element('chat-call-dialog');
  const status = element('chat-call-status');
  const incoming = element('chat-call-incoming');
  const media = element('chat-call-media');
  const local = element('chat-call-local').querySelector('video');
  const peersNode = element('chat-call-peers');
  const play = element('chat-call-play');
  const mute = element('chat-call-mute');
  const camera = element('chat-call-camera');
  const close = element('chat-call-close');
  const choices = element('chat-call-choices');
  const startAudio = element('chat-call-start-audio');
  const startVideo = element('chat-call-start-video');
  const controls = element('chat-call-controls');
  const view = document.defaultView ?? globalThis;
  const setTimer = view.setTimeout?.bind(view) ?? globalThis.setTimeout;
  const clearTimer = view.clearTimeout?.bind(view) ?? globalThis.clearTimeout;
  let current = null;
  let available = null;
  let active = null;
  let joining = null;
  let readSequence = 0;
  let previewTimer;
  let watching = true;

  const currentKey = value => value ? value.wid + '/' + value.cid : '';
  const path = (scope, action = '') =>
    `/v1/workspaces/${scope.wid}/social/conversations/${scope.cid}/call${action && '/' + action}`;
  const payload = own => ({call_id: own.call.id, peer_id: own.id});
  const note = text => { status.textContent = text; };

  function renderLauncher() {
    launcher.hidden = !current;
    element('group-call-video').hidden = !current;
    element('group-call-audio').hidden = !current;
    incoming.hidden = !current || !available || Boolean(active);
    if (!incoming.hidden) element('chat-call-incoming-label').textContent = `${typeLabel(available.kind)}进行中`;
  }

  async function refresh() {
    const scope = current;
    if (!scope || active || joining) return;
    const sequence = ++readSequence;
    const result = await request('GET', path(scope)).catch(() => null);
    if (readSequence !== sequence || current !== scope || active || joining) return;
    if (result?.status !== 200) return;
    available = result.body.call;
    renderLauncher();
  }

  function watch() {
    clearTimer(previewTimer);
    if (!current || !watching) return;
    previewTimer = setTimer(async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      watch();
    }, 4000);
    previewTimer?.unref?.();
  }

  function stopLocal(own) {
    if (!own) return;
    clearTimer(own.timer);
    for (const peer of own.peers.values()) peer.connection.close();
    own.peers.clear();
    peersNode.replaceChildren();
    stopTracks(own.stream);
    local.srcObject = null;
    active = null;
    controls.hidden = true;
    media.hidden = true;
    play.hidden = true;
    close.textContent = '关闭';
    renderLauncher();
  }

  async function leave({dismiss = true} = {}) {
    const own = active;
    joining = null;
    if (dismiss && dialog.open) dialog.close();
    stopLocal(own);
    if (own) {
      await request('POST', path(own.scope, 'leave'), payload(own)).catch(() => {});
      if (currentKey(own.scope) === currentKey(current)) void refresh();
    }
  }

  function sync() {
    const next = context();
    if (currentKey(current) === currentKey(next)) return;
    readSequence++;
    if (dialog.open || active) void leave();
    current = next;
    available = null;
    renderLauncher();
    void refresh();
    watch();
  }

  function showDialog() {
    if (!current) return false;
    element('chat-call-conversation').textContent = current.title;
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function showChoices() {
    if (!showDialog() || active || joining) return;
    element('chat-call-title').textContent = '通话';
    choices.hidden = false;
    startAudio.disabled = false;
    startVideo.disabled = false;
    close.textContent = '关闭';
    note(available ? `正在进行${typeLabel(available.kind)}，可以加入。` : '');
  }

  function peerStatus(own) {
    if (active !== own) return;
    const count = own.peers.size;
    const connected = [...own.peers.values()].filter(peer => peer.connection.connectionState === 'connected').length;
    if (connected) note(`通话中 · ${connected + 1} 人`);
    else if (!count) note('等待其他成员加入…');
    else if ([...own.peers.values()].some(peer => ['failed', 'disconnected'].includes(peer.connection.connectionState))) {
      note(own.ice.some(server => /^turns?:/.test(server.urls))
        ? '连接未建立。可以挂断后重新加入。'
        : '连接未建立。跨网络通话可能需要管理员配置中继。');
    } else note('正在建立通话连接…');
  }

  function queueSignal(own, peer, signal) {
    const data = {...payload(own), to: peer.id, client_key: view.crypto.randomUUID(), ...signal};
    const send = async () => {
      if (active !== own || own.peers.get(peer.id) !== peer) return;
      const url = path(own.scope, 'signal');
      let result;
      try { result = await request('POST', url, data); }
      catch { result = await request('POST', url, data); }
      if (result.status !== 200 && result.status !== 404) throw new Error('Call signal was refused');
    };
    peer.outgoing = peer.outgoing.then(send).catch(() => {
      if (active === own) note('通话连接中断。可以挂断后重新加入。');
    });
    return peer.outgoing;
  }

  async function describePeer(own, peer, type) {
    const pc = peer.connection;
    await pc.setLocalDescription(type === 'offer' ? await pc.createOffer() : await pc.createAnswer());
    if (active !== own || own.peers.get(peer.id) !== peer) return;
    void queueSignal(own, peer, {description: pc.localDescription.toJSON()});
    peer.localReady = true;
    for (const candidate of peer.earlyLocal) void queueSignal(own, peer, {candidate});
    peer.earlyLocal.length = 0;
  }

  function createPeer(own, item) {
    const connection = new view.RTCPeerConnection({iceServers: own.ice});
    const tile = document.createElement('div');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.hidden = true;
    const name = document.createElement('span');
    name.textContent = item.name;
    tile.append(video, name);
    peersNode.append(tile);
    const peer = {id: item.id, tile, video, connection, outgoing: Promise.resolve(), localReady: false, earlyLocal: [], earlyRemote: []};
    own.peers.set(item.id, peer);
    connection.onconnectionstatechange = () => peerStatus(own);
    connection.ontrack = event => {
      if (active !== own) return;
      const stream = event.streams[0];
      if (!stream) return;
      video.srcObject = stream;
      video.hidden = !stream.getVideoTracks().length;
      video.play().catch(() => { if (active === own) play.hidden = false; });
    };
    connection.onicecandidate = event => {
      if (!event.candidate?.candidate || active !== own) return;
      const candidate = event.candidate.toJSON();
      if (peer.localReady) void queueSignal(own, peer, {candidate});
      else peer.earlyLocal.push(candidate);
    };
    for (const track of own.stream.getTracks()) connection.addTrack(track, own.stream);
    // The lower tab identifier sends the single initial offer for this pair.
    if (own.id < item.id) void describePeer(own, peer, 'offer').catch(() => peerStatus(own));
    return peer;
  }

  function syncPeers(own, call) {
    const wanted = new Set(call.peers.map(peer => peer.id));
    for (const [id, peer] of own.peers) {
      if (wanted.has(id)) continue;
      own.peers.delete(id);
      peer.connection.close();
      peer.tile.remove();
    }
    for (const item of call.peers) if (item.id !== own.id && !own.peers.has(item.id)) createPeer(own, item);
    peerStatus(own);
  }

  async function receive(own, signal) {
    const peer = own.peers.get(signal.from);
    if (!peer) return;
    const pc = peer.connection;
    if (signal.description) {
      if ((signal.description.type === 'offer') !== (own.id > peer.id)) return;
      await pc.setRemoteDescription(signal.description);
      for (const candidate of peer.earlyRemote.splice(0)) await pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') await describePeer(own, peer, 'answer');
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else peer.earlyRemote.push(signal.candidate);
    }
  }

  async function poll(own) {
    try {
      const result = await request('POST', path(own.scope, 'poll'), {...payload(own), after: own.cursor});
      if (active !== own) return;
      if ([401, 403, 404].includes(result.status)) {
        stopLocal(own);
        available = null;
        renderLauncher();
        note('通话已结束。');
        return;
      }
      if (result.status !== 200) throw new Error('Call poll failed');
      own.failures = 0;
      syncPeers(own, result.body.call);
      for (const signal of result.body.signals) {
        if (active !== own) return;
        try { await receive(own, signal); }
        catch { if (active === own) note('无法连接到部分成员。可以重新加入通话。'); }
        own.cursor = signal.seq;
      }
    } catch {
      if (active !== own) return;
      note('连接中断，正在重连…');
      if (++own.failures >= 4) {
        void leave({dismiss: false});
        note('暂时无法连接。关闭后可以重新加入。');
        return;
      }
    }
    if (active === own) own.timer = setTimer(() => poll(own), POLL_MS);
  }

  async function join(kind, {start = true} = {}) {
    if (!showDialog() || active || joining) return;
    const scope = current;
    const ticket = {scope};
    joining = ticket;
    kind = available?.kind || kind;
    choices.hidden = true;
    element('chat-call-title').textContent = typeLabel(kind);
    note(kind === 'video' ? '正在请求摄像头和麦克风权限…' : '正在请求麦克风权限…');
    let stream;
    let own;
    try {
      if (!view.navigator?.mediaDevices?.getUserMedia || typeof view.RTCPeerConnection !== 'function') {
        note('当前浏览器无法使用实时通话。请在支持通话的 HTTPS 页面打开。');
        return;
      }
      stream = await view.navigator.mediaDevices.getUserMedia({audio: true, video: kind === 'video'});
      if (joining !== ticket) return;
      note('正在加入通话…');
      const id = view.crypto.randomUUID();
      const data = {kind, start, peer_id: id};
      const url = path(scope, 'join');
      let result;
      try { result = await request('POST', url, data); }
      catch { result = await request('POST', url, data); }
      if (result.status !== 200) {
        const code = result.body?.error?.code;
        if (joining === ticket) note(code === 'call_full' ? '通话已达到 6 人上限。'
          : code === 'call_already_joined' ? '此账号已经在另一个标签页加入通话。'
          : code === 'call_ended' ? '通话已结束。' : '无法加入通话，请重试。');
        return;
      }
      own = {scope, id: result.body.peer_id, call: result.body.call, ice: result.body.ice_servers,
        stream, peers: new Map(), cursor: 0, failures: 0, timer: null};
      if (joining !== ticket) {
        void request('POST', path(scope, 'leave'), payload(own)).catch(() => {});
        return;
      }
      active = own;
      available = null;
      renderLauncher();
      controls.hidden = false;
      media.hidden = false;
      local.srcObject = stream;
      local.hidden = !stream.getVideoTracks().length;
      camera.hidden = local.hidden;
      camera.setAttribute('aria-pressed', 'true');
      camera.textContent = '关闭摄像头';
      mute.setAttribute('aria-pressed', 'false');
      mute.textContent = '静音';
      close.textContent = '挂断';
      syncPeers(own, own.call);
      void poll(own);
    } catch (error) {
      if (joining !== ticket) return;
      if (active === own) void leave({dismiss: false});
      note(error?.name === 'NotAllowedError' ? '使用通话需要允许麦克风或摄像头。'
        : error?.name === 'NotFoundError' ? '找不到可用的麦克风或摄像头。'
        : '无法开始通话，请重试。');
    } finally {
      if (!own || active !== own) stopTracks(stream);
      if (joining === ticket) {
        joining = null;
        if (!active) choices.hidden = false;
      }
    }
  }

  launcher.addEventListener('click', () => available ? void join(available.kind, {start: false}) : showChoices());
  element('group-call-video').addEventListener('click', () => join('video'));
  element('group-call-audio').addEventListener('click', () => join('audio'));
  element('chat-call-join').addEventListener('click', () => available && join(available.kind, {start: false}));
  startAudio.addEventListener('click', () => join('audio', {start: !available}));
  startVideo.addEventListener('click', () => join('video', {start: !available}));
  close.addEventListener('click', () => leave());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void leave(); });
  mute.addEventListener('click', () => {
    if (!active) return;
    const muted = mute.getAttribute('aria-pressed') !== 'true';
    active.stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
    mute.setAttribute('aria-pressed', String(muted));
    mute.textContent = muted ? '取消静音' : '静音';
  });
  camera.addEventListener('click', () => {
    if (!active) return;
    const enabled = camera.getAttribute('aria-pressed') !== 'true';
    active.stream.getVideoTracks().forEach(track => { track.enabled = enabled; });
    camera.setAttribute('aria-pressed', String(enabled));
    camera.textContent = enabled ? '关闭摄像头' : '开启摄像头';
  });
  play.addEventListener('click', async () => {
    if (!active) return;
    await Promise.allSettled([...active.peers.values()].map(peer => peer.video.play()));
    play.hidden = true;
  });
  view.addEventListener?.('pagehide', () => {
    const own = active;
    watching = false;
    clearTimer(previewTimer);
    if (own) {
      view.navigator?.sendBeacon?.('/b/api/openteamily', new Blob([JSON.stringify({
        endpoint: 'messenger/v1', payload: {method: 'POST', path: path(own.scope, 'leave'), body: payload(own)},
      })], {type: 'application/json'}));
      stopLocal(own);
    }
    joining = null;
  });
  view.addEventListener?.('pageshow', () => { watching = true; void refresh(); watch(); });
  return {sync, refresh};
}
