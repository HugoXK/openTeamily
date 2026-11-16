# FlyBot connection keys, agent and infer tasks

Related: [#2](https://github.com/openTeamily/openTeamily/issues/2), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds account-scoped connection keys and a stdlib FlyBot agent so a user can send allowlisted work to a machine they run. Allowed kinds are `echo` (transport check) and `infer` (one OpenAI-compatible chat completion using the already configured model API). It follows the 2026-11-16 Teamily recapture of the 连接 tab. It is self-written, FlyBot-branded, and is **not** Teamily parity.

## Key routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/runtime-keys` | `{items, device_id}`. The raw token is never listed |
| POST | `/v1/runtime-keys` | `{name}` plus optional `expires_in`. Returns `{key, token}` once |
| POST | `/v1/runtime-keys/{id}/revoke` | Marks the key revoked and takes its connection offline |

## User routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/runtime/connections` | `online` when `last_seen` is within 45 seconds |
| GET | `/v1/runtime/tasks` | Recent tasks. Credentials never appear |
| POST | `/v1/runtime/tasks` | `{kind, prompt, connection_id?, workspace_id?}`. `kind` is `echo` or `infer`. Optional `workspace_id` must be a workspace the caller can see; infer then uses that workspace's model API if set, otherwise the platform default. Without `workspace_id`, infer uses the account override or the platform default |
| GET | `/v1/runtime/tasks/{id}` | One task, including the result after completion. Expired tasks become `timeout` |
| POST | `/v1/runtime/tasks/{id}/cancel` | Cancels a queued or claimed task |

Default task deadline is 60 seconds.

## Agent routes (runtime key, no cookies)

`Authorization: Bearer <runtime-key>`. Cookie or Origin is rejected. Invalid, expired and revoked keys return `401` `Runtime key not accepted`. The raw key is never listed or logged.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/agent/connect` | Registers or reconnects the unique connection for this key |
| POST | `/v1/agent/heartbeat` | Renews `last_seen` |
| GET | `/v1/agent/tasks` | Queued tasks |
| POST | `/v1/agent/tasks/{id}/claim` | Marks a task `claimed` |
| POST | `/v1/agent/tasks/{id}/model-access` | **Once**, and only for a claimed `infer` task. Returns `{model_api: {provider, base_url, model, api_key, source}}`. A second call is `409`. The key is not stored on the task |
| POST | `/v1/agent/tasks/{id}/result` | `{status, result}`. `api_key` is rejected in the result object |

`infer` currently supports `openai` and `custom` OpenAI-compatible `/chat/completions` endpoints. The agent does not execute a payload as a command. Tables are additive; `user_version` stays 1.

## Starting the daemon

Do **not** pipe an install script to a shell. Download the zipapp from this server, write the key to a private file, and start it explicitly:

```
python3 -c 'from urllib.request import urlretrieve; urlretrieve("$ORIGIN/install/flybot.pyz", "flybot.pyz")'
python3 flybot.pyz daemon start --origin $ORIGIN --key-file ./runtime-key
```

`/install/flybot.pyz` is built from `openteamily/flybot.py` at request time. `/install/flybot.sh` and `/install/flybot.ps1` only print the same commands and exit. A source checkout can still run `python3 -m openteamily.flybot` with the same flags.

## Tests and limits

Loopback tests use a **fake** OpenAI-compatible provider. That is not proof against a real vendor. No generic shell execution, no auto-install, no Teamily cloud Agent, no browser E2E. Do not describe this as connection-flow or model-API parity.
