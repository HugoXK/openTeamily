# 316 — /agents「显示已归档」+ 已归档卡片「恢复」(before/after)

after  = 15e91271df02195089f27abe902837702992711a (PR #316)
before = f137b4a2 (PR base / cut-from)

## 每臂来源（逐字）
**两臂都是真 Flask 上的真页面**：`python3.11 -m openteamily.server --insecure-local
--no-automation-worker --open-registration` 起该 commit 的 tree，浏览器打开 `/agents`。
页面 HTML/CSS/JS（`static/agents/*`、它 import 的 `..//look/app.mjs`）、卡片渲染、`#show-archived`
开关、`.archived-tag`、`恢复` 按钮、空态与计数文案全部走该臂自己的代码；两臂都没有用静态兜底
（`--asset-root` 传了但没触发，`/agents/app.mjs`、`/agents/app.css`、`/look/app.mjs` 都在
`settings_page.py` 的 ASSETS 白名单里）。

after 臂注入的**只有四个响应**（`dsbot_gateway.py` 的 MOVED_APIS 已把这四条迁到 owner 的 DS-Bot，
Flask 侧一律 `refuse(410,'moved_to_dsbot')`）：
1. `GET /v1/workspaces?limit=100` → `{items:[{id:<真 workspace id>, name:'证据工作区', ...}]}`
2. `GET /v1/workspaces/<id>/members` → `{items:[{user_id:<真 session 用户>, username:..., role:'owner'}]}`
3. `GET /v1/workspaces/<id>/agents?limit=100[&include_archived=1]` → 1 个在册 + （勾开关后）1 个已归档，
   `{id, name, summary, revision, category, archived}` 形状照 `runtime/openteamily-web/features/agents/v1.js`
   的契约；请求的 query 由页面自己拼（`archivedDirectoryQuery()`），harness 只按 query 回不同集合。
4. `POST /v1/workspaces/<id>/agents/<aid>/archive` → 校验 body，`{revision,archived:false}` 时翻转成
   `archived:false, revision+1` 并回 200。

**没有注入的部分（真跑）**：workspace 行是真的 —— `POST /v1/personal-agent`（平台路由，未迁）在 after
臂真建了一个 workspace，`GET /v1/workspaces/<id>` 由 Flask store 真读回；`GET /v1/auth/session`、
`GET /v1/personal-agent` 也是真的。归档卡片是 fixture 行，`恢复` 造成的状态翻转发生在 replay 里
（回退口径允许的第四条）。**报告口径：数据回放、DOM 真跑。**

## 两条硬证据（逐字）
1) 打开 `#show-archived` 后页面**真的**发出了带 include_archived 的请求（after，1440x900，`agents-archived-on`）：
```
["GET /v1/workspaces/0208cff621df42038d8e6fef627ffbaf/agents?limit=100",
 "GET /v1/workspaces/0208cff621df42038d8e6fef627ffbaf/agents?limit=100&include_archived=1"]
```
（完整每帧 query 串见 readings-after.txt 的 `queries=` 字段。）

2) 点「恢复」后 `.archived-tag` 与恢复按钮消失，关掉开关后在默认目录里仍看得到它
（同一页同一帧序列，`agents-restored` 两次读数）：
```
A agents-restored (switch on, tag gone) toggle=true/true/false archivedCards=0 restoreButtons=0
  cards=[{"dataId":"a1000000000000000000000000000001","tag":null,"restoreText":null,...},
         {"dataId":"a1000000000000000000000000000002","restoreId":null,"restoreRevision":null,
          "restoreText":null,"tag":null,"chatHref":"/chat#workspace=...&agent=a1000000000000000000000000000002"}]
A agents-restored (switch off, default directory) toggle=true/false/false archivedCards=0 restoreButtons=0
  count="显示 2 个智能体"  cards 同上（归档助手仍在，作为普通卡片带 聊天 链接）
archiveCalls=["POST /v1/workspaces/.../agents/a1000000000000000000000000000002/archive body={\"revision\":3,\"archived\":false}"]
```

## 状态与矩阵
- after 三态：`agents-default`（开关关，`?limit=100`，1 张卡）、`agents-archived-on`（开关开，2 张卡，
  已归档卡带 `.archived-tag`「已归档」+「恢复」）、`agents-restored`（点恢复后 tag/按钮消失，开关关回
  默认目录仍是 2 张卡）。after 24 帧（3 态 × 2 语 × 2 主题 × 2 宽）。
- before 只有 `agents-default`：f137b4a2 没有 `#show-archived-wrap`（读数 `wrap=null toggle=false`），
  没有该控件可拍，故只有 8 帧（2 语 × 2 主题 × 2 宽）。before 是真数据：`POST /v1/personal-agent`
  建的「个人空间」工作区 + 11 个真内置智能体（读数 `count="显示 11 个智能体"`）。
- 矩阵：1440x900 + 390x844 × zh-CN,en × light,dark。

## 语言
页面没有 en 文案；en 列是同一中文界面上 `documentElement.lang` 被真实 language 设置切到 `en`
（`/v1/settings` 回放返回 language=en）。不把 en 帧当英文翻译证据。

## 逐字 DOM 读数
readings.txt / readings-before.txt / readings-after.txt，每帧一行：`#show-archived-wrap` 的
`hidden`/宽度、`#show-archived`.checked/disabled、`.archived-tag` 文字、恢复按钮的
`data-restore`/`data-revision`/`textContent`、每张卡的 `dataId`、以及 page 实际发出的 query 串与
archive POST body。
