# Chat bold tool — before/after evidence

Arm `before` = `2ee0c0eb` (live main at cut), arm `after` = branch tip. 24 shots: 3 states × 1440×900/390×844 × light/dark, zh-CN.

| state | what differs |
|---|---|
| chat-tool | before: `#chat-format` does not exist (disabled placeholder). after: button opens `#chat-format-menu` with 加粗. |
| chat-wrap | before: selecting 世界 and clicking does nothing, field stays `你好世界`. after: field becomes `你好**世界**`, caret 4–6. |
| chat-bubble | before: bubble shows literal `你好，**世界**和**团队**都在这里`, 0 `<strong>`. after: same text without asterisks, 2 `<strong>`. |

All 24 shots: viewport PNG size exact, `themeResolved` equals the requested theme, `documentElement.scrollWidth` ≤ viewport width.
