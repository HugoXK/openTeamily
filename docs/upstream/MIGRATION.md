# Upstream source migration (first import)

Date: 2026-11-16 (Asia/Shanghai).

This change copies a **minimal needed set** of already-audited public source
from FlyBot and Bot Social into isolated trees. It is not a whole-repository
vendor dump, not feature-complete Teamily parity, not a container release, and
not a close of the parent roadmap.

After [PR #21](https://github.com/openTeamily/openTeamily/pull/21) established
upstream DS-Bot **v0.3.6** as the runtime baseline, this import **dropped**
`runtime/flybot/core/` (the old v0.1.5 fork) and kept only the FlyBot
customization layer plus Bot Social.

The include/exclude lists and reasons are in [SELECTION.md](SELECTION.md).
Pins, hashes, counts, and documented modifications are in
[migration-manifest.json](migration-manifest.json).

## Pins (public commits only)

| Component | Upstream | Commit | License in this tree |
| --- | --- | --- | --- |
| FlyBot customization layer | https://github.com/ThinkFlowLab/FlyBot | `e26895e737b1218875aafa1f74ab1d3464f287d2` (2026-11-16 00:07:14 UTC) | Apache-2.0 + `NOTICE` at `runtime/flybot/` |
| Bot Social needed set | https://github.com/Birfy/bot-social | `8706824f53f6cce8212470bc6b442f7271cccd3e` (2026-11-16 07:41:41 UTC) | MIT, Copyright (c) 2026 Birfy, at `services/bot-social/` |
| DS-Bot runtime baseline | https://github.com/Fei2411/DS-Bot | v0.3.6 / `a66cc737cfb6c3d8a2597e748cded6cab1206dd3` (PR #21; not vendored in this PR) | Apache-2.0, in PR #21's `runtime/ds-bot-upstream/` |

OpenTeamily base at first import: `main` `2cbd0c1c0845338ded1d9c9455a6c9c2c40a4d52`.
This branch also contains a regular merge of `main` `ccad9c17` (PR #19).

## Layout

```
runtime/flybot/          FlyBot customization layer (social plugin + docker helpers + selected docs)
  LICENSE NOTICE ORIGIN.md OPENTEAMILY.md
  plugins/social/ docker/ docs/docker.md docs/subsystems/social.md
services/bot-social/     needed Bot Social subset (service, tests, served UI, protocol docs)
  LICENSE ORIGIN.md OPENTEAMILY.md
  src/ test/ public/ docs/SETUP.md …
docs/upstream/           OpenTeamily-authored selection, manifests, integration notes
scripts/verify-upstream-migration.py
```

Each imported path records source `@commit`, purpose, and related issues in the
tree's `ORIGIN.md`. Documented modifications are listed there and in the
manifest's `modified_files`.

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
*unmodified* included hashes against public GitHub tarballs. Modified files are
compared to the recorded original and new sha256 values instead.

## Tests that are and are not run

- **Run in CI:** Bot Social `npm test` after `npm ci` (lockfile, no real
  tokens). The provenance verifier. `@flybot/social` plugin-only tests
  (`npm test` in `runtime/flybot/plugins/social/`, no dependencies, no DSH).
- **Not run in this change's CI:** FlyBot host-integration tests that required
  the deleted `core/` fork and DeepSeek Harness. Those tests were removed from
  the snapshot; they need a rewrite against the v0.3.6 baseline.
- **Not claimed:** Docker image build of this customization layer, official
  FlyBot compose, wiring to the management server, real volume retain, or
  Teamily side-by-side acceptance. Upstream baseline proof belongs to PR #21.

## Issues

Related to the license audit ([issue #3](https://github.com/openTeamily/openTeamily/issues/3)),
collaboration protocols ([issue #5](https://github.com/openTeamily/openTeamily/issues/5)),
and the optional plugin path ([issue #15](https://github.com/openTeamily/openTeamily/issues/15)).
This does **not** complete or close #1, #2, #3, #5, or #15. Parent FlyBot issue
#3110 and PRs #3112 / bot-social #789 are not modified.
