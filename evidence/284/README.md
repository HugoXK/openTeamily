# 284 — /settings 「通知」组 (before/after)

after  = 646ad978db492b82a59a282f48b3eb94c9726262 (PR #284)
before = 5ca604340fc58ba4031b979bafe2ff20be9215be (PR base / cut-from)

## 每臂来源（逐字）
两臂都是**真 Flask**上的**真页面**：`python3.11 -m openteamily.server --insecure-local` 起该 commit 的
tree，浏览器打开 `/settings`，页面 HTML/CSS/JS、渲染、开关控件、状态文案全部走页面自身代码。

唯一回放的是两个被迁走的端点（`app.py:568-570` 对它们答 410 moved_to_dsbot）：
- `GET /v1/settings`（页面启动必需，否则设置面板不展开）
- `GET/PUT /v1/notification-prefs`

回放的响应体取自 PR 自己插件代码的真实契约：`runtime/openteamily-web/features/settings/settings.js`
的 `notificationPayload()`（categories：@提及 / 任务完成 / 作品通知）与 legacy `GET /v1/settings` 的
values/revision 形状。`PUT` 回放是有状态的：改的是同一份 fixture 记录，`notif-*-off` 帧刷新后回读到的
仍是关掉的值。**报告口径：数据回放、DOM 真跑。**

## 状态与矩阵
- 状态：`notif-default`（三开关开）/ `notif-mentions-off` / `notif-artifacts-off` / `notif-save-failed`
- before 臂只有 `notif-default`：base 的 HTML 里没有「通知」组，其余三个状态无控件可操作。
- 矩阵：390x844 + 768x1024 + 1440x900 × zh-CN,en × light,dark。
  帧数：before 12（1 态）、after 48（4 态）——其中 768 列为 before 4 + after 16。

## 语言
页面没有 en 文案（`static/settings/*` 全中文）；en 列是同一个中文界面上 `documentElement.lang` 被真实
language 设置切到 `en`。不把 en 帧当英文翻译证据。

## 逐字 DOM 读数
见 readings-before.txt / readings-after.txt，每帧一行。
