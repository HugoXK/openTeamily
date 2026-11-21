# 335 — /discover 作者链接 + `?creator=` 筛选 (before/after)

after  = 964cf5de8daf606e0011cd9323432c3901e377e0 (PR #335)
before = 5ca604340fc58ba4031b979bafe2ff20be9215be (PR base / cut-from)

## 每臂来源（逐字）
两臂都是**真 Flask**上的**真页面**（`python3.11 -m openteamily.server --insecure-local` 起该 commit 的
tree），页面 HTML/CSS/JS、卡片渲染、作者节点、chip、空态文案全部走页面自身代码。

注入的部分：
1. 数据端点 `GET /v1/discover/works` 与 `GET /v1/discover/me/works`（`dsbot_gateway.py:79` 在
   MOVED_APIS 里，Flask 侧答 410）。fixture 6 件作品（alice×3 / bob×2 / carol×1），并且**按页面自己
   拼上去的 `?creator= &q= &kind=` 过滤**，所以画面里看到的就是页面请求的那一档。
2. 静态兜底：`settings_page.py` 的页面白名单只放行 `/discover/app.mjs`、`/discover/app.css`；
   app.mjs 依赖的 `../shell/thumb.mjs`（以及 `../agents/app.mjs` 的下游）在 Flask 上 404，页面不执行。
   harness 从**同一个 tree**的 `openteamily/static/` 原样回文件，不改字节。
报告口径：**数据回放、DOM 真跑**。

## `?creator=` 是怎么进到页面里的（重要）
`GET /discover?creator=alice` 在**平台侧就被拒**：`openteamily/settings_page.py` 的 `_query_allowed`
对 `/discover` 只放行 `feed=` / `kind=` / `q=`，`creator` 不在白名单 → **400 「Queries not supported」**。
实测（`creator-link-click` 读数，两臂都测）：
- after 臂点卡片上的作者链接 `<a class="feed-author" href="/discover?creator=alice">` →
  `400 http://127.0.0.1:8772/discover?creator=alice`，落地页面文字 `Queries not supported`。
- PR 的 diff 里没有改 `_query_allowed`（6 文件：tests.yml + discover app.css/app.mjs/index.html + 两个测试）。
所以本组图用**页面自己的 popstate 路径**进该状态：`history.replaceState(null,'','/discover?creator=…')`
+ 真实 `PopStateEvent`，与用户按一次后退时页面走的是同一条 `feedStateFromSearch(location.search)`。
chip、过滤、空态仍是页面代码画的。**这是缺陷线索，已单独报 Lead，不在本组图里修。**

## 状态与矩阵
- after 三态：`creator-default`（无 creator，6 件作品，作者是 `<a>`）、`creator-filtered`（`?creator=alice`，
  chip「只看 alice 的公开作品」，3 件）、`creator-empty`（`?creator=zoe`，空态「该作者还没有公开作品。」）。
- before 只有 `creator-default`：base 的作者是 `<span>` 纯文本，没有 chip、没有 creator 解析。
- 矩阵：390x844 + 768x1024 + 1440x900 × zh-CN,en × light,dark。帧数：before 12（1 态）、after 36（3 态）。

## 语言
`en` 列不是英文界面（页面文案全中文，只有 `documentElement.lang` 被切成 `en`），不当翻译证据。

## 逐字 DOM 读数
`readings.txt` 每帧一行：作者节点的 `tag`/`href`/`title`、chip 的 `hidden`/`textContent`、空态
`#feed-note` 文字、清除链接的 `href` 与点击后的 `location.search`、`creator-link-click` 的落地页文字。
