# FlyBot web slots for dsh web

OpenTeamily-authored adapter. Upstream DS-Bot v0.3.6 has no `globalThis.__flybot__`
slot host, so `@flybot/social`'s browser half cannot register its UI by itself.

This package:

- installs `globalThis.__flybot__` (slot registry, `call()`, `canRetry`, name helpers)
- posts social endpoints to `POST /api/flybot` (same JSON shape as `POST /api/bot`,
  session-cookie authenticated, social/* only)
- bridges component slots onto dsh-web-app regions (`settings.section`,
  `conversation.composer.dock`, `conversation.session.header`, and when the
  profile accepts it, `sidebar.footer.action`)

The official ds-bot client bundle is **not** loaded as a second profile plugin:
the runtime wrapper already runs `createRuntime()` once.

Composer `@` rows from `flybot.composer.mention` are registered on the official
DSH `inputTriggers.registerSource` seam (the same contract unmodified ds-bot
v0.3.6 uses in `src/client/at-menu.js`). Tests use an in-process fake
`registerSource` only; they are not a live dsh-web or Teamily comparison.

The official ds-bot v0.3.6 details drawer (`src/client/details-drawer.js`)
has no slot for `flybot.bot.details`, so Bot Social details stay in the
FlyBot registry only. This adapter does not invent a drawer slot or edit
the vendored ds-bot tree.

`@openteamily/flybot-social-web` is a client-only DSH bundle that loads
`@flybot/social/client.js` after this host. Its server `apply()` is a no-op.

Not Teamily parity. Live Bot Social onboarding stays off (`onboard: false`).
