# Screenshots — PR #228, narrow-screen chat search panel

- after `4d93f03b` (this PR's tip after live main was merged into the branch)
- before `0abd7e3b66887afd421d32342222afaa09687c67` (the base it merges into)

32 PNGs: each phase has the zh-CN set (light/dark x 1440x900 / 390x844, states
`s227-closed` / `s227-panel` / `s227-results` / `s227-wide`) and an en set
(light x 1440x900 / 390x844, states `s227-closed` / `s227-panel`).

The en set was taken after switching the interface language to `en` through
`POST /v1/settings`; the rendered strings are identical to zh-CN on this tip
(no i18n layer for `/chat`, `documentElement.lang` stays `zh-CN`), so it
documents the language axis rather than different text — the en and zh-CN files
of the same state are byte-identical.

The defect is the 390x844 pair. On `before`, tapping 搜索 with a conversation
open leaves the screen unchanged: the panel is inside the `display:none` session
pane, and the two pictures differ only in a 60×40 caret region. On `after`, the
same click paints the search panel over the session list.

Measured `documentElement.scrollWidth` at 390×844, same fixture, same click path:

| state | before | after |
|---|---|---|
| conversation open, search closed | 459 | 390 |
| after tapping 搜索 | 459 | 390 |

On `fb629bcf` (before live main was merged in) the after column was 459 / 390:
the closed state still inherited the old composer overflow, and opening the panel
removed it. Live main has since replaced the composer, so on `4d93f03b` both
states measure 390 and the only remaining difference from the base is what the
panel paints.

The 459 is real horizontal overflow, not a viewport parameter: with a
conversation open the composer overflows the 390 viewport — `textarea#chat-body`
has its right edge at 402 and the send `button` at 459. It is there on the base
too, so it is not introduced here; this PR only removes it from the search-open
state by painting the panel over the list instead of inside the hidden pane.

The six 390×844 images that used to be 459 px wide were `fullPage: true`
captures, which Chromium sizes to the real `scrollWidth`; they are re-shot as
viewport captures (390×844) so every narrow image has the same frame. The
overflow number above is the measurement, not a cropped image.

Captured with plain Playwright/Chromium (headless) against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture, 2026-11-19.
