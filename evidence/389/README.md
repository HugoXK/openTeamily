# 389 — 设置页「Agent 渠道」改成可点的「如何接入」+ 帮助中心「Agent 渠道」整节（before/after）

after  = `d4b69efaad364af94afcce507480613ab84485ac`（PR #389 head，`pulls/389.head.sha`）
before = `af33df0f0ff16007c02fa6818f1f58e3918927f4`（PR #389 base）

> 第一轮 before 臂误用了 `9eae5d54`（那是 #352/#310 的 base，另一条 main 状态），整组已丢弃重拍；
> 本目录的 before 帧全部来自 `af33df0f`。

## 每臂来源（逐字）
两臂都由 `notes/tmp/ot_shim.mjs` 服务该 sha 自己的 tree：页面 `openteamily/static/settings/{index.html,app.mjs,app.css}`、
`openteamily/static/help/index.html` 及其模块图、CSS 原样来自该臂；`/v1` 按该臂 `static/shell/dsbot-api.mjs`
的 MOVED 表映射到该臂 `runtime/openteamily-web` 插件的 legacy dispatch（`/v1/settings`、`/v1/workspaces`… 都跑该臂代码）。
只有 DSH 宿主会话是 fixture（`/v1/auth/session`、`/v1/auth/login`）。未注入任何响应、未回放录屏。

两遍拍摄（每遍一个 route）：
1. `/settings/channels` → 设置页「Agent 渠道」面板（`[data-settings-page="channels"]`）
2. `/help` → 帮助中心；after 状态在页内把 `location.hash` 设为 `#channel-slack` 并 `scrollIntoView`，
   与设置页链接 `href="/help#channel-slack"` 的落点一致

## 状态与矩阵
| 臂 | 状态名 | 含义 |
|---|---|---|
| after | `settings-channels-links` | 4 行各一条 `a.channel-link`「如何接入」，无「+ 连接」按钮 |
| after | `help-channels` | `#channels`「Agent 渠道」整节 + 4 个 `id=channel-<slug>` 锚点，跳到 `#channel-slack` |
| before | `settings-channels-plain` | 4 行各一个 `disabled` 的「+ 连接」，0 条 `channel-link` |
| before | `help-plain` | 帮助页没有 `#channels` 节，锚点 0 |

矩阵：1440×900 + 390×844 × zh-CN/en × light/dark = 每态 8 帧。after 16（2 态 × 8）、before 16（2 态 × 8），768 不拍。
en 列只是 `documentElement.lang=en`（该页没有语言开关），dark 走 `prefers-color-scheme` 解析后的 `data-theme-resolved`，帧里已记读数。

## DOM 读数（原文取自 `readings-*.txt`）
设置页 after（1440 light）：`links=4 connectButtons=0 disabledButtons=0 panelHidden=false`
```
channel "wechat"   link="如何接入" href=/help#channel-wechat   box={"x":914,"y":145,"w":56,"h":21} style={"color":"rgb(9, 120, 69)","textDecorationLine":"none","fontWeight":"600","cursor":"pointer"}
channel "imessage" link="如何接入" href=/help#channel-imessage box={"x":914,"y":205,"w":56,"h":21} style={"color":"rgb(9, 120, 69)","textDecorationLine":"none","fontWeight":"600","cursor":"pointer"}
channel "slack"    link="如何接入" href=/help#channel-slack    box={"x":914,"y":264,"w":56,"h":21} style={"color":"rgb(9, 120, 69)","textDecorationLine":"none","fontWeight":"600","cursor":"pointer"}
channel "whatsapp" link="如何接入" href=/help#channel-whatsapp box={"x":914,"y":323,"w":56,"h":21} style={"color":"rgb(9, 120, 69)","textDecorationLine":"none","fontWeight":"600","cursor":"pointer"}
```
同页 dark（1440）：`color=rgb(137, 213, 181)`（`--ot-accent` 的暗色值），其余同上。
390 light：`box={"x":300,...,"w":56,"h":21}`（四行 y=148/211/270/329），dark 390 为 `w=60,h=24`。

设置页 before（1440）：`links=0 connectButtons=4 disabledButtons=4`
```
channel "wechat" link=null button={"text":"+ 连接","disabled":true}   （imessage/slack/whatsapp 同）
```

帮助页 after（1440 light）：`heading="Agent 渠道"`，4 个锚点 `channel-wechat/channel-imessage/channel-slack/channel-whatsapp`，
`hash=#channel-slack`；`target={"id":"channel-slack","box":{"x":228,"y":648,"w":832,"h":18,"inView":true}}`，
四锚点 y=507/578/648/719 全 `inView=true`；390：`target box={"x":72,"y":474,"w":302,"h":18,"inView":true}`。
帮助页 before：`sectionFound=false anchors=0`（1440 与 390 一致）。

## 两臂像素差（`pixels.txt`，逐帧全量比对）
- 设置页：`en__light__1440` 9399 px / 0.7252%（bbox `516,138,975,435`，只在右列渠道行区域）；`zh-CN__light__1440` 同 0.7252%；
  dark 1440 97797/27795 px（2.1447–2.1448%，bbox 还含左上角 `x≥10,y≥23` 的一块，未在 DOM 读数里定位到具体元素，按像素如实记录）；
  390 为 9380–21560 px（2.85–6.55%）。
- 帮助页：13.05–29.06%（bbox 多为整页）。机制是 after 状态落到 `#channel-slack`（页内跳转/滚动），before 状态停在页首，
  加上新插入的整节改变了下文位置；不是逐像素新增内容对比。

## 代表链（raw，按 ref sha 而非分支名）
- 1440：`evidence/389/after/zh-CN__light__1440x900__settings-channels__settings-channels-links.png`
- 390：`evidence/389/after/zh-CN__light__390x844__help__help-channels.png`
- before 对照：`evidence/389/before/zh-CN__light__1440x900__settings-channels__settings-channels-plain.png`

## 未覆盖 / 边界
- 没有在真浏览器里点链接并跟随跨页跳转（`/settings/channels` → `/help#channel-slack` 的整页导航）；after 的帮助页状态
  用同一 hash + `scrollIntoView` 复现落点，读数里 `hash=#channel-slack`、目标 `inView=true`。
- 未判读视觉：本模型无图像输入，以上只声称帧清单 + DOM 读数 + 链状态码，不含「视觉无异常」的判断。
