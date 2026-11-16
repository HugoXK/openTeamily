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
    faceId: room.faceId,
    ledgerBook: groupLedgerBook(room.id),
    participants: [
      ...(room.members ?? []).map(id => ({ kind: 'bot', id, remote: false, name: rt.botOf?.(id)?.name })),
      ...remotes.map(entry => ({ kind: entry.kind ?? 'bot', id: entry.id ?? entry.handle, handle: entry.handle, remote: true, name: entry.name })),
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
      publish() { return undefined },
      chats: { list() { return [] } },
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
    _handlers: handlers,
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
