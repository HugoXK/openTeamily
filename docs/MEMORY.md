# Memory pages and next actions

Related: [#8](https://github.com/openTeamily/openTeamily/issues/8), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice stores workspace-scoped **memory pages** and **next actions**. Both are written to the store as soon as they are created, and the author (or an owner/admin) can edit or delete them. It is self-written and is **not** Teamily `/memory` parity.

## Routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/memory` | Lists pages (title and metadata only; no body). Optional `q`, `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/memory` | Create `{title, body}`. `body` may be empty. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/memory/{id}` | One page, including body |
| POST | `/v1/workspaces/{id}/memory/{id}` | Revisioned `{revision, changes: {title?, body?}}` |
| POST | `/v1/workspaces/{id}/memory/{id}/remove` | Delete the page |
| GET | `/v1/workspaces/{id}/memory/actions` | Lists actions (title and metadata only; no notes). Optional `q`, `status` (`open` or `done`), `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/memory/actions` | Create `{title, notes?, due_at?, memory_page_id?}`. `notes` may be empty. Status starts as `open`. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/memory/actions/{id}` | One action, including notes |
| POST | `/v1/workspaces/{id}/memory/actions/{id}` | Revisioned `{revision, changes: {title?, notes?, status?, due_at?, memory_page_id?}}`. `due_at` or `memory_page_id` may be `null` to clear |
| POST | `/v1/workspaces/{id}/memory/actions/{id}/remove` | Delete the action |

Page titles are unique per workspace (case-insensitive). Action titles are not unique. Default caps are 100 pages and 200 actions. Tables are additive; `user_version` stays 1. A same-origin editor is at `/memory`.

`due_at` is an optional Unix timestamp in seconds. `memory_page_id` must refer to a page in the same workspace; deleting that page clears the link and keeps the action.

## Permissions

Workspace members may list, read and create pages and actions. The author, an owner or an admin may edit or remove an item. A member cannot change someone else's item (`403`). Callers who cannot see the workspace receive `404`.

## Not in this slice

No relationship graph, profile ("我的资料"), versions beyond the revision number, share or export links, and no "我的作品 / 我的会议" artifact browse. Those remain later slices on issue 8 and issue 9. Timeline and Project are not used as a memory implementation.

No Teamily comparison and no browser E2E are claimed. Issue 8 stays open.
