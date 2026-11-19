# Screenshots — PR #223, artifact delete confirmation

- after `d10c4407579f2402085fa81e4452f07f9601c953` (merge of main `4b4ab9ca` into this branch)
- before `4b4ab9ca` (the base it merges into)

54 PNGs. zh-CN: before 12 + after 24 (light/dark x 1440x900 / 390x844).
en: before 6 + after 12 (light x 1440x900 / 390x844). The rendered strings are
identical to zh-CN on this tip because the question text is a Chinese literal
in `openteamily/static/artifacts/app.mjs`; the interface language was switched
to `en` through `POST /v1/settings` before those runs.

States (after): `01-library`, `02-editor`, `03-confirm-open` (question
`删除「[CI FIXTURE] Website」？删除后不能恢复。`, focus on 取消),
`04-cancelled` (question gone, focus back on the 删除 button),
`05-back-to-list` (library again, no question left over),
`06-second-artifact` (a second artifact is open and no question followed it).
States (before): `01-library`, `02-editor`, `03-deleted-on-one-click` — one
click removes the artifact, no question at all.

Captured with headless Chromium against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture on 2026-11-19, both fixtures
seeded with the same six library rows.
