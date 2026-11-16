# Workspace members API (issue #7, slice 1)

Related: [#7](https://github.com/openTeamily/openTeamily/issues/7) (workspaces, team roles and group multi-agent runs — **not completed**), [#5](https://github.com/openTeamily/openTeamily/issues/5) (share, invite, approval and freeze), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds workspace membership on the management API so an existing account can be added to a workspace with a role. It is self-written; no FlyBot, Bot Social, DS-Bot or Teamily source was used.

Teamily team creation (wizard steps 2/3), paid Team plan packaging, invite links/codes, and the conditions under which “switch workspace” appears were observed only in part and were **not** re-implemented here. Adding a member requires an already registered username. That is an OpenTeamily bootstrap choice, not a compared Teamily invite flow. Do not describe this slice as workspace or Team-plan parity.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces` | Workspaces the caller owns **or** is a member of (same pagination as before) |
| GET | `/v1/workspaces/{id}` | Visible to the owner and to members; non-members still get `404` |
| GET | `/v1/workspaces/{id}/members` | Owner plus assigned members: `{items:[{user_id,username,role,created}]}` |
| POST | `/v1/workspaces/{id}/members` | `{username,role}` where `role` is `admin` or `member`. Owner or admin. Session + exact Origin + CSRF required. Same username+role is idempotent (`200`); a different role is `409` |
| POST | `/v1/workspaces/{id}/members/{user_id}` | `{role}` — owner only, `admin` or `member` |
| POST | `/v1/workspaces/{id}/members/{user_id}/remove` | `{}`. Owner may remove admin/member; admin may remove member; a member or admin may leave. The owner cannot leave or be removed in this slice |

Unknown usernames, missing members and workspaces the caller cannot access all return `404`. Unknown usernames use the generic message `Member could not be added` (no distinct “user not found”). The workspace `owner_id` stays the creator; owner transfer is not in this slice. Invite links are in [INVITES.md](INVITES.md); there is still no email delivery, approval queue or registration-by-invitation.

## Roles (OpenTeamily defaults — not yet Teamily-verified)

| Role | Can list workspace and members | Add | Change role | Remove |
|---|---|---|---|---|
| `owner` | yes | admin or member | yes | admin or member |
| `admin` | yes | member only | no | member, or self |
| `member` | yes | no | no | self only |

Default cap is 50 people per workspace including the owner (`Config.max_members_per_workspace`).

## Storage

An additive `workspace_members` table (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the table on next start. The owner is derived from `workspaces.owner_id` and is not stored as a member row.

## Not in this slice

Runtime instance inspect/start/stop/create remain owner-only; members can see the workspace record but not operate instances yet. No members UI, no Teamily team wizard, no owner transfer, no group multi-agent run. Browser acceptance is not claimed.
