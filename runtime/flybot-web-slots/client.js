// dsh web client entry. Installs globalThis.__flybot__ as soon as this module
// is evaluated, then (when DSH provides ctx.slots) bridges FlyBot slots into
// the official dsh-web-app regions. Do not edit the vendored ds-bot client.
import { attachBridge } from './src/bridge.js'
import { installFlybotHost } from './src/host.js'

installFlybotHost()

export const inject = ['slots']

export function apply(ctx) {
  const host = installFlybotHost()
  if (ctx?.slots) return attachBridge(ctx.slots, host.slots)
}

if (typeof globalThis !== 'undefined' && globalThis.__ModuleLoader__?.load) {
  globalThis.__ModuleLoader__.load({
    id: '@openteamily/flybot-web-slots',
    inject: ['slots'],
    factory(_require, ctx) {
      const host = installFlybotHost()
      const slots = ctx?.slots
      if (slots) attachBridge(slots, host.slots)
      return host
    },
  })
}
