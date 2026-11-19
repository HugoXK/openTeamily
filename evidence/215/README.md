# Screenshots — PR #215, meetings page

- after `fdf0591` (PR tip after merging live main `49659586` into the branch)
- also valid for `47a497ef` and `3f7ad67`: `git diff fdf0591 47a497ef -- openteamily/static/meetings` is empty, so these pixels are what both tips render
- no before set: `/meetings` does not exist on the base; the page itself is the new surface.

16 PNGs, zh-CN, light and dark, 1440×900 and 390×844, four states:

1. `01-new-meeting` — 新建会议 form open, title / start time / attendees filled.
2. `02-minutes` — the saved meeting reopened with its 纪要 (summary + transcript).
3. `03-action-items` — an added action item row with text and owner.
4. `04-empty-state` — the empty fixture workspace, `还没有会议记录。点击「新建会议」开始。`

Captured with headless Chromium against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture on 2026-11-19; each run starts by
removing the meetings left by the previous one, so the four states are the same
every time.
