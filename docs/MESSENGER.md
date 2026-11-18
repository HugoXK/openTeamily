# Workspace messenger: human direct messages and groups

Related: [#86](https://github.com/openTeamily/openTeamily/issues/86), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#7](https://github.com/openTeamily/openTeamily/issues/7).

This is a first **human-to-human** messaging slice in the management plane, written for OpenTeamily. It adds workspace-scoped direct messages and named group chats next to the existing user↔agent conversations ([AGENT_CONVERSATIONS.md](AGENT_CONVERSATIONS.md)). It is **not** Teamily messenger parity: unread counts, notifications, attachments, reactions, edits, retractions, typing indicators and cross-workspace delivery remain missing. Groups can store agent participants, and [SOCIAL_AGENTS.md](SOCIAL_AGENTS.md) adds explicit agent replies; autonomous delegation is not implemented.

The management process only stores messages. It does not call a model provider or a runtime.

## Routes (session + exact Origin + CSRF on writes)

All paths are under `/v1/workspaces/{workspace_id}/social/conversations`. Callers outside the workspace receive `404`; non-members of a conversation also receive `404`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | Conversations the caller belongs to. Keyset pagination: `limit=1..100` (default 20), optional UUID-hex `cursor`. Each item includes its member list and a last-message `preview`. |
| POST | `/` | Create `{kind:"dm"\|"group", member_ids:[...], title?}`. Requires `Idempotency-Key` (16–64 `A-Za-z0-9_-`). |
| GET | `/{conversation_id}` | Snapshot plus up to 100 messages and the member list. |
| GET | `/{conversation_id}/messages` | Messages: `limit=1..100` (default 20), optional UUID-hex `cursor`. |
| POST | `/{conversation_id}/messages` | `{body}`. Requires `Idempotency-Key`. |

`member_ids` are 32-hex user ids; the creator is added implicitly. Every listed id must belong to the same workspace. A `dm` has exactly two distinct members and is deduplicated per workspace: creating the same pair again returns the existing conversation (`200`) even under a different idempotency key. A `group` needs at least two members and may be named (default `群聊`).

## Record shape and bounds

Conversations: `id`, `workspace_id`, `kind` (`dm` or `group`), `title`, `created`, `updated`, `members` (`user_id`, `username`, `created`), and `preview`. `preview` is a whitespace-collapsed snippet of the latest message the caller can already read, at most 160 characters plus an ellipsis if truncated. Empty conversations have an empty `preview`. Full message bodies remain only on message endpoints.

Messages: `id`, `conversation_id`, `workspace_id`, `user_id`, `body`, `created`.

- `title`: 1–80 characters after trim, no control characters. A DM without a title is named after the other member.
- `body`: 1–4000 characters; tabs and newlines are allowed, other controls are not.
- Operator limits (replaceable `Config` fields): 200 conversations per workspace, 500 messages per conversation, 50 members per conversation.
- Same workspace + idempotency key + payload returns the original conversation or message (`200` vs the first `201`), including after restart. A different payload with the same key returns `409`.

## Storage

Additive `social_conversations`, `social_members` and `social_messages` tables (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the tables on next start. Direct-message deduplication uses a sorted-pair digest in `dm_key` with a workspace-scoped unique constraint.

## Page

The management UI for these conversations lives on the unified `/chat` page, together with user↔agent conversations. `/messenger` redirects to `/chat`. The recorded list toolbar is 筛选, then 搜索, then +. 筛选 stays visible and disabled because there is no session-filter API. The main header shows a letter avatar from the current conversation or agent name; there is no verified-badge field. Starting a direct message uses「添加联系人」; starting a group uses「新建群组」. The first group screen shows the intro 「添加名称，然后邀请好友并添加 AI 智能体。」, a 「自定义群组」 / 「AI 智能体团队」 switch (custom is the default), an optional 「群组名称」 field, a member search with a 「已选」 count, and Create disabled until at least one member is selected. 「AI 智能体团队」 stays visible but unconnected: there is no template list, no invented members, and create in that mode is disabled. Paid-team options are not shown. An omitted custom-group title still uses the existing create API, which defaults the stored title to「群聊」. It is not browser E2E evidence, and it is not Teamily messenger parity.

## Explicitly not in this slice

- Task delegation, team goals and autonomous agent-to-agent orchestration in a group ([#89](https://github.com/openTeamily/openTeamily/issues/89)); explicit agent replies are in [SOCIAL_AGENTS.md](SOCIAL_AGENTS.md).
- Workspace-wide authorized message search ([#88](https://github.com/openTeamily/openTeamily/issues/88)).
- Unread counts, read receipts, notifications, attachments, reactions, editing, retraction, typing indicators.
- Cross-workspace or federated delivery, Bot Social transport, and any Teamily comparison.
- Browser acceptance. Tests are in-process WSGI with a temporary SQLite file and are not a live server or vendor run.

## Stored agent participants (Related #89 #86 #7 #1)

Custom groups accept optional `agent_ids` (0–49 unique UUID-hex ids) on the existing
social-conversation create endpoint. Every selected agent must be active and belong
to the same workspace; unknown, archived and foreign ids return `400 invalid`.
DMs cannot have agent participants. The creator is still a human participant and
at least one other workspace human is required; agent-only selections do not
satisfy that rule. The configured total member cap counts humans and agents.
Idempotency includes sorted agent ids when nonempty, preserving prior human-only
request hashes. Agents grant no extra human access to conversations.

An additive `social_agent_members` table keeps schema `user_version` 1. Create,
GET and list return `agent_members` with `agent_id`, `name`, `archived`, `created`;
existing `members` remains human-only. Archived agents remain visible on existing
groups, but cannot be newly invited. No new membership-edit endpoint is added.

The custom-group picker labels people and existing workspace agents separately;
search and the selected count include both. Contact creation remains human-only.
After creation/reload the saved agent names appear above the conversation. Explicit
agent replies, infer dispatch and mention selection are documented in
[SOCIAL_AGENTS.md](SOCIAL_AGENTS.md); task handoff and the team-template flow are
still not implemented. The AI-team switch remains unconnected; no billing or
credits are introduced. This is not Teamily/Impeccable acceptance. All related
tracking issues stay open.
