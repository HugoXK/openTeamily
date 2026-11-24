# #23 — machine-checkable evidence (base `60857c06` → tip `10ea6bc7`)

Purpose: replace "look at the PNG" with data that anyone can recompute, because the reviewer
model has no image input. Every value below was read out of the live page or the authenticated
API on the commit named — **none of it was derived from viewing a screenshot**.

Files:
- `machine-check-base-60857c06.json`
- `machine-check-tip-10ea6bc7.json`
- `shots/{before,after}/evidence.json` (the raw capture log the two files above are built from)

## Fixture (identical for both commits, re-seeded per commit)

- 10 works, 2 authors: `ci_owner` (A, published **second**) and `ci_peer` (B, published **first**),
  5 each, same week, 0 likes, 0 collections → all ten at score 0.
- Viewer is a **third** account `ci_viewer` (author of nothing). Before loading the feed it performs
  `GET /v1/ot/discover/qa-a-5/detail`, i.e. it has opened **A work 5**.
- Then it loads `/discover?sort=popular`.

## Claim → field

| Claim | Where |
|---|---|
| viewed work sinks | `shots[].dom_order` — `qa-a-5` is last (index 9) in every tip viewport, first (index 0) in every base viewport |
| per-author cap 3 | `api_explain.readings`: `capped` true for `a-1`, `b-2`, `b-1`, `a-5`; first six have `author_rank` ≤ 3 |
| explain is not rendered | `api_explain.public_feed_has_explain_field == false` (static page never sends `explain`) |
| nothing overflows | `shots[].measured.scrollWidth == innerWidth` in all 8 states |
| layout is 4-up / 1-up | `shots[].measured.gridColumns` = `292px ×4` at 1440, `351px` at 390 |
| theme actually applied | `shots[].theme_resolved` = light/dark per shot, not the requested scheme |
| guest gets nothing | `guest_probe`: `feedStatus 401`, `pageUrl …/login`, `cards 0` |

## DOM order (identical across all four viewports of a commit)

- base `60857c06`: `a-5 a-4 a-3 a-2 a-1 b-5 b-4 b-3 b-2 b-1`
- tip  `10ea6bc7`: `a-4 a-3 a-2 b-5 b-4 b-3 a-1 b-2 b-1 a-5`

## Explain readings (tip; `GET /v1/ot/discover?kind=work&sort=popular&limit=12&explain=1`, viewer cookie)

`a-4 r1 s0 · a-3 r2 s0 · a-2 r3 s0 · b-5 r4 s0 · b-4 r5 s0 · b-3 r6 s0 · a-1 r7 s0(capped) ·
b-2 r8 s0(capped) · b-1 r9 s0(capped) · a-5 r10 s-1 seen=1(capped)`

## Gaps found on 2026-11-24 23:36 — both closed at 23:44

1. **Per-card bounding boxes existed for one state per commit**, not all four: the capture script
   overwrote the box array on each shot and kept the last (`viewer-390-dark`).
   **Closed by** `boxes-base-60857c06.json` / `boxes-tip-10ea6bc7.json` (1440-light + 390-light,
   boxes accumulated per viewport; `shoot.mjs` fixed to accumulate too).
   Result: the grid boxes are **identical** on both commits (1440: card 0 at
   left 140 / right 432 / top 130 / bottom 429, `292×299`; 390: left 20 / right 371 / top 223 /
   bottom 499, `351×276`) — the ranking change moves which work sits in a cell, not the grid.
2. **The `explain=1` body was reduced at capture time**; `api_explain.readings` is a reduction,
   not the raw envelope. **Closed by** `api-explain-raw-base-60857c06.json` /
   `api-explain-raw-tip-10ea6bc7.json`: verbatim response text parsed as JSON with no field
   dropped, plus the response byte count and a sha256 of the exact bytes.

The two `machine-check-*.json` files above predate the gap-fill run; their
`api_explain.raw_body_persisted: false` describes **that artifact**, not the evidence set.

## Two things the re-run added

- **The base ignores the flag entirely.** On `60857c06`, all ten items come back with no
  `explain` key at all (item keys end at `site_available`); on `10ea6bc7` all ten carry it.
  So the field is introduced by this PR, not merely populated differently.
- **`/v1/ot/discover?sort=popular&explain=1` alone is a 400**, body
  `{"error":{"code":"invalid_request","message":"popularity sorting applies to the all works feed"}}`.
  `sort=popular` needs the works feed (`kind=work`); the raw file records both the working line
  and this 400, so nobody quotes a URL that cannot return 200.

