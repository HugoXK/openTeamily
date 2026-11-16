# FlyBot connection keys and own-machine agent

Related: [#2](https://github.com/openTeamily/openTeamily/issues/2), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds account-scoped connection keys and a Python stdlib FlyBot agent so a user can send allowlisted work to a machine they run. It follows the 2026-11-16 Teamily recapture of the 连接 tab (named keys, secret shown once, list prefixes only, expiry default Never, a device ID, CLI then daemon). It is self-written. The page is FlyBot-branded and uses this repository's own module path. It is **not** Teamily parity and does not implement Teamily cloud agents or hosted computers.

## Key routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/runtime-keys` | `{items, device_id}`. Items are `{id,name,prefix,created,expires,revoked}`. The raw token is never listed. `device_id` is a stable `fbdev_` value created on first read |
| POST | `/v1/runtime-keys` | `{name}` plus optional `expires_in` (60–31536000 seconds). Omit `expires_in` for Never. Returns `201` `{key, token}`; the raw token is shown **once** |
| POST | `/v1/runtime-keys/{id}/revoke` | `{}`. Marks the key revoked and takes any connection for that key offline |

## User routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/runtime/connections` | Connections for the caller. `status` is `online` when `last_seen` is within 45 seconds |
| GET | `/v1/runtime/tasks` | Recent tasks |
| POST | `/v1/runtime/tasks` | `{kind, prompt, connection_id?}`. `kind` must be `echo`. Returns `409` if no connection is online |
| GET | `/v1/runtime/tasks/{id}` | One task, including the result object after completion |

## Agent routes (runtime key, no cookies)

These routes require `Authorization: Bearer <runtime-key>`. Requests that also carry `Cookie` or `Origin` are rejected. Invalid, expired and revoked keys all return `401` `Runtime key not accepted`. The raw key is never returned, listed or logged.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/agent/connect` | `{hostname}`. Registers or reconnects the unique connection for this key |
| POST | `/v1/agent/heartbeat` | `{}`. Renews `last_seen` |
| GET | `/v1/agent/tasks` | Queued tasks for this connection |
| POST | `/v1/agent/tasks/{id}/claim` | Marks a queued task `claimed` |
| POST | `/v1/agent/tasks/{id}/result` | `{status, result}` with `status` `succeeded` or `failed` |

`echo` tasks return `{echo: prompt}`. The agent never executes a payload as a command. Tables are additive; `user_version` stays 1.

## Starting the daemon

Do **not** pipe an install script to a shell. From a checkout of this repository, write the key to a private file and start the module explicitly:

```
python3 -m openteamily.flybot daemon start --origin $ORIGIN --key-file ./runtime-key
```

`--once` connects, drains queued tasks, and exits (used by tests). HTTPS is required except for loopback HTTP. `/install/flybot.sh` and `/install/flybot.ps1` only print that command and exit without changing the machine.

## Not in this slice

No model inference on the machine, no additional task kinds, no auto-install, no Teamily cloud Agent or hosted computer, no browser E2E. Do not describe this as connection-flow parity.
