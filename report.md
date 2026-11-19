# Agents archived view + restore — before/after evidence

Arm `before` = `2ee0c0eb` (live main at cut), arm `after` = branch tip. 24 shots: 3 states × 1440×900/390×844 × light/dark, zh-CN.

| state | what differs |
|---|---|
| agents-default | before: 1 card, no `#show-archived` control. after: 1 card + owner-only 显示已归档 switch. |
| agents-archived | before: still 1 card, archived agent unreachable. after: 2 cards, 1 「已归档」tag, 1 恢复 button. |
| agents-restored | before: nothing to restore. after: 2 cards, 0 archived tags (restored agent back in the default list). |

All 24 shots: viewport PNG size exact, `themeResolved` equals the requested theme, `documentElement.scrollWidth` ≤ viewport width.
