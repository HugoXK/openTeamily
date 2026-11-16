# Artifacts (documents, shares, and static websites)

Related: [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice stores workspace-scoped **documents** and **static websites**. Automation or agent results can be saved as documents with provenance. Read-only share links are created only when someone asks, and they can be revoked. It is self-written and is **not** Teamily works-library parity. It does not implement whiteboards, media, message-to-library saving, public homepages, or scripted web apps.

## Routes (session + CSRF unless noted)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/artifacts` | Lists items (`title`, not the full body). Optional `q`, `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/artifacts` | `{title, body, kind}` where `kind` is `document` or `website`. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | One item, including `body` and `source` when present |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | `{revision, changes}` for `title` and `body`. Stale revisions are `409` |
| POST | `/v1/workspaces/{id}/artifacts/{id}/remove` | Deletes the item |
| GET | `/v1/workspaces/{id}/artifacts/{id}/preview` | Sandboxed HTML render for members |
| GET | `/v1/workspaces/{id}/artifacts/{id}/shares` | Lists share metadata (prefix, expiry, revoked). Never returns the token |
| POST | `/v1/workspaces/{id}/artifacts/{id}/shares` | Creates a read-only share. The token and path are returned once |
| POST | `/v1/workspaces/{id}/artifacts/{id}/shares/{share}/revoke` | Revokes the share |
| POST | `/v1/workspaces/{id}/automations/{id}/runs/{run}/artifact` | Saves a succeeded run's text as a document with provenance |
| POST | `/v1/runtime/tasks/{id}/artifact` | Saves a succeeded task's text as a document; requires a workspace the caller can use |
| GET | `/share/{token}` | Public, read-only render. No session. Invalid, expired, or revoked tokens are `404` |

Title is at most 80 characters and unique in the workspace (case-insensitive). Body is at most 8000 characters, within the existing 16KiB request cap. Default cap is 50 items per workspace and 10 active shares per item. Tables are additive; `user_version` stays 1. Creating or saving an item does not publish a share.

## Permissions

Workspace members may list, read and create items, and may save a run they can see. The author, an owner or an admin may edit, remove, or create/revoke shares. A member cannot change or share someone else's item (`403`). Callers who cannot see the workspace receive `404`.

## Rendering

Documents are shown as escaped text. Websites are sanitized (no scripts, event handlers, forms, or remote frames) and served with a CSP `sandbox` that does not allow scripts. The management page does not insert unsanitized HTML and previews websites in an iframe with an empty `sandbox` attribute. This is not an isolated DNS origin; it is a CSP/sandbox boundary on the management host.

## Page

The same-origin page at `/artifacts` lists and edits documents and websites, shows provenance, and creates or revokes share links. The automations page can save a succeeded run into the library. Browser end-to-end acceptance is not claimed.

## Not claimed

No public homepage, no whiteboards, no Teamily comparison, no browser E2E, no claim that share pages are a separate browser origin. This issue stays open until those are done and compared.
