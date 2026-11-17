# Workspace message search

Related: [#88](https://github.com/openTeamily/openTeamily/issues/88), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#4](https://github.com/openTeamily/openTeamily/issues/4).

This slice adds a **server-side, authorization-scoped** message search across the messages a caller may already read, written for OpenTeamily. It is a bounded substring scan, **not** a full-text index, ranking model, semantic/vector search, or Teamily search parity. It does not add a cross-workspace/global search.

## Route

`GET /v1/workspaces/{workspace_id}/search/messages?q=&kind=all|agent|social&limit=&cursor=&conversation_id=`

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

The unified `/chat` sidebar message tab calls this endpoint and can open authorized agent or social conversations from results. The other tabs use existing workspace data or are labeled unimplemented. This is workspace-authorized search, not an instance-wide index. Results remain bounded to the requested page.

## Explicitly not in this slice

- Full-text/`FTS5` index, ranking, highlights beyond a plain snippet, semantic/vector search.
- Global (cross-workspace) search, cross-instance federation, Bot Social transport.
- Teamily comparison and a separate, uncaptured search-dialog layout. Authorization tests use in-process WSGI + temporary SQLite; fixture-only browser checks cover global and current-conversation search.


## Conversation-header search

The `/chat` header search reuses the existing message panel with an explicit
“仅搜索当前对话” scope. The left sidebar search remains workspace-wide; switching
to a non-message tab or closing the panel clears the conversation scope.
`conversation_id` is optional, exactly 32 lowercase hex characters when present.
It narrows both authorized agent/social queries **before** cursor pagination;
it never replaces user, membership or workspace checks. A nonexistent or
inaccessible conversation produces no results, not a permission bypass.

This is a functional scope correction based on the recorded conversation-header
search action, not a claim about an uncaptured separate search-dialog layout.
No separate panel is invented and no Teamily writes were performed.
