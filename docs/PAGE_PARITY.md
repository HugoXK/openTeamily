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
| Chat – conversation | 01a-chat-normal, 01b-chat-message-hover, 01b2-chat-message-context-menu | chat-agent | Session pane is a white panel; pill search with icon; green round “+”; 11–12px section labels; 2.5rem toned avatars; selected row soft green without ring; floating rounded header card with pill text actions and 14px title; mine bubble light green, agent replies white ring cards; per-message actions only on hover/focus (Teamily has no hover toolbar); hint strip above composer; rounded composer with bottom tool row and green pill send. Group headers now stack up to four member/agent monograms. A message attachment renders as a small cover card (kind tint + title + download), not a bare link. | Suggestion chips still need stream data; covers are kind-tints, not thumbnails. |
| Chat – message menu | 01b2-chat-message-context-menu | msg-menu | Right-click on a group/DM message opens a floating menu: reaction row (real reaction API), 回复 (quotes into the composer), 复制, 转发 (multi-select with this message picked), 置顶 / 取消置顶, 选择消息, 撤回 (own messages, existing confirm). | 保存到资料空间, 翻译 and 删除 are shown disabled and tagged 未接通 (no social save/translate/delete API). Agent-conversation messages keep their own save button. |
| Chat – reply states | 13a/13b/13c/13d-bug-agent-* | chat-agent-sent | Header status line under the title (AI 智能体 · 经运行时回复 / 正在回复… / group counts / 单聊 · N 人); a queued or running reply is a white card headed 正在准备回复 / 正在生成回复 with the honest queue detail; agent name instead of a generic label; failed replies are a soft red note. | No token streaming (runtime replies arrive whole); no cold-start timing text. |
| Chat – create menu | 03a-chat-create-menu | chat-new-menu | Floating menu card with original 16px stroke icons per item. | Items Teamily offers that we do not implement are not added. |
| Chat – new group | 03b-new-group-dialog-custom, 03c-new-group-dialog-ai-team-tab | chat-group-create | Centered modal with scrim; full-width segmented tab switch; two-column picker and name layout; pill member search; checkbox rows on one line; footer actions with green submit. | No close “×”, no friends/agents split headers, no 付款方式 row (no payments by design). |
| Chat – search | 01c1-chat-search-empty, 01c2-chat-search-test-results | chat-search | Sidebar search: underline tab strip, section headings, single-line results. In-chat search is now a right-hand panel with a pill field, scope line and rows (avatar, author, time, highlighted snippet). | In-chat search covers messages only — 资料/照片/文件 tabs are stated as 未接通; no thumbnails. |
| Chat – group | 10a/10b-group-chat-view, 10c/10d-group-info-panel-* | chat-group | Same header/bubble/composer language; group agent action is a compact card. New 群信息 header button opens a right-hand panel: monogram, name, “N 位成员 · N 位真人 · N 位智能体”, 搜索聊天记录 (opens in-chat search), 群公告, 视频/语音通话, Agent 主动性 / 自动翻译 / 消息免打扰 / 置顶聊天 switches, 智能体 / 成员 tabs with rows. The in-stream 群内智能体 note and request card now use the same white ring-card language as the group-info panel (text, including the 未接通 line, is unchanged). | 群公告 发布, calls, Agent 主动性, 自动翻译 and 免打扰 are disabled and labelled 未接通; only 置顶聊天 works (existing pin API). No 付费模式 (out of scope). |
| Discover – feed | 2026-11-17 pm discover | discover | Open toolbar (no boxed card), pill search left, 关注/动态 underline tabs right, chip row, cover-first cards with kind badge on the cover, no grey grid container. | Covers are tinted per kind, not real thumbnails (no thumbnail service); no author avatars or like counts on the card face. |
| Discover – agents | 06a-discover-agents-grid, 06b-discover-creator-dropdown | discover-agents | Pill search with icon, green create pill, plain-text chips with green 全部, 创建者 row, 3-column white cards, toned two-letter monograms, outlined 聊天 pill. | Category chips and 聊天 stay disabled (catalog has no category/chat API); creator dropdown is not a menu. |
| Agents | 06a-discover-agents-grid (same directory language) | agents | Same toolbar, chips and card grid as the directory; monogram avatars; outlined 聊天 link. | Workspace picker and signed-in line kept (self-hosted multi-workspace). |
| Settings hub | 04a-settings-top, 04b-settings-bottom | settings | Centered ~32rem column, 11px group labels, white rounded groups, 2.5rem rows with 16px outline icons and muted chevrons, compact identity card and 成员 pill. | No usage/credits card and no 创作者与奖励 / 套餐 groups (out of scope by design). |
| Settings – language | 09c-settings-language | settings-language | Plain “‹ 语言” back header; label above full-width rounded selects in one white card; checkbox row. | — |
| Settings – Agent API | 09d-settings-agent-access | settings-agent-access | Plain back header, grey empty boxes, accurate note pointing to per-agent API keys on /agents. | Keys are not aggregated on this page; no AI-client authorisation. |
| Settings – connectors / channels | 09f-settings-connectors, 09i-settings-channels | settings-connectors, settings-channels | Plain back header, compact rows, pill actions. | Connect actions stay unconnected (no OAuth). |
| Settings – skill configuration | 09e-settings-skill-configuration | settings-skill-configuration | New `/settings/skill-configuration` subpage: “‹ 技能配置” back, green info banner, collapsible “正在编写 Skill?”, “我的密钥” with a green “+ 添加密钥”, empty state “暂无密钥”. Adding a key uses the existing write-only `/v1/skill-secrets` API; values are never echoed. | No in-product Skill-authoring tutorial (the disclosure only restates the name rules). |
| Settings – runtimes | 09g-settings-runtimes-top, 09h-settings-runtimes-bottom | runtimes | `/runtimes` now uses a “‹ 运行时” back header, underline 运行时/连接 tabs, white ring cards with glyphs, a local FlyBot card with numbered three-step setup and zipapp download tiles, and a detected-runtime bar with 检测 / + 连接远程机器. Hosted cloud Agent and hosted computer stay honestly 未提供 / 即将推出. | OpenTeamily has no hosted cloud Agent, hosted computer, or official desktop app; download tiles point at flybot.pyz and `/download`, not a vendor desktop package. |
| Space (works) | 07a/07b/07c-space-*, 11a–11d | space | Full-height white directory column at the left; scope/filter/layout toolbar across the top of the content; green 新建 pill, pill search, kind list with soft-green current row; centered empty state with tinted CTA rows and round green arrows. Also fixes a nested `<form>` that ended the editor form early (save/back/delete buttons rendered outside the editor). Populated library (11a–11d): grid cards with a kind badge (DOC/WEB/…), ⋯ menu shown on hover, soft kind-tinted cover, title and source line; list view with 名称 / 来源 / 创建时间 / 最近动态 columns from real `created`/`updated`; ⋯ menus — grid 重命名/删除, list 发送到聊天/重命名/删除 — where 重命名 opens the editor on the title and 删除 confirms then calls the existing remove API. Opening a document shows a calm reading column (large borderless title, borderless body). Grid cards now show a bookmark icon (disabled, 未接通). Title/source typography matches the denser recorded cards. | Covers show the kind, not thumbnails; 发送到聊天 is disabled (未接通). Bookmark is not wired (no favorites API). Documents open in place, not in a new tab. |
| Memory | 05a-memory-overview, 05b-memory-item-hover, 05c-memory-detail | memory | Full-height white directory column; a visible 总览 title; number-column stats (节点 / 连接 / 未连接 / 话题, where 未连接 is nodes with no edge); pill topic search; white dotted graph card; white 话题亮点 card with underline tabs; compact filters and view list. The page editor is a wiki-like column: large borderless title, dashed tag field, borderless body, actions on a top rule. | 全部 and 更新 both carry counts (更新 = pages edited in the last 7 days, since there is no read state); the long comparison note is collapsed into 对照说明. No rich-text toolbar (plain body field). |
| Onboarding | 12a/12a2-onboarding-step1-*, 12b-onboarding-step2-connect-apps, 12c-onboarding-step3-tasks, 12d-onboarding-step4-avatar | onboarding | Four-step wizard with a 4-bar progress strip and 第 N 步，共 4 步: industry cards (toned glyph tiles, ✓ on select) and role cards; app rows with tile, name · 未连接 and a disabled + 连接; 一次性任务 / 例行任务 pick cards; avatar step with live preview and 进入 OpenTeamily. | Connect buttons are disabled (no third-party OAuth); avatar is an original SVG, not Teamily art. |
| Profile | 08a-profile-loading, 08b-profile-own-posts-tab, 08c-profile-followers-dialog-loading | profile | `/profile` is now the social home: large monogram, visible username, 关注/粉丝/赞与收藏 counts, icon actions, 帖子/收藏/点赞 underline tabs, empty-state copy, and a right-hand 智能体 list (up to five workspace agents, 显示全部 → /agents). 关注/粉丝 open a centered dialog with tabs, a pill search, and an honest empty state. | Counts stay 0: there is no follow/like API. Gift, notification and share actions are disabled and labelled 未接通. Posts, collections and likes have no feed yet. Avatars are monograms, not photos. |
| Profile – edit | 09a-profile-edit-top, 09b-profile-edit-bottom | profile (edit) | `/profile/edit` (pencil on the home, or 账户与资料) is a centered single column: “‹ 编辑资料”, monogram, disabled 更换头像, character counters, full-width fields, 取消/保存 (save stays off until the form is dirty), a private-email row (未设置 when the session has no email) and a disabled 删除账户. Existing `/v1/profile` save and 重新加载 behaviour is unchanged. | No avatar upload. Email is not returned by the session API, so the private row says 未设置 and points at /settings. Account deletion is 未接通. |
| Feature guide | 09j-guide-feature-index | guide | Tighter feature index: outline mark, pill search, compact list/grid toggle, text category rail with count pills, hover-green rows. The catalogue is still OpenTeamily’s own entries (not Teamily’s 295-item copy). | Count line remains “当前显示 N 条” (CI). Graph/map toggle stays disabled (未核实). |
| About | 09k-about | about | New `/about` article: back/home icons, large title, original cover block, OpenTeamily copy only. | No marketing video or vendor photography. Not yet linked from the settings hub (no support/legal group there). |
| Automations, members, team | 2026-11-17 recapture | (shared) | Shared tokens, canvas, inputs, buttons, rows. | Not individually re-laid-out in this pass. |

## Impeccable

`impeccable detect` (v4.9.2) was run on the changed sources and on rendered
snapshots of the main pages (computed DOM with the page CSS inlined) in the
first pass (#240) and again on this follow-up’s changed pages. Fixed earlier:
side-tab accent borders, a 4.48:1 hover contrast (accent `#097845`), cramped
fieldset padding, sub-12px chat text. Remaining advisories from that pass still
apply where the layout follows the reference (nested white canvas, 11px settings
group labels, one settings hover report, a clipped space-directory child).
This follow-up ran `impeccable detect --changed` (v4.9.2) on the branch’s UI
files. About-cover contrast (1:1 on a mixed light-to-dark gradient) was
fixed with white text on a consistently dark green cover, and the about
article uses explicit light colors so it does not inherit dark-scheme
shell tokens. Group-agent fieldset inset was added. Remaining advisories:
nested-card reports on the white ring canvases that follow the Teamily
reference; a cramped memory-center inset; the settings-hub hover contrast
in dark tokens (white on `#a4e3c5`, same advisory as #240); and one
about-link hover under shell dark accent tokens during the file scan.
Those were left in place rather than flattening the reference layout or
changing global dark tokens.
