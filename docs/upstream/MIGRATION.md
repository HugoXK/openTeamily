# Upstream source migration (first import)

Date: 2026-11-16 (Asia/Shanghai).

This change copies a **minimal needed set** of already-audited public source
from FlyBot and Bot Social into isolated trees. It is not a whole-repository
vendor dump, not feature-complete Teamily parity, not a container release, and
not a close of the parent roadmap.

The include/exclude lists and reasons are in [SELECTION.md](SELECTION.md).
Pins, hashes, and counts are in [migration-manifest.json](migration-manifest.json).

## Pins (public commits only)

| Component | Upstream | Commit | License in this tree |
| --- | --- | --- | --- |
| FlyBot needed set | https://github.com/ThinkFlowLab/FlyBot | `e26895e737b1218875aafa1f74ab1d3464f287d2` (2026-11-16 00:07:14 UTC) | Apache-2.0 + `NOTICE` at `runtime/flybot/` |
| Bot Social needed set | https://github.com/Birfy/bot-social | `8706824f53f6cce8212470bc6b442f7271cccd3e` (2026-11-16 07:41:41 UTC) | MIT, Copyright (c) 2026 Birfy, at `services/bot-social/` |

OpenTeamily base: `main` `2cbd0c1c0845338ded1d9c9455a6c9c2c40a4d52`.

FlyBot's bundled `ds-bot.pin.json` still pins DS-Bot `@2b10c70` / tree `5834c00d`. That SHA is no longer on upstream `main` after a history rewrite; `0f130e7` is the equivalent commit (same `ds-bot` tree). Verification fetches `2b10c70` by SHA or compares the tree, and does not adopt `v0.3.6`. See [ds-bot-pin-equivalence.json](ds-bot-pin-equivalence.json).

## Layout

```
runtime/flybot/          needed FlyBot subset (core + social + docker helpers + selected docs)
  LICENSE NOTICE ORIGIN.md OPENTEAMILY.md
  core/ plugins/social/ docker/ docs/…
services/bot-social/     needed Bot Social subset (service, tests, served UI, protocol docs)
  LICENSE ORIGIN.md OPENTEAMILY.md
  src/ test/ public/ docs/SETUP.md …
docs/upstream/           OpenTeamily-authored selection, manifests, integration notes
scripts/verify-upstream-migration.py
```

Each imported path records source `@commit`, purpose, and related issues in the
tree's `ORIGIN.md`.

## License rule

New OpenTeamily files stay under the root MIT license. Imported trees keep their
own licenses. The repository is **not** relicensed as a single MIT work. See
[LICENSING.md](../LICENSING.md).

## Verification

```sh
python3 scripts/verify-upstream-migration.py
python3 -m unittest tests.test_upstream_migration -v
```

Optional: `python3 scripts/verify-upstream-migration.py --fetch` re-checks
included hashes against public GitHub tarballs.

## Tests that are and are not run

- **Run when feasible:** Bot Social `npm test` after `npm ci` (lockfile, no real
  tokens). The provenance verifier.
- **Not run in this change's CI:** FlyBot `core/` and social plugin tests; they
  require DeepSeek Harness, which is not imported.
- **Not claimed:** Docker image build, official FlyBot compose, `dsh web`,
  real volume retain, or Teamily side-by-side acceptance.

## Issues

Related to the license audit ([issue #3](https://github.com/openTeamily/openTeamily/issues/3)),
collaboration protocols ([issue #5](https://github.com/openTeamily/openTeamily/issues/5)),
and the optional plugin path ([issue #15](https://github.com/openTeamily/openTeamily/issues/15)).
This does **not** complete or close #1, #2, #3, #5, or #15. Parent FlyBot issue
#3110 and PRs #3112 / bot-social #789 are not modified.
