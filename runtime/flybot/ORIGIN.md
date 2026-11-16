# Origin

This directory is a **minimal, file-selected snapshot** of public
[ThinkFlowLab/FlyBot](https://github.com/ThinkFlowLab/FlyBot) commit
[`e26895e737b1218875aafa1f74ab1d3464f287d2`](https://github.com/ThinkFlowLab/FlyBot/commit/e26895e737b1218875aafa1f74ab1d3464f287d2)
(2026-11-16 00:07:14 UTC). It is **not** a whole-repository copy.

- **License:** Apache License 2.0 — [`LICENSE`](LICENSE).
- **NOTICE:** [`NOTICE`](NOTICE) (DS Bot, Copyright 2026 Fei2411 and the DS Bot contributors). Redistribution must keep both files.
- **This tree is not MIT-licensed** because it lives in openTeamily/openTeamily. The root MIT license covers only new OpenTeamily-authored material.
- **Provenance:** every imported upstream file has `sha256` and git blob SHA in [`docs/upstream/flybot-files.json`](../../docs/upstream/flybot-files.json). Selection and exclusions: [`docs/upstream/SELECTION.md`](../../docs/upstream/SELECTION.md).
- **OpenTeamily overlays:** this file and [`OPENTEAMILY.md`](OPENTEAMILY.md) only. All other files here are byte-identical to the pin.

## Imported paths

| Path in this tree (upstream path is the same) | Source | Purpose | Related issues (does not close them) |
| --- | --- | --- | --- |
| `LICENSE`, `NOTICE` | FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2` | Binding Apache-2.0 text and NOTICE | #3 |
| `README.md`, `README.zh.md` | same commit | Upstream runtime overview (image links to excluded logos are intentionally broken) | #2 |
| `.gitignore`, `.dockerignore` | same commit | Ignore rules for the runtime package tree | #2 |
| `ds-bot.pin.json` | same commit | Records the DS-Bot commit that `core/` was built from; the `ds-bot/` tree itself is not imported | #3 |
| `core/` (package: `index.js`, `src/`, `client.js`, `web-search.js`, `cordis.patch.yml`, `types/`, `package.json`, `package-lock.json`, `LICENSE`, `README.md`) | `core/` @ same commit | FlyBot runtime package: agent host, store, plugin API, web client sources, types. This is the code a FlyBot container would run. | #2, #4, #6, #7, #8, #10 |
| `core/test/` except `install-doctor.test.js` | `core/test/` @ same commit | Unit tests for the imported `core/` sources. They still need a DeepSeek Harness to execute; that harness is not imported. | #2, #4, #6, #7, #8, #10 |
| `core/scripts/build-client.mjs`, `core/scripts/lint.mjs` | same paths @ same commit | Client bundle rebuild and package lint for `core/` | #4 |
| `core/dev/harness/package.json` | same path @ same commit | Documents the DSH version core tests expect. Do **not** install it as part of this import. | #3, gaps |
| `plugins/social/` | `plugins/social/` @ same commit | `@flybot/social`: FlyBot-side client for Bot Social onboard, invite, approval, rooms | #5 |
| `docker/entrypoint.mjs`, `docker/healthcheck.mjs`, `docker/profile.mjs`, `docker/web.patch.yml` | `docker/` @ same commit | Instance start, health, profile linking, loopback bind patch. Official root `Dockerfile` / `compose.yaml` are not imported (they pack excluded plugins). | #2 |
| `docs/docker.md`, `docs/docker.zh.md` | same paths @ same commit | How an instance volume and port are meant to work | #2 |
| `docs/architecture.md`, `docs/integrating.md`, `docs/reference.md`, `docs/known-issues.md`, `docs/known-issues.zh.md`, `docs/deepseek-api-key.md` | same paths @ same commit | Architecture, integration, known issues, and key handling for the runtime | #2, #6 |
| `docs/subsystems/README.md`, `core-host.md`, `core-client.md`, `ds-bot-core.md`, `plugin-runtime.md`, `install.md`, `social.md`, `team.md` | same paths @ same commit | Subsystem docs for imported host, client, plugin API, social, and team behavior | #2, #5, #7 |

Core still contains some Project / Workflow / Timeline *UI seams and tests* because they live inside the `core/` package. The corresponding **plugins are not imported**, so those entry points are unsupported here. See [`docs/upstream/OPTIONAL-PLUGINS.md`](../../docs/upstream/OPTIONAL-PLUGINS.md).
