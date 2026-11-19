# Screenshots — PR #228, narrow-screen chat search panel

- after `fb629bcf492254015e7d0e71bec073559371065f` (this PR's tip)
- before `0abd7e3b66887afd421d32342222afaa09687c67` (the base it merges into)

32 PNGs: each phase has the zh-CN set (light/dark x 1440x900 / 390x844, states
`s227-closed` / `s227-panel` / `s227-results` / `s227-wide`) and an en set
(light x 1440x900 / 390x844, states `s227-closed` / `s227-panel`).

The en set was taken after switching the interface language to `en` through
`POST /v1/settings`; the rendered strings are identical to zh-CN on this tip
(no i18n layer for `/chat`), so it documents the language axis rather than
different text.

The defect is the 390x844 pair. On `before`, tapping 搜索 with a conversation
open leaves the screen unchanged: `s227-closed` and `s227-panel` are the same
picture (the panel is inside the `display:none` session pane). On `after`, the
same click paints the search panel over the session list, and the page's
scroll width drops from the overflowing 459px to 390px.

Captured with plain Playwright/Chromium (headless) against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture, 2026-11-19.
