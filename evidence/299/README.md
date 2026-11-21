# 299 — /memory 分享行（before/after）

after  = 77f0da7e4c9ca562906643c4f5cba52e16325a0f (PR #299 head)
before = 5ca604340fc58ba4031b979bafe2ff20be9215be (PR base / live main)

## 每臂来源（逐字）
两臂各自的页面、模块图、CSS 与 `/v1` 处理代码，全部来自该 commit 自己的 tree：

- 页面：`openteamily/static/memory/{index.html,app.mjs,app.css}` + `static/shell/{app.mjs,app.css}`，
  由 `notes/tmp/ot_shim.mjs` 从该臂的 tree 原样读出并原样回给浏览器（不注入 meta、不改任何字节）。
- `/v1`：shim 按平台自己的 MOVED_APIS 表把 `/v1/workspaces/<w>/memory*`、`/v1/settings`、
  `/v1/workspaces` 映射到对应 feature，然后走插件自己的 **legacy /v1 dispatch**
  （`runtime/openteamily-web/src/dispatch.js` `createLegacyDispatch`，即 DS-Bot 宿主在生产上挂的同一条路由）。
  跑的是该臂 tree 的 `features/memory/*` 与 `features/settings/*`，数据落在该臂自己的 SQLite 卷里。
- 身份：DSH 宿主的浏览器会话/Host 围栏由 shim 用一个 fixture 会话替代（`/v1/auth/session`、`/v1/auth/login`），
  这是唯一被替掉的鉴权层。
- Bot Social：本机没有跑 `services/bot-social`，shim 用进程内 stand-in 回答它在本切片里被用到的三个路径
  （`GET /v1/ot/workspaces` 工作区列表、`PUT /v1/ot/public-shares` 发布快照、`DELETE /v1/ot/public-shares/<hash>` 撤下快照）。
  分享的创建/回读/撤销状态机、token 生成与哈希、`memory_shares` 表都跑在该臂自己的插件代码里。

## 状态与矩阵
- after 四态：`share-unshared`（未分享：`#share-row` hidden、只有「分享」按钮）、`share-minted`（点分享后一次性
  显示 43 字符 token 的链接 + 复制链接）、`share-active`（刷新后仍是已分享，链接不再出现、只有撤销链接）、
  `share-revoked`（点撤销后「链接已撤销」，撤销键消失）。
- before 一态：`share-unshared`。5ca60434 的编辑器顶栏**没有** `#share-memory` 按钮、也没有 `#share-row`
  （读数 `button.found=false`、`row.found=false`），所以 before 只有这一张可拍。
- 每态都从一页「从未分享过」的记忆页开始：状态先用 feature 自己的端点删掉上一组造的同名页
  （`POST /v1/workspaces/<w>/memory/<id>/remove`）再新建（`POST /v1/workspaces/<w>/memory`），
  所以每张图里列表都是同样三行（季度回顾 / 旅行清单 / 季度计划），分享状态是这一组自己造出来的。
- 矩阵：1440x900 + 390x844 × zh-CN,en × light,dark。

## 语言与主题
页面没有 en 文案；en 列是同一中文界面上 `documentElement.lang` 被真实 language 设置切到 `en`，不当英文翻译证据。
主题由 shell 按真实 `/v1/settings` 的 appearance 解析（读数 `themeResolved=light|dark`），不是 CSS 覆盖。

## 逐字 DOM 读数
readings.txt / readings-after.txt / readings-before.txt，每帧一行：`#share-memory` 的 text/disabled/hidden/title、
`#share-row` 的 hidden 与 note/status 原文、`#share-link` 的 hidden/可见值与长度、`#copy-share-link`、
`#revoke-share-link` 的 hidden、`POST .../share` 与 `POST .../share/revoke` 的状态码与返回 share 字段，
以及 `docScrollWidth` 与 `innerWidth`。
