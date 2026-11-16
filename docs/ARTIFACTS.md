# Artifacts (documents)

Related: [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This first slice adds workspace-scoped **documents**. It is self-written and is **not** Teamily works-library parity. It does not implement websites, whiteboards, media, message-to-library saving, or agent-authored sites. Those stay out of the UI so they are not empty entry points.

## Routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/artifacts` | Lists documents (`title`, not the full body). Optional `q`, `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/artifacts` | `{title, body}` and optional `kind=document`. Requires an Idempotency-Key. Returns the document once |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | One document, including `body` |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | `{revision, changes}` where `changes` may include `title` and `body`. Stale revisions are `409` |
| POST | `/v1/workspaces/{id}/artifacts/{id}/remove` | Deletes the document |

Title is at most 80 characters and unique in the workspace (case-insensitive). Body is at most 8000 characters, within the existing 16KiB request cap. Default cap is 50 documents per workspace. Tables are additive; `user_version` stays 1.

## Permissions

Workspace members may list, read and create documents. The author, an owner or an admin may edit or remove a document. A member cannot change someone else's document (`403`). Callers who cannot see the workspace receive `404`.

## Page

The same-origin page at `/artifacts` lists and edits documents. Browser end-to-end acceptance is not claimed in this slice.

## Not claimed

No share links, no public homepage, no website builder, no Teamily comparison, no browser E2E. This issue stays open until those are done and compared.
