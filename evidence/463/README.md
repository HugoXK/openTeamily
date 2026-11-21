# 463 — /chat 发送模式 Auto/Instant/Agentic (before/after)

after  = d4232420eb55eacfd61b6e85086c91395828720f (PR #463)
before = 5ca604340fc58ba4031b979bafe2ff20be9215be (PR base / cut-from)

## 每臂来源（逐字）
两臂都是**真 Flask**上的**真页面**（`python3.11 -m openteamily.server --insecure-local` 起该 commit 的
tree），页面 HTML/CSS/JS、DOM 渲染、`#composer-mode` 选择器、`.mode-chip` 气泡、发送表单全部走页面
自身代码；发送体由页面自己组装（`{body, mode}`）并由真实提交按钮发出。

两类响应是注入的（`--replay-chat`）：
1. 数据端点：`/v1/workspaces`、`/v1/workspaces/<id>`、`/members`、`/artifacts`、`/agents`、
   `/v1/.../social/conversations`（列表与单会话）、`/v1/onboarding`、`/v1/settings`。这些路由在
   `openteamily/app.py:568-570` 对已迁路由答 410 moved_to_dsbot。
2. 静态兜底：`openteamily/settings_page.py` 的页面白名单只放行 `/chat/app.mjs` 与 `/chat/app.css`，
   app.mjs 动态 import 的 `calls.mjs`/`files.mjs`/`translation.mjs`/`image-create.mjs` 在 Flask 上 404，
   页面因此一行 JS 都不执行（实测：`main-panel` 恒 hidden、消息列表 0 条）。harness 从**同一个 tree**
   的 `openteamily/static/` 读这些文件原样回给浏览器，不改任何字节；四个文件在两臂 md5 相同
   （c732d148 / eab3e22a / 75278b8e / 3b70408a）。

发送返回体也是注入的：`POST .../social/conversations/<cid>/messages` 把页面自己 POST 上来的
`{body, mode}` 原样回成一条消息（`user_id` = 真实登录用户），所以气泡上的 chip 是**真渲染器**从
**真请求体**画出来的。报告口径：**数据回放、DOM 真跑**。

## 状态与矩阵
- after 臂三态：`mode-auto`（选择 Auto，发出消息，按代码设计**无 chip**）、`mode-instant`（chip「Instant」）、
  `mode-agentic`（chip「Agentic」）。
- before 臂只有 `mode-auto` 一个状态：base 的 HTML 里没有 `#composer-mode`，该状态退化为“不选择、直接发”，
  DOM 读数里 `selectFound=false`；气泡上也没有 chip（base 没有 chip 渲染）。
- 矩阵：390x844 + 768x1024 + 1440x900 × zh-CN,en × light,dark。
  帧数：before 12（1 态）、after 36（3 态）。

## 语言
`en` 列不是英文界面：页面文案全中文，只是 `documentElement.lang` 被真实 language 设置切到 `en`。
不当英文翻译证据。

## 逐字 DOM 读数
`readings.txt` 每帧一行，关键字段：`select.value`、`.mode-chip` 文字与 `data-mode`、最后一条消息的
`role`/`body`、`composer.clientWidth` vs `scrollWidth`（窄屏是否溢出）。
