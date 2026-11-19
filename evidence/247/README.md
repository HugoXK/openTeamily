# Screenshots — PR #247, skill-secret delete confirmation

- after `679b8610d7ee6fcc5547fb395ebb3e7202743d68` (this PR's tip)
- before `c50d7cca62a2e95c02ddc2ab273f37109905e71d` (the base it merges into)

36 PNGs. zh-CN: before 8 + after 16 (light/dark × 1440×900 / 390×844).
en: before 4 + after 8 (light 1440×900 / 390×844); the rendered strings are
identical to zh-CN on this tip because the question text is a Chinese literal
in `openteamily/static/settings/app.mjs`, and the switch was made through
`POST /v1/settings` before each run.

States (after): `01-secret-row` (row `CI_FIXTURE_KEY` with its 删除 button),
`02-confirm-open` (in-place `role="alertdialog"`: `删除技能密钥「CI_FIXTURE_KEY」？`
with 取消 / 确认删除, focus on 取消, delete button hidden),
`03-cancelled` (question gone, row and button back, focus returned),
`04-deleted` (after 确认删除: list empty).
States (before): `01-secret-row`, `02-deleted-on-one-click` — the row is gone
after a single click, with no question.

`dom-*.json` records, per shot, the question text, the focused element and the
rendered secret rows.
