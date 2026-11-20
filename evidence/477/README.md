# #477 evidence — public AI-team directory on /discover

Arms (both from the same seeded instance, only the code differs):

| arm | sha |
|---|---|
| before | `af33df0f0ff16007c02fa6818f1f58e3918927f4` (live main, PR not applied) |
| after | `9fafbf2da219752a2b662f4aaacb208c2267f5b1` (PR #477 tip, rebased on af33df0) |

Route: `/discover?tab=agents&section=groups` (the `AI 团队` tab).
Locale `zh-CN`, theme `light` only: the page carries no language switch, and dark
comes from `prefers-color-scheme`, so the slice is one theme. Viewports per the
owner rule: 1440x900 (desktop) and 390x844 (mobile).

## Frames

| file | state | reading |
|---|---|---|
| `before/zh-CN__light__1440x900__discover__teams-before.png` | before | `#teams-note`「公开 AI 团队目录还没有接口，所以这里不会列出模板卡片。也不会复制对照里的团队名称或创建者品牌。」, `.catalog-team` count=0 |
| `after/zh-CN__light__1440x900__discover__teams-empty.png` | after, instance has no listed team | `#discover-empty`「本实例还没有公开的 AI 团队。创建一个团队，再到团队成员页把它登记到公共目录，就会出现在这里。」, `#catalog-count`「0 支团队」 |
| `after/zh-CN__light__1440x900__discover__teams-listed.png` | after, one listed team | card name「[CI FIXTURE] 发现团队 Alpha」, `.catalog-team .meta`「1 位成员 · 已加入」, `#catalog-count`「已显示 1 支团队」 |
| `after/zh-CN__light__1440x900__discover__teams-no-match.png` | after, query `zzz-no-such-team` | `#teams-search-note`「没有匹配的公开 AI 团队，换一个关键词或清空搜索。」, cards=0, count empty |
| `after/zh-CN__light__390x844__discover__teams-listed.png` | after, one listed team, mobile | same card and meta as desktop at 390 wide, `scrollWidth=390` |

## Fixture (real rows, no replay)

The seeded instance has no team in the public directory, so every state seeds one
through the instance's own API with the signed-in owner session:

1. `POST /v1/workspaces {"name":"[CI FIXTURE] 发现团队 Alpha"}` with
   `Idempotency-Key: evidence477-team-0001` → owner workspace
2. `POST /v1/workspaces/{wid}/directory {"listed":true,"summary":"合成团队，用于公开目录截图，不是生产数据。"}`
3. read back `GET /v1/team-directory?limit=12` and wait for the rendered cards

The **before** arm runs the same seeding before it is shot, so its frame is not
"the instance is empty": the directory API answers one listed team
(`apiItems=1` in `report.json`) and the old page still shows text only. The
empty state explicitly unlists the fixture team first (`apiItems=0`).

`teams-no-match` types the query into `#catalog-query` and submits the real
`#catalog-search` form, so the request goes to
`GET /v1/team-directory?q=zzz-no-such-team&limit=12`.

## Reading the report

`report.json` carries, per image: arm, state, viewport, locale, theme, PNG
dimensions (`viewport_size_ok` compares them with the viewport), sha256, DOM
facts (`scrollWidth`, the `#teams-note` / `#discover-empty` /
`#teams-search-note` / `.catalog-team` readings, the API row count) and the
console lines. All five frames: PNG size equals the viewport, `scrollWidth`
equals the viewport width (no horizontal overflow), console errors = 0.

`Reuse: dsh dsh-client-ui-theme` (theme tokens only) — the page resolves its own
`prefers-color-scheme`; the light arm is the default. Viewports are the owner
rule, not a dsh constant (dsh ships no px breakpoint).

Reproduced with `scripts/evidence.sh` (three restricted passes, merged into one
report; `STATE_FILE=notes/tmp/ev477-states.mjs` carries the seeding states):

```
GRID_VIEWPORTS=1440x900 GRID_LOCALES=zh-CN GRID_THEMES=light STATE_FILE=... \
  bash scripts/evidence.sh 477 af33df0 - "/discover?tab=agents&section=groups" teams-before
MERGE=1 GRID_VIEWPORTS=1440x900 ... bash scripts/evidence.sh 477 - 9fafbf2d \
  "/discover?tab=agents&section=groups" "teams-empty,teams-listed,teams-no-match"
MERGE=1 GRID_VIEWPORTS=390x844 ... bash scripts/evidence.sh 477 - 9fafbf2d \
  "/discover?tab=agents&section=groups" teams-listed
```
