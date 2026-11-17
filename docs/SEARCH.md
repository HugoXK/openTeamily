# Workspace message search

Related: [#88](https://github.com/openTeamily/openTeamily/issues/88), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#4](https://github.com/openTeamily/openTeamily/issues/4).

This slice adds a **server-side, authorization-scoped** message search across the messages a caller may already read, written for OpenTeamily. It is a bounded substring scan, **not** a full-text index, ranking model, semantic/vector search, or Teamily search parity. It does not add a cross-workspace/global search.

## Route

`GET /v1/workspaces/{workspace_id}/search/messages?q=&kind=all|agent|social&limit=&cursor=`

- Requires a session. The caller must belong to the workspace; outsiders get `404`.
- `q`: 1–80 characters, no control characters. Required.
- `limit`: `1..50` (default 20).
- `cursor`: optional 32-hex message id; keyset order is by UUID, not chronological, matching the workspace listing convention.
- Only `GET`; a query on `POST` is already rejected by the API-wide rule.

Returns `{items:[{kind, conversation_id, message_id, title, snippet, created}], cursor}`.

## Authorization

- `kind=agent`: only the caller's own user↔agent conversations (`agent_conversations.user_id` = caller). Workspace admins do **not** gain access to other members' private agent conversations.
- `kind=social`: only social conversations the caller is a member of (`social_members`).
- `kind=all`: the union of the two.

The workspace id is also part of every query, so a caller cannot search another workspace's rows even with a foreign conversation id.

## Bounds and safety

- Results are snippets capped at 160 characters; newlines/whitespace are collapsed.
- No token, API key, cookie or secret is selected by the query.
- The scan is bounded by the page size and the internal per-table limit; there is no timeout-based cancellation or background indexing. Operators may add a future deduplicated full-text index without changing the response shape.

## Page wiring

The API is available now. The `/chat` search box still filters already-loaded session rows client-side; wiring it to this endpoint (with result navigation) is tracked as follow-up because it needs both agent and social conversation routing. Do not describe the current UI search as server-side.

## Explicitly not in this slice

- Full-text/`FTS5` index, ranking, highlights beyond a plain snippet, semantic/vector search.
- Global (cross-workspace) search, cross-instance federation, Bot Social transport.
- Browser E2E and Teamily comparison. Tests are in-process WSGI + temporary SQLite.
