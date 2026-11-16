# First-import selection (needed set, not whole repositories)

Date: 2026-11-16 (Asia/Shanghai).

Pins: ThinkFlowLab/FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2`,
Birfy/bot-social `@8706824f53f6cce8212470bc6b442f7271cccd3e`.
OpenTeamily base: `main` `@2cbd0c1c0845338ded1d9c9455a6c9c2c40a4d52`.

`ds-bot.pin.json` still names Fei2411/DeepSeek-Bot `@2b10c70b614e969117b68ddc6fd14e68968272f2` with `ds-bot` tree `5834c00d9c21b972e4b32ad90489443da2a10324`. That commit is no longer on upstream DS-Bot `main` after a history rewrite; the equivalent commit is `0f130e7d134bf63e8988b2d53fd6846138ac3d73` (same tree). This import does **not** move the pin to upstream `v0.3.6` or import the `ds-bot/` tree. See [ds-bot-pin-equivalence.json](ds-bot-pin-equivalence.json).

Selection rule: take only source, protocols, tests, and docs required for
(1) a future FlyBot **runtime container** (`core/` + instance docker helpers)
and (2) Bot Social **collaboration protocols** (`plugins/social` + the service).
Keep each imported package's internal layout runnable later. Do not copy the
rest of either repository.

Counts: **645** FlyBot files imported, **1087** FlyBot pin files excluded;
**440** Bot Social files imported, **10** Bot Social pin files excluded.
Per-file hashes: [flybot-files.json](flybot-files.json),
[bot-social-files.json](bot-social-files.json).

## Included (FlyBot → `runtime/flybot/`)

| Path | Why it is needed |
| --- | --- |
| `LICENSE`, `NOTICE` | Apache-2.0 obligations |
| `README.md`, `README.zh.md` | Runtime overview |
| `.gitignore`, `.dockerignore` | Package-tree ignore rules |
| `ds-bot.pin.json` | Pin record for how `core/` was produced: DS-Bot `2b10c70` / tree `5834c00d`. After upstream history rewrite, `2b10c70` is not on `main`; equivalent commit `0f130e7` has the same `ds-bot` tree. The `ds-bot/` tree is not imported, and this pin is not retargeted to `v0.3.6`. See [ds-bot-pin-equivalence.json](ds-bot-pin-equivalence.json). |
| `core/` package sources, types, manifests, `client.js`, tests except `install-doctor.test.js` | The actual FlyBot runtime |
| `core/scripts/build-client.mjs`, `lint.mjs` | Rebuild and lint the imported package |
| `core/dev/harness/package.json` | Records the DSH version tests would need (DSH itself not imported) |
| `plugins/social/` | Only plugin on the FlyBot ↔ Bot Social protocol path (#5) |
| `docker/entrypoint.mjs`, `healthcheck.mjs`, `profile.mjs`, `web.patch.yml` | Instance start/health/profile/bind; profile linker is package-generic |
| `docs/docker.md`, `docs/docker.zh.md` | Volume/port model for containers |
| `docs/architecture.md`, `integrating.md`, `reference.md`, `known-issues.md`, `known-issues.zh.md`, `deepseek-api-key.md` | Runtime architecture and operations |
| `docs/subsystems/` `README.md`, `core-host.md`, `core-client.md`, `ds-bot-core.md`, `plugin-runtime.md`, `install.md`, `social.md`, `team.md` | Docs for imported host, client, plugin API, social, team |

## Excluded (FlyBot) and why

| Path | Reason |
| --- | --- |
| `plugins/project/`, `plugins/timeline/` | Not default core; not Teamily workspace/memory substitutes. Optional later path: [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md) |
| `plugins/tree/`, `plugins/workflow/` | Default-on *upstream*, but not imported by `core/` and not required for the social/protocol or container-lifecycle slice. Core still works with a missing-plugin hint. Optional later, same doc. |
| `ds-bot/`, `patches/` | Unpatched DS-Bot tree and the patch series used to regenerate `core/`. The runtime artifact is `core/` itself. |
| `Dockerfile`, `compose.yaml` | Official recipes pack project/timeline/tree/workflow and `npm install -g` DSH. Misleading if copied verbatim. |
| `plugins/README.md` | Lists unimported plugins as part of a full install |
| `core/scripts/install-doctor.mjs`, `core/test/install-doctor.test.js` | Doctor requires the unimported plugins |
| `core/dev/**` except `harness/package.json` | Benches, evals, mascots, UI screenshots, smoke shells — not needed to import the package |
| `.github/`, `.claude/`, `policy/`, `changelog.d/`, `decisions/`, `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `PROJECT.md`, `ROADMAP.md`, `LESSONS.md` | Upstream process, history, and product-planning files |
| `scripts/`, repo-root `dev/` (interop, live-e2e) | Repo helper and interop harness, not the runtime package |
| `docs/images/*`, `docs/assets/wechat-group.png` | Logos, demos, WeChat QR; trademark use unverified |
| `docs/autonomous-dev.md`, `controller.md`, `governance.md`, `sandbox.md`, `release-runbook.md`, `performance-baseline.md`, `rsi-baseline.md`, `self-test.*`, `testing-layers.*`, `testing/`, `interop/`, `reports/`, `subsystems/{project,timeline,tree,workflow,interop,live-e2e}.md` | Process, reports, or docs for unimported plugins |
| Any `Birfy/flybot-control-plane` file | Forbidden (no LICENSE) |
| DSH npm/git, Claude payloads, base images, `node_modules`, credentials, git history | Not in this repository |

## Included (Bot Social → `services/bot-social/`)

| Path | Why it is needed |
| --- | --- |
| `LICENSE`, `README.md`, manifests, lockfile, `tsconfig.json`, ignore files, `botsocial.env.example` | License, install, example env |
| `src/` | Service and protocols |
| `test/` | Tests for `src/` |
| `public/` | Pages the server actually serves (`src/server.ts`) |
| `docs/SETUP.md`, `FACE_ROOMS.md`, `AGENT_GUIDE.md` | Setup and protocol docs |
| `scripts/botctl.ts` | Operator CLI; referenced by included tests |
| `Dockerfile`, `docker-compose.yml`, `start.sh` | Optional module deploy, not a required third control plane |

## Excluded (Bot Social) and why

| Path | Reason |
| --- | --- |
| `docs/assets/` | Banner, logo, UI screenshots; trademark use unverified |
| `docs/index.html` | Marketing site; depends on excluded assets |
| `.github/` | Upstream workflows; would not run from this nested path |
| `scripts/install.sh` | Clones the **full** upstream Bot Social repository |
| `scripts/demo.ts`, `scripts/mcp-smoke.ts` | Optional demos, not required by `src/` or `test/` |

## Dependency graph (needed set)

```
OpenTeamily management server (openteamily/, manager/)  — not wired in this change
        |
        v  (future) FlyBot container from runtime/flybot/core + docker helpers
        |
        +-- plugins/social  --protocol-->  services/bot-social (optional module)
        |
        +-- peer, NOT imported: @deepseek-ai/dsh*
        +-- optional, NOT imported: @flybot/{tree,workflow,project,timeline}
```

Plugins do not import one another. `core` lists known plugin IDs in
`core/src/host/plugins.js`; that catalog is not a JavaScript import.
If a later change needs tree or workflow, import from the same pin (or re-audit
a newer commit), keep Apache-2.0 + NOTICE, and add an origin record.

Related issues #3, #5, #15 are referenced only. This document does not close
#1, #2, #3, #5, or #15. Old FlyBot #3110 / #3112 and bot-social #789 are not
modified.
