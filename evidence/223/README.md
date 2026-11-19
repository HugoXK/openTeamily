# Screenshots — PR #223, artifact delete confirmation

- after `3808886` (this PR's tip: main `49659586` merged into the branch)
- before `c50d7cca62a2e95c02ddc2ab273f37109905e71d`

36 PNGs, zh-CN, light/dark × 1440×900 / 390×844.

After: `01-library`, `02-editor`, `03-confirm-open` (`删除「[CI FIXTURE] Website」？删除后不能恢复。`,
focus on 取消), `04-cancelled` (question gone, focus back on 删除),
`05-back-to-list` (library again, no question left over), `06-second-artifact`
(a second artifact open, no question followed it).

Before: `01-library`, `02-editor`, `03-deleted-on-one-click` — one click removes
the artifact, no question at all.

The box on the after tip measures 380,782,736,36 at 1440×900 and 92,787,310,57
at 390×844 (取消 / 确认 are 57×36 each; `documentElement.scrollWidth` stays 1440
and 390, no horizontal overflow).

Captured with headless Chromium against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture on 2026-11-19, both fixtures
seeded with the same six library rows.
