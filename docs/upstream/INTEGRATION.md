# Management integration (explicitly not done in this import)

Target architecture, unchanged: one **management server** plus **FlyBot
containers**. Bot Social functionality should later be configured, authorized,
and bounded by that management plane. It must not be shipped as a required
extra control plane that operators have to run and secure by hand as a
separate product.

## Current state

| Layer | In tree | Integrated with `openteamily/` / `manager/`? |
| --- | --- | --- |
| Management auth, workspaces, instance jobs, fake/simulated runtime | Yes (already on `main`) | n/a |
| FlyBot customization source | `runtime/flybot/plugins/social`, `docker/` helpers | **No.** The runtime baseline is upstream DS-Bot v0.3.6 (PR #21), not a vendored FlyBot `core/` fork. Lifecycle jobs do not build or start this tree. |
| Bot Social source | `services/bot-social` | **No.** No management routes or secrets handling were added. |
| `@flybot/social` | `runtime/flybot/plugins/social` | **No.** Still uses upstream server-config / onboard APIs. |

Keeping the snapshots as **optional modules** is intentional.

## Later integration sketch (not implemented)

1. **FlyBot container:** an allowlisted manager starts a compose project that
   packs only imported packages (`core/`, `@flybot/social`) plus a future
   OpenTeamily-owned image recipe. Do not revive the official upstream
   Dockerfile that packs excluded plugins. Web/API still must not mount the
   Docker socket or accept arbitrary images, commands, or mounts. Image build
   remains blocked on the DSH/base-image gaps in [GAPS.md](GAPS.md).
2. **Instance login** stays the instance's own session, not a management-DB
   plaintext token.
3. **Bot Social:** management records an optional collaboration endpoint and
   policy. Connector tokens remain on the instance volume. Operators should not
   have to log into a second admin UI as a hard dependency.
4. **Tree / workflow / project / timeline:** only after a dedicated import as
   in [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md).

Until those steps land, do not describe OpenTeamily as running FlyBot
containers from this snapshot or providing Bot Social collaboration.
