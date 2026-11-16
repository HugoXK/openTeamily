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

## Model API config (operator-supplied, not baked in)

OpenTeamily does not ship a credits/billing proxy and does not enforce usage
limits. A self-host admin sets a platform-default model API; a user may
optionally override it. The management server (lane 2 owns the config API)
resolves those two layers — **user override wins** — and injects one already-
resolved secret when the instance starts. The container does not merge.

The container reads that JSON secret file at start — never from the image layers:

1. `$OPENTEAMILY_MODEL_API_FILE` if set (must resolve under `/run/secrets/` or
   `/data/secrets/`)
2. otherwise `/run/secrets/openteamily-model-api.json`
3. otherwise `/data/secrets/model-api.json`

Example file (do not commit real keys):

```json
{
  "provider": "deepseek",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "api_key": "sk-...",
  "source": "user"
}
```

`source` is optional metadata (`platform` or `user`) saying which layer won;
it is not used to choose a key. The launcher exports `{PROVIDER}_API_KEY`
(for DeepSeek, `DEEPSEEK_API_KEY`) into the process environment for DSH, and
records the non-secret fields as `OPENTEAMILY_MODEL_PROVIDER`,
`OPENTEAMILY_MODEL_BASE_URL`, `OPENTEAMILY_MODEL_NAME`, and
`OPENTEAMILY_MODEL_SOURCE`. The key is never written to logs or stdout. Starting
without a file is allowed so CI smoke can boot; that instance cannot call a
model until a secret is mounted.

The compose executor does not yet inject this file (next management-plane
slice). Do not put keys in the Dockerfile, in git, or in a world-readable
volume.

## Compose manager contract

See `openteamily/manager/engine.py` `manifest()`: service `flybot`, user
`1000:1000`, read-only, volume `/data`, tmpfs `/tmp`, published
`127.0.0.1:<port>->8080/tcp`, optional HEALTHCHECK.
