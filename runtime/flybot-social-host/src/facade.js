// FlyBot-shaped façade over an unmodified upstream DS-Bot runtime (v0.3.6+).
// The social plugin injects `flybot`; upstream ds-bot does not provide it.

export const groupLedgerBook = (roomId) => `group-${roomId}`

const listenersOf = (map, name) => {
  if (!map.has(name)) map.set(name, [])
  return map.get(name)
}

const presentRoom = (room, rt) => {
  if (!room) return undefined
  const remotes = Array.isArray(room.remoteParticipants) ? room.remoteParticipants : []
  return {
    id: room.id,
    name: room.name,
    members: [...(room.members ?? [])],
    mode: room.mode,
    admin: room.admin,
    origin: room.origin,
    faceId: room.faceId ?? room.face?.roomId,
    face: room.face,
    joinCode: room.joinCode ?? room.face?.joinCode,
    sharedFrom: room.sharedFrom,
    ledgerBook: groupLedgerBook(room.id),
    participants: [
      ...(room.members ?? []).map(id => ({ kind: 'bot', id, remote: false, name: rt.botOf?.(id)?.name })),
      ...remotes.map(entry => ({ kind: entry.kind ?? 'bot', id: entry.id ?? entry.handle, handle: entry.handle, remote: true, name: entry.name ?? entry.displayName })),
    ],
  }
}

const pluginFlag = (rt, id) => {
  const prefs = rt.state?.prefs
  const plugins = prefs?.plugins ?? prefs?.flybotPlugins
  if (plugins && Object.hasOwn(plugins, id)) return plugins[id] !== false
  return true
}

