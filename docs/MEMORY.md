# Memory pages

Related: [#8](https://github.com/openTeamily/openTeamily/issues/8), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This first slice stores workspace-scoped **memory pages**. A page is written to the store as soon as it is created, and the author (or an owner/admin) can edit or delete it. It is self-written and is **not** Teamily `/memory` parity.

## Routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/memory` | Lists pages (title and metadata only; no body). Optional `q`, `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/memory` | Create `{title, body}`. `body` may be empty. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/memory/{id}` | One page, including body |
| POST | `/v1/workspaces/{id}/memory/{id}` | Revisioned `{revision, changes: {title?, body?}}` |
| POST | `/v1/workspaces/{id}/memory/{id}/remove` | Delete the page |

Title is unique per workspace (case-insensitive). Default cap is 100 pages. Tables are additive; `user_version` stays 1. A same-origin editor is at `/memory`.

## Permissions

Workspace members may list, read and create pages. The author, an owner or an admin may edit or remove a page. A member cannot change someone else's page (`403`). Callers who cannot see the workspace receive `404`.

## Not in this slice

No relationship graph, profile ("我的资料"), next actions, versions beyond the revision number, share or export links, and no "我的作品 / 我的会议" artifact browse. Those remain later slices on issue 8 and issue 9. Timeline and Project are not used as a memory implementation.

No Teamily comparison and no browser E2E are claimed. Issue 8 stays open.
