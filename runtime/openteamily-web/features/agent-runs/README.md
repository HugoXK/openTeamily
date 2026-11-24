# agent-runs

Durable OpenTeamily agent run trace.

- Consumes normalized events from `agent-runtime-contract`.
- Observes existing DSH `session/event` and `agent/assistant-stream`; it does not
  change model, tool, subagent, permission or approval execution.
- Stores runs and ordered events in this user's own DS-Bot volume.
- Exposes `start`, `ingest`, `get`, `list`, `events`, `replay`, `stats` and
  `contract`.
- Does not add UI, tool policy, subagent control or durable resume.

See `docs/AGENT_RUNS.md`.
