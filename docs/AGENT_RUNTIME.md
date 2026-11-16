# Agent runtime binding

This slice binds a workspace agent directory record to a workspace FlyBot *container instance*, then dispatches authorized conversations through the existing `/v1/agent` infer task contract. It is self-written for OpenTeamily.

The management process does not call a model provider and does not add a second chat engine. A lease-gated manager endpoint issues an instance runtime key; the compose manager writes that key to a private 0600 file and bind-mounts it at `/run/secrets/openteamily-runtime-key.json`. The container's `agent-loop.mjs` authenticates with `/v1/agent/connect` and runs the same claim / model-access / result loop as the optional own-machine daemon. Tests that finish a reply with a fake OpenAI-compatible server are labeled as such; they are not a real vendor, and they are not a substitute for a live container inference pass.

## Routes

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/workspaces/{id}/agents/{agent_id}/runtime` | Members may read the binding. `runtime` is `null` when unbound. Status is `online`, `offline`, or `unavailable` (stopped, blocked, or missing). No tokens. |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/runtime` | Owner or admin. Body: `instance_id`, and the current `revision` when replacing a binding. The instance must belong to the same workspace. Archived agents return `409`. Lifecycle disabled: `501`. |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/runtime/unbind` | Owner or admin. Body: current `revision`. |
| POST | `/v1/internal/instances/{id}/runtime-agent-key` | Manager-only, loopback, lease-gated, create/start/restart only. Returns `{runtime_key_present, runtime_key:{origin,token,hostname}}`. The same job may fetch the same token again; a new start job rotates it. User snapshots, jobs, observe receipts and the `/runtimes` key list never include the token. |

Existing instance start/stop/claim/heartbeat/observe contracts are unchanged. A stale or expired lease returns `409` and does not include a token.

## Conversation dispatch

`POST .../conversations/{id}/messages` still queues an `infer` task:

1. If the agent is bound to a usable instance (`desired=running`, not blocked) and that instance's connection is online, the task is created on that connection (the instance key owner, not the caller).
2. Otherwise the caller's own-machine connection is used, when one is online. Instance keys are never selected as a personal connection.
3. If neither is online, the assistant stays `queued` with `error_code=no_agent`. A later GET retries, including after a key rotation (restart recovery).

The conversation itself remains private to the user who created it. Assistant messages may include `dispatch: {source: "instance"|"connection", instance_id?, connection_id}` with no secrets.

## Container hook

`runtime/flybot-image/launch.mjs` starts `agent-loop.mjs` next to `dsh`. If the key file is missing or empty, the loop exits quietly and the web runtime still starts. Existing containers need a no-delete recreate so the new bind is attached (the same upgrade path used for earlier secret binds). This slice does not treat the image-build smoke as a real-vendor inference proof.

## Explicitly not in this slice

- Public homepages, embeds, or invented Auto / Instant / Agentic modes.
- A second model or chat engine in the management process.
- Claiming that a fake provider test is real inference or a live Docker conversation pass.
- Teamily comparison or browser end-to-end acceptance. Issues #6, #2, and #1 stay open.
