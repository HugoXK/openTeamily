# OpenTeamily FlyBot runtime image (first slice)

OpenTeamily-authored recipe (root MIT). The image it builds **also contains**
the unmodified Apache-2.0 `runtime/ds-bot-upstream/` tree and the Apache-2.0
`@flybot/social` plugin; those licenses and NOTICE files are copied into
`/opt/licenses/`. This directory is not part of the vendor snapshot.

## What it is

A container that the already-merged compose manager can run as the `flybot`
service:

- Starts as **UID/GID 1000** (no root entrypoint: no `gosu` / `groupmod` / `chown`).
- Read-only rootfs is supported: Bot workspace is `/data/workspace`; only `/data`
  and tmpfs `/tmp` need to be writable.
- Listens on **8080**, which is the port `openteamily.manager.engine.manifest`
  publishes to `127.0.0.1`.
- Ships a Docker HEALTHCHECK.
- Loads `@openteamily/flybot-runtime`, which calls upstream `createRuntime()`
  and then `applyOnRuntime()` from `runtime/flybot-social-host/` so
  `@flybot/social` injects a `flybot` service. The vendor tree is not edited.

## Build

From the repository root (context is `runtime/`):

```sh
dsh=$(node -p "require('./runtime/ds-bot-upstream.pin.json').dsh")
docker build -f runtime/flybot-image/Dockerfile \
  --build-arg "DSH_VERSION=$dsh" \
  -t openteamily-flybot:local \
  runtime
```

CI (`.github/workflows/flybot-runtime-image.yml`) builds this image and runs
`test/smoke.mjs`.

## What this slice does not claim

- It does **not** close [issue #3](https://github.com/openTeamily/openTeamily/issues/3).
  DeepSeek Harness `0.2.2-rc.1`, the Node/Debian base image, and third-party
  notices still need a redistribution audit before a public image release.
- Live Bot Social onboarding is off (`onboard: false`); that is a later slice.
- The `@flybot/social` **web client** (slot registry) is not wired: upstream
  DS-Bot v0.3.6 has no `__flybot__` slot host. A later slice adds that adapter.
- Office / computer tool stacks from the official DS-Bot image (Python, ffmpeg,
  build-essential) are not installed in this first recipe.
- The management server still needs an operator-supplied **digest-pinned**
  reference (`image@sha256:…`) after you load this image into the engine.

## Compose manager contract

See `openteamily/manager/engine.py` `manifest()`: service `flybot`, user
`1000:1000`, read-only, volume `/data`, tmpfs `/tmp`, published
`127.0.0.1:<port>->8080/tcp`, optional HEALTHCHECK.
