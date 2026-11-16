# Dependency graph (needed set)

Evidence: public FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2` and
Bot Social `@8706824f53f6cce8212470bc6b442f7271cccd3e`. Plugin packages do not
import one another. Core lists known plugin IDs in `core/src/host/plugins.js`;
that catalog is not a JavaScript import.

```
OpenTeamily management server (openteamily/, manager/)
        |  not wired in this change
        v
runtime/flybot/core     (agent host, client, store, plugin API)
        |
        +-- plugins/social  -- HTTP/MCP protocols -->  services/bot-social
        |
        +-- docker helpers (entrypoint, health, profile, web.patch)
        |
        +-- NOT imported peer: @deepseek-ai/dsh and @deepseek-ai/dsh-*
        +-- NOT imported optional plugins: tree, workflow, project, timeline
```

## First-import decisions

| Unit | In this import? | Why |
| --- | --- | --- |
| `core/` | Yes — needed runtime | Agent host, UI client sources, store, plugin API. Required for a later FlyBot container. |
| `ds-bot/` + `patches/` | **No** | Regeneration pipeline only. The runnable package is already `core/`. |
| `@flybot/social` | Yes | Only FlyBot plugin on the Bot Social protocol path (`POST /v1/onboard/flybot` and related APIs). |
| Bot Social service | Yes, **optional module** | Onboard, invite, approval, grants, rooms. Not a mandatory third production control plane. |
| `@flybot/tree`, `@flybot/workflow` | **No** (optional later) | Useful for multi-agent delegation and graphs, and default-on *upstream*, but not imported by `core/` and not required for this slice. Core shows a missing-plugin hint. Path: [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md). |
| `@flybot/project`, `@flybot/timeline` | **No** (optional later) | Not Teamily workspace / memory substitutes. Same optional path. |
| DeepSeek Harness | **No** | Peer of `core/`. Closures still open. Tests that need it are not claimed passing. |
| Lark `node-sdk` | Declared in `core/package.json` only, **not vendored** | Install only if a future build explicitly needs that connector. |
| `Birfy/flybot-control-plane` | **Forbidden** | Public repo without a LICENSE. |

## Couplings that must not be left dangling

- `@flybot/social` tests resolve `ds-bot` to repo-root `core/` under `runtime/flybot/`. That path still works.
- Social configuration talks to a Bot Social server URL. The service source is in `services/bot-social/`, but no management setting is wired. The plugin is source-available, not a claimed OpenTeamily-managed feature.
- Upstream official pack/doctor/Dockerfile still mention project/timeline/tree/workflow. Those files are **not imported**, so this tree does not ship a script that claims those plugins are present.
- Core's plugin catalog still *names* the omitted plugins. Naming is not an import.

See [SELECTION.md](SELECTION.md) for the file lists and [GAPS.md](GAPS.md) for DSH/image closures.
