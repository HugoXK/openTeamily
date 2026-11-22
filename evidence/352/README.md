# 352 — 侧栏「消息」命中点开后在会话里定位 + 高亮（before/after）

after  = 4d18ff519d16b19505482fdbcc4d8bb096311209 (PR #352 head)
before = 9eae5d547526070669f4f2d644b0dbc5f406ffcc (PR base)

## 每臂来源（逐字）
两臂都是该 sha 自己的页面、模块图、CSS 与插件代码，跑在
`notes/tmp/ot_shim.mjs`（把该 sha 的 `openteamily/static` 原样服务，`/v1` 按该 sha 的
`static/shell/dsbot-api.mjs` MOVED 表映射到该 sha 的 DS-Bot 插件 legacy dispatch）：

- 页面：`openteamily/static/chat/{index.html,app.mjs,app.css}` 及其模块图，原样来自该臂 tree。
- `/v1/workspaces/<w>/social/*` → 插件 `features/messenger` + `lib/c/legacy-v1.js`；
  `/v1/workspaces/<w>/search/messages` → 插件 `features/search`（`sharedHits` 调 Bot Social
  的 `/v1/ot/workspaces/<ws>/messages/search`）。两者都跑该臂 tree 里的代码。
- Bot Social 不在本机跑：stand-in 按 `services/bot-social/src/openteamily/messenger.ts` 的响应
  形状作答（同一个 sha 的源码）——会话 1 个 dm、12 条消息、`read_seq=12`；消息搜索按 `q` 子串匹配、
  `limit` 生效、`around=<消息id>` 返回该消息附近的窗口、`before` 作上界。
- 身份：DSH 宿主会话由 shim 的 fixture 会话替代（`/v1/auth/session`、`/v1/auth/login`）。

## 状态与矩阵
- `chat-search-hit`：侧栏搜索「第三版」→ 切「消息」标签 → 命中 1 条（`林然 看到了。第三版比之前顺多了。`）
  → 点这条命中 → 会话打开后落到 `05a1…`（消息 #5）。
  读数：`hitCount=1`、`dividerCount` 不适用、`hit.messageId=05a1b2c3d4e5f60718293a4b5c6d7e8f`、
  `tabIndex=-1`、`focused=true`、`outline=2px solid rgb(9,120,69)`（dark 为 `rgb(137,213,181)`）、
  `scrollTop=331`、命中行在视口内（`top≈353`，视口高 900，中线 450）。
- `chat-search-empty`：搜索「没有这个词」→ 消息标签下无命中 → 空态
  `当前工作区里没有匹配的结果。`，`results=0`。
- 矩阵：1440x900 + 390x844 × zh-CN,en × light,dark；768 未拍。

## 逐字 DOM 读数
readings-after.txt / readings-before.txt / readings.txt，每帧一行：hash、会话标题、消息行数、
全部 `data-message-id`、命中行的 messageId/tabIndex/focused/outline/所在 top、`jumpCount`、
滚动位置、`#status` 文本、搜索空态文本、`innerWidth`/`docScrollWidth`（每帧相等）、主题与语言。

## 两臂像素对比（重要，如实写）
`pixels.txt` 是 after 对 before 的逐帧逐像素差：
- 15/16 帧差异在 0–129 px（0.0000%–0.0279%，属渲染噪声/光标类抖动）。
- 1 帧差 120746 px（9.3168%）：`zh-CN__dark__1440x900__chat__chat-search-hit.png`。
  读数上这是落点不同：before 那帧 `scrollTop=662`、命中行 `top=22`（贴顶）；after 那帧
  `scrollTop=331`、`top=353`（居中）。即 after 在 repaint 后仍居中，before 被 repaint 冲掉。

含义（不夸大）：这个 base 的 `openSessionTarget` 里本来就有 `if (target.message) jumpToMessage(...)`
（`app.mjs:1370`），所以「点命中就跳」在 before 臂多数情况下也能看到；本 PR 加的
`pendingHitJump`/`flushPendingHitJump` 让跳转在 hashchange 重绘之后再来一次，效果在
上面那一帧可见，其余帧两臂一致。用 agent 会话命中（PR 同时改了 `openAgentConversation`）那条路径
本 harness 没有 agent 会话数据，未覆盖。

## 口径
本目录只声称「帧清单 + 逐字 DOM 读数 + 像素差 + 推上 fork 的链 200」；拍摄与复核都没有做视觉判断。
