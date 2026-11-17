# Discover: opt-in public agent catalog

Related: [#87](https://github.com/openTeamily/openTeamily/issues/87), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#12](https://github.com/openTeamily/openTeamily/issues/12), [#6](https://github.com/openTeamily/openTeamily/issues/6).

This slice adds an **opt-in** public catalog of workspace agents, written for OpenTeamily. It is **not** Teamily Discover parity: there is no recommendation, ranking, public feed, follow, like, comment, or federation. Only the agent name, summary and a public slug are exposed; instructions, workspace ids and homepage tokens never are.

## Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/v1/discover/agents?q=&limit=&cursor=` | none | Public listing. `limit=1..50` (default 20), keyset `cursor` = last slug, optional `q` (≤80 chars) matches name/summary. |
| GET | `/v1/workspaces/{id}/agents/{agent_id}/discover` | member | `{discover:{listed, slug?, updated?}}` |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/discover` | owner/admin | `{slug}`. Publish or update the listing. `201` on first, `200` on update. |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/discover/revoke` | owner/admin | Unlist immediately. |

Management writes require a session, exact Origin and CSRF. Members may read metadata; owner or admin may change it. Outsiders receive `404`.

## Slug and listing rules

- `slug`: 3–30 characters, `[a-z0-9][a-z0-9-]{1,28}[a-z0-9]`, globally unique, and not a reserved management path (`settings`, `team`, `chat`, `discover`, `v1`, …).
- Archived agents cannot be listed (`409`), and an archived agent disappears from the public listing even if a listing row remains.
- A slug conflict returns `409`.
- The public projection is `{slug, name, summary, updated}`; `summary` is truncated to 500 characters. No token is involved: the discover slug is independent of the unlisted `/a/{token}` homepage.

## Storage

Additive `agent_discover` table (`CREATE TABLE IF NOT EXISTS`) with a unique global `slug` index in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the table on next start.

## Page

`/discover` is a same-origin management page. With no query it renders the recorded 关注 / 动态 feed chrome: a search field, those two tabs, and the captured category chips. The feed, follow view, feed search, and category filters are explicitly unconnected — there is no public feed API, so the page states that clearly and does not invent cards, recommendations, or reward banners. Other HTML queries remain rejected except the recorded catalog view at `/discover?tab=agents`.

`/discover?tab=agents` still renders the public agent catalog and, for a selected workspace, lets an owner/admin publish or revoke a slug. The public API can be consumed without a session. The public cards stay visible without a session; authenticated listing management is collapsed below the directory. Search submits the existing name/summary `q` API, 12 results per cursor page, with clear, loading, empty and error states. The count says how many have been displayed, not a fabricated total. Card initials are generated locally, not third-party avatars. Card chat actions, AI teams, category and creator filters are explicitly unconnected: the public projection has no execution path or those metadata fields. No `/d/{slug}` route or secret homepage token is invented.

CI captures the default feed chrome and, on `?tab=agents`, synthetic opt-in listings for populated cards, matching/empty search, and cursor paging. This is not a Teamily or Impeccable acceptance.

## Explicitly not in this slice

- Recommendation/ranking, a real public feed, follow/like/comment, or reward campaigns.
- Public conversation or agent execution from a listing.
- Cross-instance federation, Bot Social transport, or any Teamily comparison.
- Browser acceptance. Tests are in-process WSGI + temporary SQLite and pure Node helpers.
