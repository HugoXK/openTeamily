# FlyBot connection keys (runtimes 连接 tab)

Related: [#2](https://github.com/openTeamily/openTeamily/issues/2), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds account-scoped connection keys so a user can send work to a machine running FlyBot. It follows the 2026-11-16 Teamily recapture of the 连接 tab (named keys, secret shown once, list prefixes only, expiry default Never, a device ID, CLI install then daemon start). It is self-written. The page is FlyBot-branded and uses this server's own install path. It is **not** Teamily parity, does not ship a CLI binary, and does not implement Teamily cloud agents or hosted computers.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/runtime-keys` | `{items, device_id}`. Session required. Items are `{id,name,prefix,created,expires,revoked}`. `expires` is `null` when the key never expires. The raw token is never listed. `device_id` is a stable `fbdev_` value created on first read |
| POST | `/v1/runtime-keys` | `{name}` plus optional `expires_in` (60–31536000 seconds). Omit `expires_in` for Never. Returns `201` `{key, token}`; the raw token is shown **once**. Session + exact Origin + CSRF required |
| POST | `/v1/runtime-keys/{id}/revoke` | `{}`. Only the owner of the key. Subsequent lists keep the prefix and mark `revoked` |

Unknown or foreign key ids return `404`. Names are 1–80 characters with no control characters. Default cap is 20 active (unrevoked, unexpired or never-expiring) keys per account. Only `sha256` token hashes are stored, plus an 8-character prefix.

## Same-origin page

`/runtimes` has 运行时 and 连接 tabs, served by `SettingsPage` with the same CSP allowlist. 运行时 explains that OpenTeamily uses self-hosted FlyBot containers. 连接 generates keys, shows the device ID, and documents:

- macOS/Linux: `curl -fsSL $ORIGIN/install/flybot.sh | sh`
- Windows: `irm $ORIGIN/install/flybot.ps1 | iex`
- daemon: `flybot daemon start --origin $ORIGIN --key <runtime-key>`

`/install/flybot.sh` and `/install/flybot.ps1` are documentation helpers. They print the OpenTeamily/FlyBot install path and exit without downloading or changing files, until a CLI release is published at https://github.com/openTeamily/openTeamily.

## Not in this slice

No CLI binary, no daemon, no remote-machine detection, no Teamily cloud Agent or hosted computer, no browser E2E. Do not describe this as connection-flow parity.
