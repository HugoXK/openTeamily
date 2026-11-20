// DSH plugin entry for the OpenTeamily FlyBot runtime image.
// Boots the unmodified upstream ds-bot runtime, then attaches the FlyBot social
// façade. This file must keep living at runtime/flybot-image/plugin/ so the
// relative imports into the vendored trees resolve. Do not copy it out of this
// layout; the image profile uses a link: dependency to this directory.
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { applyOnRuntime } from '../../flybot-social-host/index.js'
import { registerFlybotRoute } from '../../flybot-web-slots/index.js'
import { loadBotSocialConfig } from '../bot-social-config.js'
import { startBridge, runTurn } from '../ds-bot-bridge.mjs'
import { normalizeImportedSession } from '../../openteamily-web/features/agents/history.js'
import { attachRuntime } from '../../openteamily-web/src/host.js'

// Same inject list as runtime/ds-bot-upstream/ds-bot/index.js — this plugin
// stands in for ds-bot in the web profile so createRuntime runs once.
export const name = 'openteamily-flybot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  // Prepare is detached/read-only: no Session is entered, persisted or announced.
  // Install before core agent restoration, whose projections read old imports.
  normalizeImportedSession(ctx.sessions.prepare('openteamily-import-schema-' + globalThis.crypto.randomUUID()))
  const rt = createRuntime(ctx, config)
  // OpenTeamily features (@openteamily/web) execute on this same DS-Bot runtime.
  attachRuntime({ rt, ctx })
  const collaboration = loadBotSocialConfig()
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 15_000,
    facePollMs: 4_000,
    presence: true,
    ...(config.social ?? {}),
    ...(collaboration.server ? {
      server: collaboration.server,
      ...(collaboration.displayName ? { displayName: collaboration.displayName } : {}),
    } : {}),
  })
  registerFlybotRoute(ctx, attached.flybot)
  // OpenTeamily chat tasks run as DS-Bot turns on this runtime (see ds-bot-bridge.mjs).
  if (config.openteamilyBridge !== false && process.env.OPENTEAMILY_DS_BOT_BRIDGE !== '0') {
    const { bridge } = startBridge(rt, ctx)
    // Services for @openteamily/web features (chat, skills): native DS-Bot turns in
    // this user's own runtime, serialized with management tasks by bridge.exclusive.
    const chatTurn = (key, text, requestId) => bridge.exclusive(async () => {
      await bridge.setup()
      await bridge.selectConversation(key)
      return runTurn(rt, ctx, bridge.botId, text, requestId)
    })
    const mainBot = async () => { await bridge.setup(); return bridge.botId }
    const nativeTurn = (botId, sessionId, text, requestId) => bridge.exclusive(async () => {
      await bridge.setup()
      if (!rt.botOf(botId)) throw new Error('Mapped native Bot no longer exists')
      await rt.switchPart(botId, sessionId)
      await rt.applyModel(rt.botOf(botId), { force: true })
      return runTurn(rt, ctx, botId, text, requestId)
    })
    const textOnly = prompt => bridge.exclusive(async () => {
      await bridge.setup()
      const response = await fetch(bridge.baseURL + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.state.token },
        body: JSON.stringify({ model: 'openteamily-model', messages: [{ role: 'user', content: prompt }], stream: false }),
        signal: AbortSignal.timeout(170000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Text-only model inference failed')
      const data = await response.json(), text = data.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new Error('Text-only model returned no text')
      return text.slice(0, 20000)
    })
    attachRuntime({ rt, ctx, chatTurn, mainBot, nativeTurn, textOnly, exclusive: bridge.exclusive, legacySession: bridge.legacySession })
  }
  return attached
}

export { createRuntime }
