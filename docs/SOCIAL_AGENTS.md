# Agent replies in social groups

Related: [#89](https://github.com/openTeamily/openTeamily/issues/89), [#86](https://github.com/openTeamily/openTeamily/issues/86), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#6](https://github.com/openTeamily/openTeamily/issues/6).

This slice lets an existing **agent member** of a custom group answer a message. It builds on the stored `agent_members` from [#86/#89](MESSENGER.md) and on the unified `/chat` inbox. It is a first speaking slice, **not** agent teams: there is no autonomous delegation, team goal, task handoff, role model, AI twin or agent-to-agent orchestration. Those remain the rest of #89.

## API

All paths are under `/v1/workspaces/{id}/social/conversations/{conversation_id}` and require a conversation member (outsiders `404`).

| Method | Path | Change |
|---|---|---|
| POST | `/messages` | Accepts optional `agent_ids` (1–5 unique 32-hex ids) next to `body`. Each id must already be an agent member of a **group**; DMs and unknown/foreign ids return `400`. |
| GET | `/messages` | Returns human and agent messages merged by `seq`, each with `author_type` (`user` or `agent`). |
| GET | `/{conversation_id}` | Snapshot uses the same merged timeline; `conversation.agent_members` is unchanged. |

A send with `agent_ids` stores the human message and one queued agent reply per mentioned agent. Each reply is an existing runtime `infer` task:

1. A bound usable instance is preferred; otherwise the caller's own online connection is used.
2. The prompt is composed from the live agent name/summary/instructions plus the conversation history, capped by the runtime prompt limit.
3. With no online connection the reply stays `queued` with `error_code=no_agent`. This slice does **not** auto-retry; a later send can mention the agent again.
4. Reads reconcile queued/running replies through the task contract and store the final text.

Agent message fields: `id, conversation_id, workspace_id, author_type:"agent", agent_id, agent_name, body, status, error_code, created, updated, seq`. Task ids and dispatch metadata are not exposed. Human items use `author_type:"user"` and include `user_id`; existing fields are preserved.

Idempotency includes the sorted `agent_ids`. A replay returns the stored human message and the existing agent replies (`200`); a different body/mention set under the same key returns `409`. Message capacity counts human and agent messages.

## Storage

One additive table, `social_agent_messages` (`CREATE TABLE IF NOT EXISTS`). Schema `user_version` stays 1. Human `social_messages` and the existing `social_agent_members` table are unchanged. `seq` is allocated across both message tables so the merged timeline stays ordered.

## UI

On `/chat`, opening a social group with agent members shows a "让智能体回复" checkbox tray above the composer. Sending with a checked agent shows the reply with its status (排队中 / 生成中 / 等待已连接的运行时 / 回复失败), and the page polls while a reply is pending. The custom-group picker retains "自动回复未接通": explicit selection can request a reply, but automatic replies are still unconnected. `docs/screenshots/` holds synthetic Playwright captures for review; they are not browser E2E acceptance.

## Explicitly not in this slice

- Autonomous agent-to-agent delegation, team goals/roles, task handoff or an agent-team entity.
- `@Name` text parsing; mentions are explicit checkboxes/`agent_ids`.
- Auto-retry of `no_agent`, unread counts, notifications, attachments, reactions, editing/retraction.
- Real vendor/container acceptance beyond the existing labeled fake-provider path; no Teamily comparison.

## Compatibility follow-up

Human-only messages keep main's request hash (omitting empty `agent_ids`). Replays
also recognize the empty-list hash written by this branch's original head. This
never permits changing a human-only replay into agent dispatch. `agent_ids` must
be a list even when empty; falsey scalars, null and objects return `400 invalid`.
New requests reject archived agents before storing a human message, instead of
silently dropping the selected agent. Already accepted request replays still
return their stored result and never dispatch again.
