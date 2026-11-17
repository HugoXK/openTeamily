# Artifacts (documents, media, whiteboards, and shares)

Related: [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice stores workspace-scoped **documents**, **static websites**, **media files**, and **whiteboards**. Automation or agent results can be saved as documents with provenance. Each save keeps a revision snapshot that can be listed, exported, or restored as a new revision (history is not rewritten). Read-only share links are created only when someone asks, and they can be revoked. It is self-written and is **not** Teamily works-library parity.

Completed messages in an authorized user/agent conversation can be saved as documents with provenance (`source.kind=agent_message`, plus `id`, `conversation_id`, optional `agent_id`, and `conversation_title` when the conversation still has a title) and are idempotent per message. The works-library filter lists those titles under「来源会话」instead of raw conversation ids. Scripted web apps are not enabled on the management origin.

## Supported operations

| Kind | Create | Read | Edit | Notes |
|---|---|---|---|---|
| document | JSON `{title, body}` | body | revisioned title/body | Existing behavior |
| website | JSON `{title, body, kind: website}` | sanitized HTML preview | revisioned source | CSP `sandbox`, no scripts |
| media | `multipart/form-data` with `title` and `file` | metadata; `GET .../file` for bytes | title via JSON; replace file via `POST .../file` with revision | MIME is sniffed from magic bytes; SVG/HTML/JS rejected; filename is sanitized and not used as a path |
| whiteboard | JSON `{title, kind: whiteboard, board}` | `board` plus SVG preview | `{revision, changes: {title, board}}` or `{operations: [{op: add\|remove\|replace, ...}]}` | Strokes are paths, rectangles, ellipses, or escaped text |

## Routes (session + CSRF unless noted)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/artifacts` | Lists items (no document body; media metadata only) |
| POST | `/v1/workspaces/{id}/artifacts` | JSON create, or multipart media upload. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | One item, including body, board, or media metadata |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | Revisioned title/body/board/operations |
| GET | `/v1/workspaces/{id}/artifacts/{id}/file` | Media bytes for members |
| POST | `/v1/workspaces/{id}/artifacts/{id}/file` | Replace media (`revision` form field) |
| GET | `/v1/workspaces/{id}/artifacts/{id}/preview` | Sandboxed HTML render (media previews are a text/html wrapper, not a scripted player) |
| GET/POST | `/v1/workspaces/{id}/artifacts/{id}/shares` and `.../revoke` | Explicit, revocable, read-only shares |
| GET | `/v1/workspaces/{id}/artifacts/{id}/versions` | Revision history (metadata only, newest first) |
| GET | `/v1/workspaces/{id}/artifacts/{id}/versions/{revision}` | One snapshot, including body, board, or media metadata |
| GET | `/v1/workspaces/{id}/artifacts/{id}/export` and `.../versions/{revision}/export` | Download the current or a historical snapshot as an attachment |
| POST | `/v1/workspaces/{id}/artifacts/{id}/restore` | `{revision, to}` restores snapshot `to` as a new revision. Same-content restore does not bump. Author, owner or admin only |
| GET | `/share/{token}` | Public read-only render or media bytes. Invalid or revoked tokens are `404` |

Media files are at most 2 MiB. Allowed sniffed types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `audio/mpeg`, `audio/ogg`, `audio/wav`, `video/mp4`, `video/webm`. Objects are stored under the private data directory as `{workspace_id}/{sha256}`, never under a user-supplied path. Whiteboard JSON is at most 65536 bytes, with at most 200 strokes.

Title is unique per workspace. Default cap is 50 items and 100 stored revisions per item. Tables are additive; `user_version` stays 1. Creating or saving an item does not publish a share. Each successful create, edit, media replace, or restore writes a snapshot. Existing items without history are backfilled from the current row on the first history read.

Exports use `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. Documents are `text/plain`, websites are sanitized HTML, whiteboards are SVG, and media is the original sniffed bytes. Share links do not gain an export route in this slice.

## Permissions

Workspace members may list, read and create items. The author, an owner or an admin may edit, replace media, remove, or create/revoke shares. A member cannot change or share someone else's item (`403`). Callers who cannot see the workspace receive `404`.

## Rendering and safety

Documents are escaped text. Websites and whiteboards are sanitized and served with a CSP `sandbox` that does not allow scripts. Media is served with the sniffed MIME type, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`. The management page does not insert unsanitized HTML. This is a CSP/sandbox and MIME-sniffing boundary on the management host, not a separate browser origin.

## Not claimed

No public homepage, no scripted web apps, no meeting-notes ingest, no Teamily comparison, no browser E2E. This issue stays open until those are done and compared.
