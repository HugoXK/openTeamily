# 证据：关注者作品通知（issue #337）

全部截图由本人在本机 loopback fixture 上自拍，不是目标站截图。

- `before/`：父提交 `a04f955e8156152f946e6cbd9395978834895122`（本 PR rebase 到的最新 main，未合入本改动）。通知铃铛是 disabled 占位（`未接通：还没有通知订阅接口`），页面上没有任何作品通知面板。
- `after/`：本 PR head 分支（`a26458e`），同一 loopback fixture，真实 HTTP 会话：
  1. 关注者在发现页关注作者（真实 `discover_follows` 行）；
  2. `POST /v1/profile/follow-work` 打开该作者的作品通知；
  3. 作者再把第二件作品公开发布（`/artifacts/<id>/discover`）；
  4. 关注者 `GET /v1/workspaces/<id>/notifications` 出现一条 `kind=follow_work`。

## 文件

| 文件 | 状态 | 视口 |
| --- | --- | --- |
| `before/zh-CN__light__1440x900/01-notify-bell-disabled.png` | 改动前：铃铛 disabled | 1440x900 |
| `before/zh-CN__light__390x844/01-notify-bell-disabled.png` | 改动前：铃铛 disabled | 390x844 |
| `after/zh-CN__light__1440x900/01-follow-work-on.png` | 作品通知面板，开关已打开 | 1440x900 |
| `after/zh-CN__dark__1440x900/01-follow-work-on.png` | 同上，深色 | 1440x900 |
| `after/en__light__1440x900/01-follow-work-on.png` | 同上，英文 | 1440x900 |
| `after/en__dark__1440x900/01-follow-work-on.png` | 同上，英文 + 深色 | 1440x900 |
| `after/zh-CN__light__390x844/01-follow-work-on.png` | 同上，移动端 | 390x844 |
| `after/zh-CN__light__1440x900/02-follow-work-off.png` | 关掉开关，中文结果行 | 1440x900 |
| `after/zh-CN__light__1440x900/03-inbox-follow-work.png` | 聊天通知面板：作者名 + 作品标题，链接 `/w/<slug>` | 1440x900 |
| `after/en__dark__1440x900/03-inbox-follow-work.png` | 同上，英文 + 深色 | 1440x900 |

## 每张图拍摄时读到的 DOM

- 铃铛：`disabled=false`，`title=作品通知`（改动前为 disabled，标题是「未接通：还没有通知订阅接口」）。
- 面板：`#follow-work-dialog` 打开，行是已关注作者，`input[aria-label="<作者> 的作品通知"]`，`checked=true`；关掉后 `checked=false` 且 `#follow-work-status` 为 `已关闭作品通知。`
- 通知条目：`#notification-list` 里一条，文本形如 `<作者> 发布了新作品「秋季品牌手册」`，`href=/w/<slug>`。
- 所有截图 `document.documentElement.scrollWidth === window.innerWidth`（1440 或 390），无横向滚动。
- 每张图都是精确视口尺寸（1440x900 / 390x844），不是全页长图。

## 未覆盖

- 公开主页 `/p/<handle>` 仍是静态只读页（CSP `default-src 'none'`），本 PR 没把它改成可交互关注页；关注入口仍在发现页。
- 没有浏览器推送；通知只在通知中心里，读取时重新校验作品是否仍公开。
