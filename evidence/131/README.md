# 131 — /settings/agent-access 的 Gateway 审计区（before/after）

after  = 0b93583f23d4ebfbc849abf617ea8b236b56b299 (PR #131 head)
before = 2ee0c0eb28b5bd7506fd73163d26a75918ffb230 (PR base)

## 每臂来源（逐字）
两臂都是该 commit 自己的 tree 起的**真 Flask 服务**，没有回放、没有注入：

- 起法：`PYTHONPATH=$PWD python3.11 -m openteamily.server --data-dir <该臂自己的目录>
  --origin http://127.0.0.1:<port> --port <port> --insecure-local --no-automation-worker --open-registration`
- 页面：`/settings/agent-access`，由该臂 tree 的 `openteamily/settings_page.py` 直服
  （两臂都已有这个路由；差异只在 Gateway 区）。
- `/v1`：全部由该臂 tree 的 `openteamily/app.py` 处理，`GET /v1/workspaces/<id>/gateway/overview?limit=50`
  是 after 臂 `app.py:974 gateway_overview` 新增的只读审计路由。before 臂没有该路由，也没有
  `#gateway-workspace` / `#gateway-key-list` / `#gateway-invocation-list` / `#gateway-keys-empty`
  / `#gateway-invocations-empty` 任何一个节点（读数 `select.found=false`、`keysEmpty.found=false`）。
- 两个臂的 SQLite 各自独立（`after/state`、`before/state`），互不共享。

## 造数（after 臂，全走 app 自己的端点）
1. `POST /v1/auth/register` 建用户 `qa131`。
2. `POST /v1/runtime-keys` 建 runtime key，并用 `notes/tmp/fake_runtime.py` 以 Bearer 走
   `POST /v1/agent/connect`（hostname `qa131-runtime`，201 online）→ `GET /v1/agent/tasks` →
   `POST /v1/agent/tasks/<id>/claim` → `POST /v1/agent/tasks/<id>/result`
   `{"status":"succeeded","result":{"text":"外部调用已处理：证据工作区 · 外部助手"}}`（两次都 200）。
   这是平台自己的 runtime 任务队列，没有改库。
3. `POST /v1/workspaces` 建「证据工作区」与「空工作区」（各带 16–64 字符 Idempotency-Key）。
4. `POST /v1/workspaces/<w>/agents` 建 agent「外部助手」；
   `POST /v1/workspaces/<w>/agents/<a>/api-keys` 建 key「站点」（rate_per_minute=10，scope invoke，token 43 字符）。
5. 两次 `POST /v1/gateway/agents/<a>/invocations`（Bearer，无 cookie、无 Origin，Idempotency-Key
   `qa131-invoke-0001/0002`）→ 202 queued；随后 `GET /v1/gateway/invocations/<id>`（同一 Bearer）
   读到 runtime 任务完成后的 succeeded，该端点把状态与正文同步回 `agent_api_invocations`。
6. `GET /v1/workspaces/<w>/gateway/overview?limit=50` → 1 key、2 invocations，两条都是 succeeded
   且 reply 非空（invocations.txt 逐字）。

## 状态与矩阵
- after 两态：
  - `gateway-default`：工作区选「证据工作区」——1 行 key（外部助手 · 站点，scope invoke · 10 次/分 ·
    创建 … · 最近使用 …，带「撤销」按钮），2 行调用（外部助手 · succeeded，meta 为时间 + 回复前 160 字），
    两个空态提示都 hidden。
  - `gateway-empty`：工作区选「空工作区」——keyCount=0、invocationCount=0，
    `#gateway-keys-empty`「你的 agent 还没有向本实例之外开放。」与 `#gateway-invocations-empty`
    「还没有外部调用。」都显示。
- before 一态：`gateway-default`（同一路由、同一账号；页面上没有 Gateway 区，读数全为 `found=false`）。
- 矩阵：1440x900 + 390x844 × zh-CN,en × light,dark；768 未拍（已不是门槛）。

## 语言与主题
页面没有 en 文案；en 列是 `documentElement.lang` 被真实 language 设置切到 `en` 的同一中文界面，
不当英文翻译证据。主题由该臂自己的 `/v1/settings` appearance 解析（读数 `themeResolved=light|dark`）。

## 逐字 DOM 读数
readings-after.txt / readings-before.txt / readings.txt，每帧一行：
`#gateway-workspace` 的 options 与 selected、`#gateway-key-list li` 的 .name/.meta/.actions button、
`#gateway-invocation-list li` 的 .name/.meta、两个空态节点的 found/hidden/文字、`#status`、`[role=alert]`、
`innerWidth` 与 `docScrollWidth`（每帧相等，无横向溢出）、`themeResolved`、`lang`。
invocations.txt 是两次 POST 的状态码、invocation id 与同步后的 status/reply 原文。

## 口径
本目录只声称「帧清单 + 逐字 DOM 读数 + 推上 fork 的链 200」；拍摄与复核都没有做视觉判断。
