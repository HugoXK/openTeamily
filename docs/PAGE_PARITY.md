# Page parity pass (2026-11-19)

One page-by-page pass that compares OpenTeamily renders with private, read-only
Teamily reference captures and recreates the look with original CSS and inline
SVG. **No Teamily screenshots, logos, icons, fonts or account text are in this
repository.** The reference captures stay on the reviewer's machine; the file
names below only identify which private capture a row was compared against.

Renders were taken at 1280×800 against the synthetic CI fixture
(`python3 scripts/ci_ui_screenshots.py --serve`). This is a visual-parity pass,
**not** an acceptance claim: CI passing is not Teamily + Impeccable acceptance,
and disabled or unconnected controls stay disabled and labelled.

Shared changes (all pages): lighter green-grey ground, darker AA-safe accent
(`#097845`), white rounded main canvas, 14px workspace base size, toned
two-letter avatars/monograms, pill searches with a leading icon, plain-text
category chips with a single green pill, compact 2.5rem list rows, white cards
with a 1px ring instead of heavy shadows.

| Page | Teamily evidence file (private) | OT render | Differences fixed | Remaining differences |
|---|---|---|---|---|
| Chat – conversation | 01a-chat-normal, 01b-chat-message-hover, 01b2-chat-message-context-menu | chat-agent | Session pane is a white panel; pill search with icon; green round “+”; 11–12px section labels; 2.5rem toned avatars; selected row soft green without ring; floating rounded header card with pill text actions and 14px title; mine bubble light green, agent replies white ring cards; per-message actions only on hover/focus (Teamily has no hover toolbar); hint strip above composer; rounded composer with bottom tool row and green pill send. | No right-click context menu yet (actions stay as hover buttons); header has no status line or avatar stack; no in-stream artifact cards / suggestion chips (no such data). |
| Chat – create menu | 03a-chat-create-menu | chat-new-menu | Floating menu card with original 16px stroke icons per item. | Items Teamily offers that we do not implement are not added. |
| Chat – new group | 03b-new-group-dialog-custom, 03c-new-group-dialog-ai-team-tab | chat-group-create | Centered modal with scrim; full-width segmented tab switch; two-column picker and name layout; pill member search; checkbox rows on one line; footer actions with green submit. | No close “×”, no friends/agents split headers, no 付款方式 row (no payments by design). |
| Chat – search | 01c1-chat-search-empty, 01c2-chat-search-test-results | chat-search | Underline tab strip, section headings, single-line results. | Teamily search opens as a right-side panel with thumbnails. |
| Chat – group | 10a/10b-group-chat-view, 10c/10d-group-info-panel-* | chat-group | Same header/bubble/composer language; group agent action is a compact card. | No right-side group info panel (member tabs, 群公告, toggles) yet — the in-stream 群内智能体 card remains. |
| Discover – feed | 2026-11-17 pm discover | discover | Open toolbar (no boxed card), pill search left, 关注/动态 underline tabs right, chip row, cover-first cards with kind badge on the cover, no grey grid container. | Covers are tinted per kind, not real thumbnails (no thumbnail service); no author avatars or like counts on the card face. |
| Discover – agents | 06a-discover-agents-grid, 06b-discover-creator-dropdown | discover-agents | Pill search with icon, green create pill, plain-text chips with green 全部, 创建者 row, 3-column white cards, toned two-letter monograms, outlined 聊天 pill. | Category chips and 聊天 stay disabled (catalog has no category/chat API); creator dropdown is not a menu. |
| Agents | 06a-discover-agents-grid (same directory language) | agents | Same toolbar, chips and card grid as the directory; monogram avatars; outlined 聊天 link. | Workspace picker and signed-in line kept (self-hosted multi-workspace). |
| Settings hub | 04a-settings-top, 04b-settings-bottom | settings | Centered ~32rem column, 11px group labels, white rounded groups, 2.5rem rows with 16px outline icons and muted chevrons, compact identity card and 成员 pill. | No usage/credits card and no 创作者与奖励 / 套餐 groups (out of scope by design). |
| Settings – language | 09c-settings-language | settings-language | Plain “‹ 语言” back header; label above full-width rounded selects in one white card; checkbox row. | — |
| Settings – Agent API | 09d-settings-agent-access | settings-agent-access | Plain back header, grey empty boxes, accurate note pointing to per-agent API keys on /agents. | Keys are not aggregated on this page; no AI-client authorisation. |
| Settings – connectors / channels | 09f-settings-connectors, 09i-settings-channels | settings-connectors, settings-channels | Plain back header, compact rows, pill actions. | Connect actions stay unconnected (no OAuth). Skill configuration and runtimes subpages live elsewhere (/runtimes). |
| Space (works) | 07a/07b/07c-space-* | space | Full-height white directory column at the left; scope/filter/layout toolbar across the top of the content; green 新建 pill, pill search, kind list with soft-green current row; centered empty state with tinted CTA rows and round green arrows. Also fixes a nested `<form>` that ended the editor form early (save/back/delete buttons rendered outside the editor). | No populated grid comparison (reference account had no works). |
| Memory | 05a-memory-overview, 05b-memory-item-hover, 05c-memory-detail | memory | Full-height white directory column; slim stats bar; pill topic search; white dotted graph card; white 话题亮点 card with underline tabs; compact filters and view list. | Stats are a text line, not number columns; no visible 总览 title; detail editor not restyled. |
| Automations, members, guide, profile, onboarding, team, runtimes | 2026-11-17 recapture runtimes-*, 08a/08b profile | (shared) | Shared tokens, canvas, inputs, buttons, rows. | Not individually re-laid-out in this pass. |

## Impeccable

`impeccable detect` (v4.9.2) was run on the changed sources and on rendered
snapshots of the main pages (computed DOM with the page CSS inlined).
Fixed: side-tab accent borders (forwarded quote, memory topic cards), a 4.48:1
hover contrast (accent darkened to `#097845`), cramped fieldset padding, sub-12px
chat text. Remaining advisories: *nested cards* (the white canvas holding white
cards mirrors the layered Teamily layout), *flat type hierarchy* on settings
(11px group labels follow the reference), one hover-contrast report on settings
that could not be tied to a visible control, and a clipped positioned child in
the space directory.
