# OpenTeamily notes for the FlyBot runtime snapshot

This is a **minimal needed set**, not a full FlyBot checkout. Upstream layout is
kept for the imported packages so `core/` and `plugins/social` stay internally
consistent. It is not wired to the management server, and it is not a
redistributable container image.

## Present

- `core/` — runtime package (host + client sources + tests)
- `plugins/social/` — Bot Social plugin
- `docker/` — instance entrypoint / health / profile helpers
- Selected runtime docs listed in `ORIGIN.md`

## Absent on purpose

- `plugins/project`, `plugins/timeline`, `plugins/tree`, `plugins/workflow`
- `ds-bot/` and `patches/` (runtime is `core/`; we are not reproducing the patch pipeline)
- Official `Dockerfile` and `compose.yaml` (they pack excluded plugins and require DSH)
- ThinkFlowLab automation, benches, evals, interop, live-e2e, reports, logos, QR
- `core/scripts/install-doctor.mjs` (it requires the unimported plugins)

`core/src/host/plugins.js` still *names* those plugins. Naming is not an import.
Settings that would load `@flybot/tree` / `workflow` / `project` / `timeline`
from this snapshot have nothing to load. Do not document them as installed.

## Runnable today vs. blocked

- License and file hashes can be verified offline.
- `core` and social tests need DeepSeek Harness (`core/dev/harness`); it is not
  imported and must not be installed to claim a pass in this change.
- Docker build / `dsh web` / real container acceptance are out of scope.

See [`docs/upstream/INTEGRATION.md`](../../docs/upstream/INTEGRATION.md) and
[`docs/upstream/GAPS.md`](../../docs/upstream/GAPS.md).
