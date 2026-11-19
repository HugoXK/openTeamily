# /memory share-link evidence (issue #288, PR #299)

Playwright capture of a throwaway loopback OpenTeamily app with synthetic
fixtures. Review material, not browser E2E acceptance and not a Teamily
comparison.

- before: `f1b5018` (the live main this slice was cut from)
- after: `c0dcb36dca95b2fef3a942a257f5242862c94622` (PR #299 branch, merge of `5a1828e` plus the 415 body fix)

## What each state shows

- `share-before`: the open memory page with the share row hidden. On the
  `after` tip the `分享` button is enabled and minting has not happened yet; at
  `f1b5018` the same button has no id, is disabled and carries
  `未接通：还没有分享记忆页的接口。`, and no share row exists.
- `share-after`: after one real `POST …/memory/{id}/share`. The row shows the
  absolute copy-once link (`http://127.0.0.1:<port>/s/<43 chars>`), `复制链接`
  and `撤销链接`, and the status line says the link opens without signing in.
- `share-revoked`: after `DELETE …/memory/{id}/share`. The link field and both
  actions are gone, the row says `链接已撤销；重新分享会生成一条新链接。`, and
  the status line says the old link now answers 404.

Each `after` cell creates its own fresh memory page through the real create API,
so `share-before` is genuinely "never shared" instead of a leftover revoked row.

## Matrix

1440×900 and 390×844, zh-CN and en account language, light and dark appearance,
device scale 1. Every capture reports `overflow=0` (no horizontal overflow) and
no page errors; `before-states.json` / `after-states.json` hold the DOM reading
each image was taken at (resolved theme, page background, button `disabled` and
`title`, share-row visibility, link length and absolute form, visible actions,
note and status text).

`before-*` is the same page at `f1b5018`, where sharing does not exist, so it
contributes one state per matrix cell (8 images); `after-*` contributes three
(24 images).

The `/memory` copy exists only in Chinese, so the `en` account-language captures
render the same strings as `zh-CN`: the language is stored in the account, the
page has no translations. The images are not a translation claim.

The token in `share-after` was minted by the throwaway fixture server on
loopback and is not a reachable link after the capture.

## How

Fake provider and synthetic data through `scripts/ci_ui_screenshots.py`,
Playwright Chromium headless against `127.0.0.1` only. No vendor, model API or
production system was contacted.
