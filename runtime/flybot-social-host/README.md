# FlyBot social host adapter (first slice)

OpenTeamily-authored (root MIT). This directory is **not** part of the
unmodified `runtime/ds-bot-upstream/` tree and is **not** a FlyBot
`core/` fork.

It sits between:

- the pinned upstream DS-Bot runtime (`runtime/ds-bot-upstream`, v0.3.6), and
- the imported `@flybot/social` plugin (`runtime/flybot/plugins/social`).

The plugin injects a `flybot` Cordis service that upstream DS-Bot does not
provide. This adapter builds that service as a façade over the upstream
runtime (`createRuntime`, `rt.botOf`, `rt.roomOf`, `rt.updateRoom`,
`rt.ledger`) without editing any vendored file.

Group chat follows upstream 0.3.5+ write-ahead ledger: each group room
`{id}` is the ledger book `group-{id}` (`<home>/ledger/group-{id}.jsonl`).
The adapter does not revive FlyBot's pre-ledger room log as the source of
truth.

## This slice proves

- The façade can be attached to a real `createRuntime()` host (CI, with
  DSH from the pin).
- `@flybot/social` `apply()` starts against that façade and registers its
  `social/server*` endpoints when no Bot Social server is configured.
- Group rooms listed by the façade are the upstream rooms, and ledger
  append/read uses the `group-{id}` book.

## Not in this slice

- A complete Bot Social onboarding / live server.
- Wiring into the management server or a redistributable image.
- Richer group/DM Teamily-parity flows (the first web slot host is in `runtime/flybot-web-slots/`).
- Remote-member semantics beyond passing `updateRoom({ remove })` for
  local Bots, and recording remote participant removals on the façade.

See `docs/upstream/GAPS.md` and `docs/upstream/INTEGRATION.md`.
