# /automations row toggle evidence (issue #305)

Playwright capture of a throwaway loopback OpenTeamily app with synthetic
fixtures. Review material, not browser E2E acceptance and not a Teamily
comparison.

- before: `0a13456` (the live main this slice was cut from)
- after: `ff94962bad9602fd26f563db083091e6753361f3` (the issue #305 branch)

## What each state shows

- `list-enabled`: one automation row with the stored state `已启用`. On the
  `after` tip the row also carries a `停用` switch (`role="switch"`,
  `aria-checked="true"`); at `0a13456` the row has only the read-only
  `status-pill` and no switch at all.
- `toggled-off`: after clicking that switch once. The pill reads `未启用` and the
  switch reads `启用` with `aria-checked="false"`, from the server answer of
  `POST /v1/workspaces/{id}/automations/{id}` with
  `{revision, changes: {enabled: false}}` — no editor was opened.
- `toggled-off-reloaded`: the same page reloaded. The row still reads `未启用`,
  so the change is stored server-side rather than kept in page memory.

`before-*` is the same list at `0a13456`, where the toggle does not exist, so it
contributes one state per matrix cell (8 images); `after-*` contributes three
(24 images).

## Matrix

1440×900 and 390×844, zh-CN and en account language, light and dark appearance,
device scale 1. Every capture reports `overflow=0` (no horizontal overflow) and
no page errors; `before-automations-states.json` / `after-automations-states.json`
hold the DOM reading each image was taken at (resolved theme, page background,
row count, pill text, switch presence/text/`aria-checked`/`role`, visible alert
text).

The `/automations` copy exists only in Chinese, so the `en` account-language
captures render the same strings as `zh-CN`: the language is stored in the
account, the page has no translations. The images are not a translation claim.

## How

Fake provider and synthetic data through `scripts/ci_ui_screenshots.py`,
Playwright Chromium headless against `127.0.0.1` only. No vendor, model API or
production system was contacted. The fixture automation is enabled through the
existing update route before each cell so the first state always starts from
`已启用`.
