# Invite freeze/unfreeze evidence (synthetic fixtures)

Playwright captures of a throwaway loopback app with synthetic CI fixtures
(`scripts/ci_ui_screenshots.py`); not browser E2E acceptance and not a Teamily
comparison. Evidence for issue #272.

- before: `077cf23` (live main)
- after: `e7dcd5c` (PR head)
- states: `invite-row` (members page, invite row at rest) and `invite-freeze`
  (after one click on the row's 冻结 button)
- combos: 1440x900 and 390x844 × zh-CN/en × light/dark

Measured in the page:

- before, `invite-freeze`: no `[role="alertdialog"]`; the request already ran,
  status reads 「已冻结邀请。」 and the button flips to 「恢复」.
- after, `invite-freeze`: an `alertdialog` sits in the invite row with 「取消」
  and 「确认冻结」; nothing was sent yet and the status line stays empty.
- `document.documentElement.scrollWidth` is 390 at 390x844 on every after capture.
- `/members` ships Chinese copy only; the en arm differs by the stored setting,
  not by copy. Not claimed as a localized page.
