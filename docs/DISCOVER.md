# Discover: opt-in public agent catalog

Related: [#87](https://github.com/openTeamily/openTeamily/issues/87), [#89](https://github.com/openTeamily/openTeamily/issues/89), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#12](https://github.com/openTeamily/openTeamily/issues/12), [#6](https://github.com/openTeamily/openTeamily/issues/6).

This documents the **opt-in** public agent catalog and the **opt-in** public works feed, written for OpenTeamily. It is **not** Teamily Discover parity: there is no recommendation, ranking, follow, like, comment, or federation. Agent listings expose only name, summary and a public slug. Work listings expose only title, kind, author, updated time and a `/w/{slug}` path. Instructions, document bodies in the listing API, workspace ids, artifact ids and homepage tokens are not included in the public JSON.

## Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/v1/discover/agents?q=&limit=&cursor=` | none | Public listing. `limit=1..50` (default 20), keyset `cursor` = last slug, optional `q` (≤80 chars) matches name/summary. |
| GET | `/v1/workspaces/{id}/agents/{agent_id}/discover` | member | `{discover:{listed, slug?, updated?}}` |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/discover` | owner/admin | `{slug}`. Publish or update the listing. `201` on first, `200` on update. |
| POST | `/v1/workspaces/{id}/agents/{agent_id}/discover/revoke` | owner/admin | Unlist immediately. |
| GET | `/v1/discover/works?q=&limit=&cursor=` | none | Public works feed. `limit=1..50` (default 20), keyset `cursor` = `{updated}.{slug}`, optional `q` (≤80 chars) matches title or author username. |
| GET | `/w/{slug}` | none | Public HTML page for a listed work, using the existing artifact share renderer. Unlisted or unknown slugs are `404`. |
| GET | `/v1/workspaces/{id}/artifacts/{artifact_id}/discover` | member | `{discover:{listed, slug?, updated?}}` |
| POST | `/v1/workspaces/{id}/artifacts/{artifact_id}/discover` | owner/admin | `{slug}`. Publish or update the listing. `201` on first, `200` on update. |
| POST | `/v1/workspaces/{id}/artifacts/{artifact_id}/discover/revoke` | owner/admin | Unlist immediately. Public `/w/{slug}` then returns `404`. |

Management writes require a session, exact Origin and CSRF. Members may read metadata; owner or admin may change it. Outsiders receive `404`.

## Slug and listing rules

- `slug`: 3–30 characters, `[a-z0-9][a-z0-9-]{1,28}[a-z0-9]`, unique within its table, and not a reserved management path (`settings`, `team`, `chat`, `discover`, `v1`, `w`, `works`, `feed`, …). Agent slugs and work slugs are independent.
- Archived agents cannot be listed (`409`), and an archived agent disappears from the public listing even if a listing row remains.
- A slug conflict returns `409`.
- The public projection is `{slug, name, summary, updated}`; `summary` is truncated to 500 characters. No token is involved: the discover slug is independent of the unlisted `/a/{token}` homepage.

## Storage

Additive `agent_discover` and `artifact_discover` tables (`CREATE TABLE IF NOT EXISTS`) with unique global `slug` indexes in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the tables on next start.

## Page

`/discover` is a same-origin management page. With no query it renders the recorded 关注 / 动态 feed chrome: a search field, those two tabs, and the captured category chips. The default `/discover` activity tab loads `GET /v1/discover/works` and shows cards for opted-in works. Each card links to `/w/{slug}`. Search uses the title/author `q` parameter; supported type chips use the kind parameter; other category chips stay disabled. The 关注 tab is still unconnected and keeps the recorded empty copy「关注列表暂无动态」/「你关注的人发布动态后会显示在这里。」and an honest note that follow is not wired. The page does not invent likes, follows, recommendations, or reward/credits banners. Works appear only after an owner or admin publishes them from the artifacts editor. Other HTML queries remain rejected except the recorded catalog views at `/discover?tab=agents` and `/discover?tab=agents&section=groups`.

`/discover?tab=agents` still renders the public agent catalog and, for a selected workspace, lets an owner/admin publish or revoke a slug. The public API can be consumed without a session. The public cards stay visible without a session; authenticated listing management is collapsed below the directory. Search submits the existing name/summary `q` API, 12 results per cursor page, with clear, loading, empty and error states. The count says how many have been displayed, not a fabricated total. Card initials are generated locally from the first letter or digit in the name, skipping leading punctuation, not third-party avatars. That matches the public agent homepage initial and avoids showing "[" for fixture names such as "[CI FIXTURE] Directory assistant".

The catalog toolbar keeps the recorded 智能体 / AI 团队 tabs, search field, and「创建我的智能体」action. Below that, the page now lays out the recorded category chip row (全部, then the visible English labels through Marketing, plus a category-search control and a more chevron) and a creator dropdown labeled「创建者」. The chips stay on one row: overflowing labels scroll horizontally, while the search and more controls stay visible at the end. Those filter controls stay visibly present but disabled: the public catalog projection has no category or creator field, the recapture did not open the category-search panel or the overflow, and no hidden categories or a selected Teamily creator value are invented. A visually hidden note still states that the filters are unconnected. Card chat actions stay explicitly unconnected. No `/d/{slug}` route or secret homepage token is invented.

`/discover?tab=agents&section=groups` lays out the recorded AI 团队 directory chrome: the 智能体 / AI 团队 tabs, a search field with the captured placeholder,「+ 创建我的 AI 团队」, the captured category chips starting with All through Sales, a more chevron, and a creator dropdown labeled「创建者」. The team category chips also stay on one row with horizontal overflow, and the more chevron remains visible at the end. Those controls stay unconnected because there is no public team-catalog API. The recapture did not open the overflow, so no hidden categories are invented, and the selected「Teamily AI」creator value is not copied. Create and card-create actions stay disabled; this page does not open a group-creation dialog or invent template cards from the contrast screenshot. An honest note explains that the catalog is not wired.

CI captures the default feed with the opted-in fixture document card, the recorded 关注 empty state, the agent catalog filter chrome with synthetic opt-in listings, matching/empty search, cursor paging, and the recorded AI 团队 chrome. This is not a Teamily or Impeccable acceptance.

## Explicitly not in this slice

- Recommendation/ranking, follow/like/comment, category-filtered feeds, or reward campaigns.
- Public conversation or agent execution from a listing.
- Cross-instance federation, Bot Social transport, or any Teamily comparison.
- Browser acceptance. Tests are in-process WSGI + temporary SQLite and pure Node helpers.


## Work type filters

The activity feed now accepts `kind=document|website|image|audio|video|slides|whiteboard|dashboard|media`.
An omitted or empty kind lists all opted-in works. Invalid or repeated kind parameters return 400.
Filtering is performed in SQLite before search, limit and recency cursor pagination; image/audio/video
come from sniffed media MIME. The recorded 网页、图片、音乐、幻灯片、视频 chips call this API,
reset the cursor on selection, and combine with title/author search. 全部 clears the kind.
Other categories, popularity ranking, likes and following remain unconnected. No new categories are invented.
This is functional implementation, not Teamily + Impeccable acceptance.