export function createFlybotFacade(rt, { fields } = {}) {
  const listeners = new Map()
  const handlers = new Map()
  const fieldStore = fields ?? new Map()
  const remoteByRoom = new Map()
  const grantStore = new Map()
  const sendHooks = []
  const transportMap = new Map()
  const toolList = []
  const chatLog = []
  const chatSendListeners = []
  const publishedRemotes = []
  const appliedFaceLines = new Map()
  const faceLineListeners = []
  const ticketPeers = []
  const lineSeq = new Map()
  let inviteServer
  let watching = false
  let roomApprovalProvider
  let chatApprovalProvider
  const approvalListeners = []

  const nextSeq = (roomId) => {
    const n = (lineSeq.get(roomId) ?? 0) + 1
    lineSeq.set(roomId, n)
    return n
  }

  const notifyFaceLine = (roomId, line, extra = {}) => {
    const room = presentRoom(roomRecord(roomId), rt)
    for (const listener of [...faceLineListeners]) {
      try { listener(room, line, extra) } catch { /* listener errors stay off the write path */ }
    }
  }


  const botSend = async (msg) => {
    if (flybot.readOnly()) return undefined
    const hooks = [...sendHooks].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    for (const hook of hooks) {
      const result = await hook.handle?.(msg)
      if (result !== undefined) return result
    }
    return undefined
  }
  botSend.use = (hook) => {
    if (!hook || typeof hook.handle !== 'function') return () => {}
    sendHooks.push(hook)
    return () => {
      const at = sendHooks.indexOf(hook)
      if (at !== -1) sendHooks.splice(at, 1)
    }
  }
  botSend.priority = { POLICY: 100, ROUTING: 400, APPROVAL: 900, TRANSPORT: 1000 }


  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener(payload)
  }

  const roomRecord = (roomId) => rt.roomOf?.(roomId) ?? rt.state?.rooms?.[roomId]

  const flybot = {
    api: {
      handle(name, fn, opts = {}) {
        handlers.set(name, { fn, opts })
        return () => { handlers.delete(name) }
      },
      async call(name, payload) {
        const entry = handlers.get(name)
        if (!entry) {
          const error = new Error(`Unknown FlyBot endpoint: ${name}`)
          error.code = 'bot/unknown-endpoint'
          throw error
        }
        return entry.fn(payload)
      },
    },
    pluginEnabled(id) {
      return pluginFlag(rt, id)
    },
    scope() {
      return flybot
    },
    warn(...args) {
      try { rt.warn?.(...args) } catch { /* optional */ }
    },
    readOnly() {
      const reason = rt.readOnly?.()
      return reason ? reason : false
    },
    async ready() {
      if (typeof rt.load === 'function') await rt.load()
    },
    on(name, listener) {
      listenersOf(listeners, name).push(listener)
      const offRt = typeof rt.on === 'function' ? rt.on(name, listener) : undefined
      return () => {
        const list = listeners.get(name)
        if (list) {
          const at = list.indexOf(listener)
          if (at !== -1) list.splice(at, 1)
        }
        offRt?.()
      }
    },
    emit,
    bot: {
      list() {
        return Object.values(rt.state?.bots ?? {})
      },
      get(id) {
        return rt.botOf?.(id) ?? rt.state?.bots?.[id]
      },
      find(query) {
        const list = flybot.bot.list()
        if (query == null || query === '') return undefined
        if (typeof query === 'object') {
          if (query.id) return flybot.bot.get(query.id)
          if (query.isMain) return list.find(bot => bot.isMain) ?? list[0]
          if (query.name) return list.find(bot => bot.name === query.name)
          return undefined
        }
        const text = String(query)
        return list.find(bot => bot.id === text || bot.name === text)
      },
      update: async (id, patch) => {
        if (flybot.readOnly()) return
        if (typeof rt.updateBot === 'function') return rt.updateBot(id, patch)
        const bot = flybot.bot.get(id)
        if (bot && patch && typeof patch === 'object') Object.assign(bot, patch)
        return bot
      },
      hasAnyGrant() {
        for (const grants of grantStore.values()) {
          if (grants.length > 0) return true
        }
        return false
      },
      send: botSend,
    },
    fields: {
      get(botId, key) {
        return fieldStore.get(botId)?.[key]
      },
      set(botId, key, value) {
        if (flybot.readOnly()) return
        const current = fieldStore.get(botId) ?? {}
        if (value === undefined) {
          delete current[key]
        } else {
          current[key] = value
        }
        fieldStore.set(botId, current)
      },
    },
    rooms: {
      list() {
        return Object.values(rt.state?.rooms ?? {}).map(room => presentRoom(room, rt))
      },
      ofFace(faceId) {
        if (faceId == null) return undefined
        return flybot.rooms.list().find(room => room.faceId === faceId || room.id === faceId)
      },
      async removeParticipant(roomId, participant = {}) {
        if (flybot.readOnly()) return
        const id = participant.id ?? participant.handle
        if (!id) return
        if (participant.remote) {
          const room = roomRecord(roomId)
          if (room) {
            room.remoteParticipants = (room.remoteParticipants ?? []).filter(entry => (entry.id ?? entry.handle) !== id)
          }
          const extra = remoteByRoom.get(roomId) ?? []
          remoteByRoom.set(roomId, extra.filter(entry => (entry.id ?? entry.handle) !== id))
          return
        }
        if (typeof rt.updateRoom === 'function') {
          return rt.updateRoom(roomId, { remove: [id] })
        }
        const room = roomRecord(roomId)
        if (room?.members) room.members = room.members.filter(member => member !== id)
      },
      async takeLineSeq(roomId) {
        if (flybot.readOnly() || !roomId) return undefined
        return nextSeq(roomId)
      },
      postNotice(roomId, text) {
        if (flybot.readOnly() || !roomId) return undefined
        const record = { seq: nextSeq(roomId), kind: 'notice', authorKind: 'system', text: String(text ?? '') }
        flybot.ledger.append(roomId, record)
        return record
      },
      postHuman(roomId, line = {}) {
        if (flybot.readOnly() || !roomId) return undefined
        const record = {
          seq: nextSeq(roomId),
          kind: 'message',
          authorKind: 'human',
          remote: false,
          text: String(line.text ?? ''),
          ...(line.authorId ? { authorId: line.authorId } : {}),
          ...(line.name ? { name: line.name } : {}),
          ...(line.mentions ? { mentions: line.mentions } : {}),
          ...(line.attested === true ? { attested: true } : {}),
        }
        flybot.ledger.append(roomId, record)
        notifyFaceLine(roomId, record, { mentions: line.mentions ?? [] })
        return record
      },
      postRemote(roomId, line = {}) {
        if (flybot.readOnly() || !roomId) return undefined
        const record = {
          seq: nextSeq(roomId),
          kind: 'message',
          authorKind: 'bot',
          remote: true,
          text: String(line.text ?? ''),
          ...(line.handle ? { handle: line.handle, authorId: line.handle } : {}),
          ...(line.name ? { name: line.name } : {}),
        }
        flybot.ledger.append(roomId, record)
        return record
      },
      async upsertFace(spec = {}) {
        if (flybot.readOnly()) return undefined
        const faceId = spec.roomId
        if (faceId == null && spec.localId == null) return undefined
        const existing = (spec.localId && roomRecord(spec.localId))
          || Object.values(rt.state?.rooms ?? {}).find(room => room.faceId === faceId || room.face?.roomId === faceId)
        const localId = existing?.id ?? spec.localId ?? `face-${String(faceId ?? Date.now())}`
        if (!rt.state.rooms) rt.state.rooms = {}
        const remotes = (spec.members ?? []).map((member) => ({
          kind: 'bot',
          remote: true,
          id: member.handle,
          handle: member.handle,
          name: member.displayName ?? member.label ?? member.name,
          displayName: member.displayName,
          ownerName: member.ownerName,
          roomOnly: member.roomOnly === true,
          ...(member.role ? { role: member.role } : {}),
        }))
        const locals = (spec.localBots ?? []).map((bot) => bot.id ?? bot).filter(Boolean)
        const face = {
          ...(existing?.face ?? {}),
          roomId: faceId ?? existing?.face?.roomId,
          status: spec.status ?? existing?.face?.status ?? 'open',
          ...(spec.joinCode ? { joinCode: spec.joinCode } : {}),
          ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
          ...(spec.startedAt ? { startedAt: spec.startedAt } : {}),
          ...(spec.createdAt ? { createdAt: spec.createdAt } : {}),
          ...(spec.lead ? { lead: spec.lead } : {}),
        }
        const room = existing ?? { id: localId, members: [], mode: 'admin', named: true }
        room.id = localId
        if (spec.name) room.name = spec.name
        else if (!room.name) room.name = 'Face-to-face'
        room.origin = 'face-to-face'
        room.faceId = face.roomId
        room.face = face
        if (spec.joinCode) room.joinCode = spec.joinCode
        if (locals.length) room.members = [...new Set([...(room.members ?? []), ...locals])]
        if (spec.members) room.remoteParticipants = remotes
        rt.state.rooms[localId] = room
        return presentRoom(room, rt)
      },
      applyFaceLine(roomId, line) {
        if (!roomId || !line) return undefined
        if (!appliedFaceLines.has(roomId)) appliedFaceLines.set(roomId, new Map())
        const book = appliedFaceLines.get(roomId)
        const key = line.eventId
        if (key && book.has(key)) return undefined
        if (key) book.set(key, line)
        return line
      },
      async dropFace(roomId) {
        if (flybot.readOnly() || !roomId) return
        const room = roomRecord(roomId)
        if (!room) return
        room.face = { ...(room.face ?? {}), status: 'left' }
        appliedFaceLines.delete(roomId)
        return presentRoom(room, rt)
      },
      onFaceLine(fn) {
        if (typeof fn !== 'function') return () => {}
        faceLineListeners.push(fn)
        return () => {
          const at = faceLineListeners.indexOf(fn)
          if (at !== -1) faceLineListeners.splice(at, 1)
        }
      },
      ticketPeers() {
        return [...ticketPeers]
      },
      serveInvites(handlers) {
        inviteServer = handlers
        return () => { if (inviteServer === handlers) inviteServer = undefined }
      },
      async seatOpenClaims() {
        return inviteServer?.claim ? undefined : undefined
      },
    },
    ledger: {
      book: groupLedgerBook,
      records(roomId) {
        return rt.ledger?.records?.(groupLedgerBook(roomId)) ?? []
      },
      append(roomId, record) {
        if (flybot.readOnly()) return undefined
        return rt.ledger?.append?.(groupLedgerBook(roomId), record)
      },
    },
    approvals: {
      onChange() {
        return () => {}
      },
    },
    grants: {
      of(botId) {
        return [...(grantStore.get(botId) ?? [])]
      },
      has(botId, grantee) {
        const handle = String(grantee ?? '')
        if (!handle) return false
        return (grantStore.get(botId) ?? []).some((grant) => (
          grant.grantee === handle || grant.member === handle || grant.home === handle
        ))
      },
      async set(botId, grants) {
        if (flybot.readOnly()) return
        grantStore.set(botId, Array.isArray(grants) ? [...grants] : [])
      },
    },
    remote: {
      publish(list) {
        if (Array.isArray(list)) publishedRemotes.splice(0, publishedRemotes.length, ...list)
        return [...publishedRemotes]
      },
      chats: {
        list() {
          return [...chatLog]
        },
        onSend(fn) {
          if (typeof fn !== 'function') return () => {}
          chatSendListeners.push(fn)
          return () => {
            const at = chatSendListeners.indexOf(fn)
            if (at !== -1) chatSendListeners.splice(at, 1)
          }
        },
        async deliver(msg) {
          if (flybot.readOnly()) return undefined
          const entry = { ...(msg && typeof msg === 'object' ? msg : { text: String(msg ?? '') }) }
          chatLog.push(entry)
          flybot.emit?.('remote.chat', entry)
          return entry
        },
      },
    },
    transports: {
      add(name, impl) {
        transportMap.set(name, impl)
        return () => { transportMap.delete(name) }
      },
      get(name) {
        return transportMap.get(name)
      },
    },
    tools: {
      register(def) {
        if (!def) return () => {}
        toolList.push(def)
        return () => {
          const at = toolList.indexOf(def)
          if (at !== -1) toolList.splice(at, 1)
        }
      },
      list() {
        return [...toolList]
      },
    },
    watched() {
      return watching === true
    },
    setWatched(value) {
      watching = value === true
    },
    roomApprovals: {
      setProvider(fn) {
        roomApprovalProvider = typeof fn === 'function' ? fn : undefined
      },
      changed() {
        for (const listener of [...approvalListeners]) listener('room')
      },
      of(room) {
        return roomApprovalProvider?.(room) ?? []
      },
    },
    chatApprovals: {
      setProvider(fn) {
        chatApprovalProvider = typeof fn === 'function' ? fn : undefined
      },
      changed() {
        for (const listener of [...approvalListeners]) listener('chat')
      },
      of(bot) {
        return chatApprovalProvider?.(bot) ?? []
      },
    },
    _handlers: handlers,
  }
  flybot.approvals.onChange = (fn) => {
    if (typeof fn !== 'function') return () => {}
    approvalListeners.push(fn)
    return () => {
      const at = approvalListeners.indexOf(fn)
      if (at !== -1) approvalListeners.splice(at, 1)
    }
  }
  return flybot
}

export function attachFlybot(rt, ctx) {
  const flybot = createFlybotFacade(rt)
  if (!ctx) return flybot
  // Real DSH/cordis contexts reject `ctx.set('flybot', …)` unless the service
  // was declared with provide(). Host unit tests use a plain `set` mock.
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('flybot', flybot)
    } catch {
      try { ctx.provide('flybot') } catch { /* already declared */ }
      if (typeof ctx.set === 'function') ctx.set('flybot', flybot)
    }
  } else if (typeof ctx.set === 'function') {
    ctx.set('flybot', flybot)
  }
  if (ctx.flybot === undefined) ctx.flybot = flybot
  return flybot
}
