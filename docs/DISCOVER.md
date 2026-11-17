# Discover: opt-in public agent catalog

Related: [#87](https://github.com/openTeamily/openTeamily/issues/87), [#89](https://github.com/openTeamily/openTeamily/issues/89), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#12](https://github.com/openTeamily/openTeamily/issues/12), [#6](https://github.com/openTeamily/openTeamily/issues/6).

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

`/discover` is a same-origin management page. With no query it renders the recorded 关注 / 动态 feed chrome: a search field, those two tabs, and the captured category chips. The activity feed, follow API, feed search, and category filters stay unconnected — there is no public feed or follow API. The 关注 tab shows the recorded empty copy「关注列表暂无动态」/「你关注的人发布动态后会显示在这里。」and an honest note that follow is not wired. The page does not invent feed cards, recommendations, or reward/credits banners. Other HTML queries remain rejected except the recorded catalog views at `/discover?tab=agents` and `/discover?tab=agents&section=groups`.

`/discover?tab=agents` still renders the public agent catalog and, for a selected workspace, lets an owner/admin publish or revoke a slug. The public API can be consumed without a session. The public cards stay visible without a session; authenticated listing management is collapsed below the directory. Search submits the existing name/summary `q` API, 12 results per cursor page, with clear, loading, empty and error states. The count says how many have been displayed, not a fabricated total. Card initials are generated locally, not third-party avatars.

The catalog toolbar keeps the recorded 智能体 / AI 团队 tabs, search field, and「创建我的智能体」action. Below that, the page now lays out the recorded category chip row (全部, then the visible English labels through Marketing, plus a category-search control and a more chevron) and a creator dropdown labeled「创建者」. Those filter controls stay visibly present but disabled: the public catalog projection has no category or creator field, the recapture did not open the category-search panel or the overflow, and no hidden categories or a selected Teamily creator value are invented. A visually hidden note still states that the filters are unconnected. Card chat actions stay explicitly unconnected. No `/d/{slug}` route or secret homepage token is invented.

`/discover?tab=agents&section=groups` lays out the recorded AI 团队 directory chrome: the 智能体 / AI 团队 tabs, a search field with the captured placeholder,「+ 创建我的 AI 团队」, the captured category chips starting with All through Sales, a more chevron, and a creator dropdown labeled「创建者」. Those controls stay unconnected because there is no public team-catalog API. The recapture did not open the overflow, so no hidden categories are invented, and the selected「Teamily AI」creator value is not copied. Create and card-create actions stay disabled; this page does not open a group-creation dialog or invent template cards from the contrast screenshot. An honest note explains that the catalog is not wired.

CI captures the default feed chrome, the recorded 关注 empty state, the agent catalog filter chrome with synthetic opt-in listings, matching/empty search, cursor paging, and the recorded AI 团队 chrome. This is not a Teamily or Impeccable acceptance.

## Explicitly not in this slice

- Recommendation/ranking, a real public feed, follow/like/comment, or reward campaigns.
- Public conversation or agent execution from a listing.
- Cross-instance federation, Bot Social transport, or any Teamily comparison.
- Browser acceptance. Tests are in-process WSGI + temporary SQLite and pure Node helpers.
