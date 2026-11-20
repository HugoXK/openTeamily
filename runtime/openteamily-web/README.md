# @openteamily/web — OpenTeamily inside each user's own DS-Bot

DSH plugin loaded in the runtime image's `web` profile next to the
`@openteamily/flybot-runtime` wrapper (which boots unmodified upstream DS-Bot).
Phase A of [docs/DSBOT_PLUGIN_ARCHITECTURE.md](../../docs/DSBOT_PLUGIN_ARCHITECTURE.md).

Routes (exact DSH Fetch routes on the shared `/api` channel; DSH's Host/Origin
fence and browser-session authentication run first):

- `GET /api/openteamily/page?path=/chat/` — the OpenTeamily pages bundled at
  build time from `openteamily/static` (`--build-context openteamily-static=openteamily/static`).
  Every response carries `x-openteamily-served-by: ds-bot; instance=<id>` and
  HTML pages carry `<meta name="openteamily-instance">`, so CI can prove which
  runtime served a page.
- `POST /api/openteamily` — `{endpoint, payload}` dispatch, same result shape as
  `/api/bot`. Phase A: `shell/identity`. Feature batches add endpoints here.

Identity: `OPENTEAMILY_INSTANCE_ID` from the manager, otherwise a random
per-volume id in `/data/openteamily/instance.json`. It is not a credential.

Tests: `npm test` (no install). The two-runtime isolation proof is
`runtime/flybot-image/test/container-gateway-isolation.py`.
