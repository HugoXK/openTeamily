# Conversation-search hit evidence (synthetic fixtures)

Playwright captures of a throwaway loopback app seeded with synthetic CI
fixtures (`scripts/ci_ui_screenshots.py`); not browser E2E acceptance and not a
Teamily comparison. Evidence for issue #264.

- before: `e47477c` (live main)
- after: `9aa389d` (PR head)
- states: `search-hits` (panel open with one hit) and `search-jump` (same panel
  after clicking that hit)
- combos: 1440x900 and 390x844 × zh-CN/en × light/dark

Measured in the page at every combo:

- hit rows are `role="button"` only on the after side; on the before side the
  first hit is a plain `li`, and clicking it leaves the panel open.
- after side, `search-jump`: panel hidden, target message carries `search-jump`.
- `document.documentElement.scrollWidth` is 390 at 390x844 on every after
  capture (no horizontal overflow).
- `/chat` ships Chinese copy only: `html lang` stays `zh-CN` on both sides even
  with `language=en` saved, so the en captures differ only by the stored setting,
  not by copy. Not claimed as a localized page.
