# Re-run one failed automation run (issue #327 / PR #330) — re-capture

Captured with the in-repo loopback fixture (`scripts/ci_ui_screenshots.py --serve`): a
throwaway app on 127.0.0.1, the repo's fake OpenAI-compatible provider and the repo's
fake runtime daemon, plus one seeded `failed`/`timeout` run row so the failed state
exists at all. The reply text is that fixture's canned sentence — **not** a vendor
response. No real model was contacted.

- `before` tree = `2ee0c0eb28b5bd7506fd73163d26a75918ffb230` (live main, PR base)
- `after` tree = `423b19d4cd9466b8a8f90274276c4b20273c6c6e` (PR tip)
- chromium 1255 via playwright; 1440×900 and 390×844 viewports; light theme.

## Why this set replaces the first one

The first capture took `fullPage: true` screenshots while the page sat at scroll top.
The run panel is not part of the document's own flow: it lives inside the page's inner
scroller, at `y≈1734` while `document.documentElement.scrollHeight` is `900`, so the
first frame contained none of the run rows — `elementFromPoint` at the retry button's
centre returned `null`. Before and after therefore rendered the same top-of-page
pixels and hashed identically (`56966` bytes, `2feb65109c…` for both).

Every image here is taken after the row under discussion is scrolled to the middle of
the inner scroller with the document pinned to `scrollTop = 0`, and captures the
**viewport** rather than the whole document. The capture also records, per cell, the
retry button's box, whether it is inside the viewport, and whether
`elementFromPoint` at its centre is the button itself — i.e. whether it is painted,
not just present in the DOM.

| File | sha256 (first 12) | What it is |
|---|---|---|
| `failed-run-before-1440x900.png` | `78c76e92abbd` | base tree, 1440×900: the run list with a 「已超时 / timeout」 row and no action on it. |
| `failed-run-after-1440x900.png` | `d4e3f5313d77` | PR tip, 1440×900: the same failed row now carries 「重新运行」 at `x=290,y=738,w=83,h=36`, `inViewport=true`, `painted=true`. |
| `failed-row-crop-before-1440.png` | `f364deb1504c` | the failed row alone (784 css px wide): `已超时 · timeout · 上一次运行超时，没有产生正文。` |
| `failed-row-crop-after-1440.png` | `3e2086f03dec` | the same row alone: the extra 「重新运行」 control; the row grows from 104 to 119 css px because the control wraps. |
| `failed-run-before-390x844.png` | `001fd1fb36e9` | base tree, 390×844. |
| `failed-run-after-390x844.png` | `4a75acaad71f` | PR tip, 390×844: `x=97,y=682,w=83,h=36`, `inViewport=true`, `painted=true`, `overflow=0`. |
| `failed-row-crop-before-390.png` | `57c942865ce5` | the failed row alone at narrow width. |
| `failed-row-crop-after-390.png` | `ef2097c43a70` | the same narrow row with the control (row height 104 → 148 css px). |
| `after-retry-after-1440x900.png` | `ef7e31a0a551` | one click later: a new 「运行中」 row above it, the failed row still 「已超时」 with its original result text. |
| `after-retry-reloaded-after-1440x900.png` | `d6fe7a137548` | the automation reopened from the list: the new run is still there (stored, not page state). |
| `after-retry-after-390x844.png` | `b3023b47593a` | 390×844 after a retry: new run plus unchanged source row, `overflow=0`. |

`before` and `after` differ for both viewport sizes and for both row crops:

```
failed-run-before-1440x900  78c76e92abbd8a71…  failed-run-after-1440x900  d4e3f5313d77f46b…
failed-run-before-390x844   001fd1fb36e9284e…  failed-run-after-390x844   4a75acaad71fb0b8…
failed-row-crop-before-1440 f364deb1504c4885…  failed-row-crop-after-1440 3e2086f03decbae4…
failed-row-crop-before-390 57c942865ce5c89a…  failed-row-crop-after-390  ef2097c43a70bb29…
```

## DOM / request readings

`before-retry-states.json` / `after-retry-states.json` hold, per cell: the rendered
`#run-list` row text, horizontal overflow, page errors, the retry button's box with
`inViewport` / `painted`, the row crop's measured css size, and every POST the page
sent to a `/runs/<id>/retry` URL with its `Idempotency-Key`.

Verbatim:

- before: `retry button count: 0`; rows `["已完成succeeded…保存到作品库", "已超时timeouttimeout上一次运行超时，没有产生正文。"]`
- after: `retry button count: 1`; `retry: [{"text":"重新运行","box":{"x":290,"y":738,"w":83,"h":36},"inViewport":true,"painted":true}]`
- after one click rows are
  `["…已完成…", "运行中queued取消这次运行", "已超时timeouttimeout重新运行上一次运行超时，没有产生正文。"]`
  — the new run is separate and the source row keeps `已超时` and its result text.
- after: `retryPosts` shows one POST per deliberate click, each with its own
  `Idempotency-Key`; a double click on one row reuses one key (pinned by
  `tests/automations_page.test.mjs`).

Every cell reports `overflow: 0` and no page error.
