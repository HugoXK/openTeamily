# /skills install-state evidence (issue #263, PR #283)

Playwright capture of a throwaway loopback OpenTeamily app with synthetic
fixtures. Review material, not browser E2E acceptance and not a Teamily
comparison.

- before: `7a8bdb2` (the live main this slice was cut from)
- after: `8a0e1e5577d0d578cfc8e52cea93bee4f9014720` (PR #283 tip)

## What each state shows

- `uninstalled`: the ten catalogue cards with `安装` buttons and no installed card.
- `installed`: `会议纪要` after a real `POST /v1/skills/installed`; the card is
  marked `已安装` and the button is pressed.
- `failed`: the session cookie is dropped, then install is pressed; the server
  answers `401` («Sign in first»), the card keeps its previous state and the
  reason is printed above the grid.

`before-*` is the same page at `7a8bdb2`, where every install button is disabled
and labelled `未接通`; that page has no installed or failed state to capture, so
it contributes one state per matrix cell.

## Matrix

1440×900 and 390×844, zh-CN and en account language, light and dark appearance,
device scale 1. Every capture reports `overflow=0` (no horizontal overflow) and
no page errors; `after-states.json` / `before-states.json` hold the DOM reading
each image was taken at (theme actually resolved, card count, installed cards,
button label, `aria-pressed`, visible error text).

The `/skills` copy exists only in Chinese, so the `en` account-language captures
render the same strings as `zh-CN`: the language is stored in the account, the
page has no translations. The images are not a translation claim.

## How

Fake provider and synthetic data through `scripts/ci_ui_screenshots.py`,
Playwright Chromium headless against `127.0.0.1` only. No vendor, model API or
production system was contacted.
