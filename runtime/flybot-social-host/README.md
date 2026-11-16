# FlyBot social host adapter

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

## This slice also proves

- Live Bot Social onboarding against an in-process fake server that issues
  only `ot-fake-` tokens: first start writes mode 0600 credentials, the token
  does not appear in logs, a second start does not onboard again, and a torn
  credentials file is refused rather than replaced.
- Richer group/DM façade flows on the v0.3.6 ledger: notices, human and
  remote lines, face-to-face upsert/apply/drop, inbound DM deliver, and
  approval/invite hooks.

## Not in this slice

- Wiring the Bot Social server URL through the management server, or a
  redistributable public image (issue #3).
- Composer `@` mentions and the Bot details drawer in the official
  ds-bot / dsh web client.
- Full Teamily-parity group/DM comparison (the façade now posts group
  lines to the write-ahead ledger, hosts face-to-face rooms, and lists
  inbound DMs; that is not a Teamily comparison).

See `docs/upstream/GAPS.md` and `docs/upstream/INTEGRATION.md`.
