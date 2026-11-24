# Agent run trace

Status: **trace store and observer only**. This slice consumes the contract from
[AGENT_RUNTIME_CONTRACT.md](AGENT_RUNTIME_CONTRACT.md), persists normalized DSH
events in the user's own DS-Bot, and exposes query/replay endpoints. It does not
execute models, tools or subagents, and it does not change existing agent
behavior.

Related: #1, #11, #89, #622.

## Reuse / new / not doing

**Reuse**
- DSH: `session/event`, `agent/assistant-stream`, `tool/call`, `tool/result`,
  `subagent/start`, `subagent/end`, usage, permission, approval, compaction and
  resume primitives.
- `agent-runtime-contract`: normalization, deterministic event IDs, bounds and
  redaction.
- Bot Social stays out of this feature; shared audit/policy/approval remains
  owned there.

**New**
- `features/agent-runs`: durable SQLite trace store, live DSH observer, run
  aggregates, keyset listing and replay API.
- Run aggregates: status, token usage, tool calls, subagent count, retries,
  event count and duration.
- Deterministic run identity from workspace, agent, session and DSH turn.

**Not doing**
- No new tool/subagent/usage/permission/approval/compaction engine.
- No tool policy, subagent budget, durable resume, eval, UI or chat changes.
- No edits to `features/agents`, `ds-bot-bridge.mjs`, `team-runs`,
  `static/chat`, `app.py`, Bot Social or the pinned upstream tree.

## Storage

`/data/openteamily/features/agent-runs/agent-runs.sqlite3`:

- `agent_runs`: one row per DSH turn, deterministic `run_id`,
  `workspace_id`, `agent_id`, `session_id`, `turn_id`, status, timestamps,
  provider/model, token usage, tool/subagent/retry/event counts and error code.
- `agent_run_events`: append-only normalized events keyed by
  `(run_id, sequence)` with a globally unique `event_id`.

A duplicate normalized event is skipped by `event_id`. Reusing a sequence with a
different event is `409 conflict`. Terminal status is written only while the run
is still `running`, so a late replayed completion cannot flip a cancelled or
failed run.

## Observer

The feature attaches to the already-running DS-Bot after `host.runtime()`
resolves and subscribes to:

- `session/event` — turn, assistant, tool, subagent and termination events;
- `agent/assistant-stream` — assistant text and reasoning deltas.

It records only sessions whose Bot carries OpenTeamily agent metadata
(`bot.openteamily.workspace_id` and `agent_id`). Main Bot, unrelated tasks and
non-OpenTeamily sessions are ignored. It does not call or wrap model/tool code.
If the runtime is not attached, the feature still loads and endpoints work; the
observer logs and stays inactive.

## Endpoints

`POST /api/openteamily` with `endpoint: "agent-runs/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `contract` | none | statuses/sources/endpoints and reuse/new boundary |
| `start` | `{workspace_id, agent_id, session_id, turn_id, source?, at?}` | deterministic manual run |
| `ingest` | `{run_id, events:[normalized event]}` | append + run aggregates |
| `get` | `{run_id}` | one run |
| `list` | `{workspace_id?, agent_id?, status?, limit?, cursor?}` | keyset run page |
| `events` | `{run_id, after_sequence?, limit?}` | ordered normalized events |
| `replay` | `{run_id}` | run + up to 500 events |
| `stats` | `{workspace_id?}` | counts by status |

Workspace-scoped calls verify the caller can access that workspace through
`agents/personal-binding` or `teams/activeWorkspaces`. No cross-workspace run is
returned for an inaccessible workspace.

## Tests

`runtime/openteamily-web/test/agent-runs.test.js` covers:

- live turn/tool/usage/termination observation;
- stream deltas, subagent count and failed runs;
- non-OpenTeamily session filtering;
- manual start, idempotent event ingest and usage aggregates;
- workspace access failure and missing runs;
- contract endpoint boundary.

Tests use Node 22, a temporary SQLite file and a fake DSH runtime/event bus. They
do not call a real model, container, Bot Social or external service.
