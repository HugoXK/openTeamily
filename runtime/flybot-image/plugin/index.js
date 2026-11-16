// DSH plugin entry for the OpenTeamily FlyBot runtime image.
// Boots the unmodified upstream ds-bot runtime, then attaches the FlyBot social
// façade. This file must keep living at runtime/flybot-image/plugin/ so the
// relative imports into the vendored trees resolve. Do not copy it out of this
// layout; the image profile uses a link: dependency to this directory.
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { applyOnRuntime } from '../../flybot-social-host/index.js'
import { registerFlybotRoute } from '../../flybot-web-slots/index.js'

// Same inject list as runtime/ds-bot-upstream/ds-bot/index.js — this plugin
// stands in for ds-bot in the web profile so createRuntime runs once.
export const name = 'openteamily-flybot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  const rt = createRuntime(ctx, config)
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 15_000,
    facePollMs: 4_000,
    presence: true,
    onboard: false,
    ...(config.social ?? {}),
  })
  registerFlybotRoute(ctx, attached.flybot)
  return attached
}

export { createRuntime }
