# Screenshots — PR #223, artifact delete confirmation

- after `87bf9c19871a38ac7873eda03da68ba272d57173` (this PR's tip)
- before `e4ee9d77d7d7ea2dc994ca4b31acc7d2db726b43` (the base it merges into)

72 PNGs. zh-CN: before 12 + after 24 (light/dark × 1440×900 / 390×844).
en: before 12 + after 24, same states, so the language axis is covered too;
the rendered strings are identical to zh-CN on this tip because the new
dialog text is a Chinese literal in `openteamily/static/artifacts/app.mjs`
(`artifactDeletePrompt`), and the `/settings/language` switch to `en` was
made through `POST /v1/settings` before each run.

States (after, per theme and viewport): `01-library`, `02-editor`,
`03-confirm-open` (question `删除「[CI FIXTURE] Website」？删除后不能恢复。`,
focus on 取消), `04-cancelled` (question gone, focus back on `#remove-artifact`),
`05-back-to-list` (no question left over the library), `06-second-artifact`
(second artifact open, still no inherited question).
States (before): `01-library`, `02-editor`, `03-deleted-on-one-click` — the
artifact is gone from the list after a single click, with no question.

`dom-*.json` next to each locale records, for every shot, the visible
`[role="alertdialog"]` text, the focused element, `#editor-form.hidden`, the
rendered library rows and `document.documentElement.scrollWidth`. They are the
machine-checkable copy of what the pictures show.

Captured with plain Playwright/Chromium (headless) on a loopback
`scripts/ci_ui_screenshots.py --serve` fixture, 2026-11-19.
