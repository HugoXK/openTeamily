# Bot Social collaboration endpoint

Related: [#1](https://github.com/openTeamily/openTeamily/issues/1).

The management server records only a validated Bot Social **server URL** and an optional display name. A self-host operator sets a platform default; a workspace owner or admin may optionally override it. The workspace override wins when it has a server. Connector tokens are issued later by onboarding on the instance volume and are never accepted, stored or returned by management. This is an OpenTeamily wiring choice, not a Teamily parity claim.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET/POST | `/v1/admin/bot-social` | Platform default. Loopback `Authorization: Bearer` using an operator credential hash from `--operator-admin`. No session cookies, no Origin header. POST `{revision, changes}` |
| GET/POST | `/v1/workspaces/{id}/bot-social` | Optional workspace override. Any member may GET; owner or admin may POST. GET also returns `effective` (workspace if set, else platform). Session + exact Origin + CSRF on POST |

There is no account-level `/v1/bot-social` route in this slice, and no settings UI.

`changes` fields: `server` (https, or http only on localhost / 127.0.0.1 / ::1; no userinfo, query or hash; at most 200 characters; a trailing slash is stripped), optional `displayName` (at most 40 characters after flattening whitespace; no control characters). Send `server` as `null` or `""` to clear that scope. A `token`, `api_key` or `connector` field is refused. Revision conflicts return `409` with `error.current`.

## Container injection

The compose manager fetches the already-resolved URL over a lease-gated loopback endpoint (`POST /v1/internal/instances/{id}/runtime-bot-social`, create/start/restart only) and writes it to a private 0600 file that is bind-mounted read-only at `/run/secrets/openteamily-bot-social.json`. The file is `{server, displayName?, source}` where `source` is `platform` or `workspace`. When no server is configured the file is empty. The image loader already reads that path (or `$OPENTEAMILY_BOT_SOCIAL_FILE` / `/data/secrets/bot-social.json` / an env URL). A connector token must not appear in the management database, this file, Compose, claim/observe JSON, or logs.

Existing frozen `compose-*.json` files written before this second bind was added will fail the exact-content check (`manifest_changed`) until the operator recreates the instance.

## Not in this slice

No live call to a third-party Bot Social, no connector-token storage, no settings UI, no Teamily comparison. Unit tests use in-process WSGI and a temporary SQLite store only. Compose-manager tests use the filesystem Docker stub, not a Docker engine. CI image smoke against an in-container fake server is a separate path and is not management-plane proof. This box has no Docker engine.
