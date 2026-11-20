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
import { attachRuntime } from '../../openteamily-web/src/host.js'

// Same inject list as runtime/ds-bot-upstream/ds-bot/index.js — this plugin
// stands in for ds-bot in the web profile so createRuntime runs once.
export const name = 'openteamily-flybot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  const rt = createRuntime(ctx, config)
  // OpenTeamily features (@openteamily/web) execute on this same DS-Bot runtime.
  attachRuntime({ rt, ctx })
  const collaboration = loadBotSocialConfig()
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 15_000,
    facePollMs: 4_000,
    presence: true,
    ...(collaboration.server ? {
      server: collaboration.server,
      ...(collaboration.displayName ? { displayName: collaboration.displayName } : {}),
    } : {}),
    ...(config.social ?? {}),
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
    attachRuntime({ rt, ctx, chatTurn, mainBot })
  }
  return attached
}

export { createRuntime }
