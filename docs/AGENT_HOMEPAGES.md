# Agent public homepages

Related: [#6](https://github.com/openTeamily/openTeamily/issues/6), [#14](https://github.com/openTeamily/openTeamily/issues/14), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice adds an **unlisted, revocable public homepage** for a workspace agent. It is self-written for OpenTeamily and is **not** Teamily or Impeccable comparison acceptance. Anyone with the link can see the agent's name, summary, and any stored quick starts. Instructions, workspace identifiers, and the share token never appear on the public page.

The public HTML now follows the recorded public agent-profile typography: a FlyBot top bar with an "Agent profile" crumb, a two-column layout with identity (letter avatar, name, summary), "Talk via" (Web plus a disabled Channels chip), a "Start a conversation" list, a "Web conversation" panel with typography-only Quick starts cards and a disabled composer, and a "Built with FlyBot / Create your own Agent" footer. The create control is a link to the existing `/agents` workspace page; the public page still does not create an agent itself. Optional owner-set `quick_starts` (up to five short public strings) appear in the left list and right cards when stored. When none are stored, the page shows an honest 未接通 empty note and does not invent official Teamily Agent prompts. The conversation panel is typography only and still does not run the agent, send a starter, call a model, or embed a chat. CI captures this page from the throwaway fixture as `77-agent-public-homepage.png`. The share path is handed to the screenshot harness through a 0600 sidecar, not `ready.json`.

## Routes

Management writes need a session, CSRF, and exact Origin. Callers outside the workspace receive `404`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/workspaces/{workspace_id}/agents/{id}/homepage` | Current homepage metadata on the agent snapshot. Members may read. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/homepage` | Publish or rotate. Owner or admin only. The full token and `/a/{token}` path are returned once. |
| POST | `/v1/workspaces/{workspace_id}/agents/{id}/homepage/revoke` | Revoke the active link. Owner or admin only. |
| GET | `/a/{token}` | Public HTML page. No session required. Invalid, revoked, or archived tokens are `404`. Query strings and non-GET methods are `400`. |

Agent list, create, read, update, and archive responses include a `homepage` object and a `quick_starts` list. The homepage default is `{ "visibility": "restricted" }`. After publish, later reads include `visibility`, `prefix`, and `created`, but not `token` or `path`. `quick_starts` is an optional field on create and update: omit it on update to leave the stored list unchanged; send an empty list to clear it. The strings are stored on a side table, not as an `ALTER` of `workspace_agents`.

## Record shape and bounds

Homepage metadata: `visibility` (`restricted` or `public`), optional `prefix` (first 8 characters of the token), optional `created`. The publish response also includes `token` (43 URL-safe characters) and `path` (`/a/` plus the token).

- Only one active homepage exists per agent. Publishing again revokes the previous token and issues a new one.
- Archiving an agent revokes its active homepage. Archived agents cannot be published (`409`).
- Tokens are stored as a digest with prefix only. They are not written to lists, logs, or later API reads.
- The public page is typography only. It is not a conversation surface and does not run the agent, send a starter, or call a model. The composer Send control stays disabled. "Create your own Agent" links to `/agents` and does not create from the public page. The Content-Security-Policy is unchanged (`default-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, sandbox without scripts).
- Quick starts are public typography only: at most 5 strings, each 1–80 characters after trim, with no control characters. They never include instructions.

## Permissions

- Workspace members can read homepage metadata for agents they can already see.
- Owner and admin can publish, rotate, and revoke, and can set or clear `quick_starts` on create or update.
- A member who tries to write receives `403`. A caller outside the workspace receives `404`.
- A restricted agent has no working public URL, even if someone knows the agent id.

## Explicitly not in this slice

- Embeddable conversations or a relaxed `frame-ancestors` policy. Public pages send `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- Auto / Instant / Agentic or any other invented mode field.
- Clickable starters that send a message or start a model call from the public page.
- A creator form on the public page, or edits to the workspace agents directory form.
- Official Teamily Agent prompt copy, Teamily marks, a verified badge, or a LIVE chip.
- A public directory or search index of agents.
- Teamily comparison or browser end-to-end acceptance. Issues #6 and #14 stay open.

## Tests

`tests/test_agent_homepage.py` uses in-process WSGI and a temporary SQLite file. It covers publish-once tokens, instruction hiding, recorded typography and escaping, optional quick starts (set, keep, clear, reject invalid values, hide instructions), member/admin/outsider permissions, revoke, rotate, archive, CSRF, and additive schema on an existing v1 database. It is not a live container run, a browser acceptance, or proof of Teamily parity.
