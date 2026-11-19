# Re-run one failed automation run (issue #327 / PR #330)

Captured with the in-repo loopback fixture (`scripts/ci_ui_screenshots.py --serve`): a
throwaway app on 127.0.0.1, the repo's fake OpenAI-compatible provider and the repo's
fake runtime daemon, plus one seeded `failed`/`timeout` run row so the failed state
exists at all. The reply text is that fixture's canned sentence — **not** a vendor
response. No real model was contacted.

- `before` tree = `2ee0c0eb28b5bd7506fd73163d26a75918ffb230` (live main, PR base)
- `after` tree = `423b19d4cd9466b8a8f90274276c4b20273c6c6e` (PR tip)
- chromium 1255 via playwright; 1440×900 and 390×844; light theme; full-page shots.

## What each image shows

| File | What it is |
|---|---|
| `failed-run-before-1440x900.png` | base tree: the run list with a 「已超时 / timeout」 row and no action on it — the only way to try again was the next tick. |
| `failed-run-before-390x844.png` | the same base list at 390×844. |
| `failed-run-after-1440x900.png` | PR tip: the same failed row now carries 「重新运行」. |
| `after-retry-after-1440x900.png` | one click later: a new 「运行中」 row is listed above it, and the failed row still says 「已超时」 with its original result text. |
| `after-retry-reloaded-after-1440x900.png` | the automation reopened from the list: the new run is still there (stored, not page state) and the source run is unchanged. |
| `failed-run-after-390x844.png` | 390×844, failed row with the retry control. |
| `after-retry-after-390x844.png` | 390×844 after a retry: new run plus unchanged source row, no horizontal overflow. |

## DOM / request readings

`before-retry-states.json` / `after-retry-states.json` hold, per cell: the rendered
`#run-list` row text, horizontal overflow, page errors, the number of 「重新运行」
buttons found, and every POST the page sent to a `/runs/<id>/retry` URL with its
`Idempotency-Key`.

Verbatim:

- before: `retry button count: 0`; rows `["已完成succeeded…保存到作品库", "已超时timeouttimeout上一次运行超时，没有产生正文。"]`
- after: `retry button count: 1`; after one click rows are
  `["…已完成…", "运行中queued取消这次运行", "已超时timeouttimeout重新运行上一次运行超时，没有产生正文。"]`
  — the new run is separate and the source row keeps `已超时` and its result text.
- after: `retryPosts` shows one POST per deliberate click, each with its own
  `Idempotency-Key`; a double click on one row reuses one key (pinned by
  `tests/automations_page.test.mjs`).

Every cell reports `overflow: 0` and no page error.
