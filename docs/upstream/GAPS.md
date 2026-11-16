# Honest gaps after the first source import

This list is the difference between “needed, audited source now lives in the
tree” and “OpenTeamily can build, run, and accept a complete Teamily-equivalent
system.”

## Runtime baseline vs. this snapshot

- OpenTeamily tracks upstream DS-Bot **v0.3.6** as the runtime baseline
  ([PR #21](https://github.com/openTeamily/openTeamily/pull/21) (now on `main`)). This snapshot
  does not vendor that tree and does not vendor the old FlyBot `core/` fork.
- `@flybot/social` still needs to be adapted onto the v0.3.6 plugin/profile
  model (including group-chat / ledger differences). That work is not in this
  change.
- Host-integration tests that imported FlyBot `core/` were removed, not ported.

## Docker / image

- Official FlyBot `Dockerfile` and `compose.yaml` were **not** imported. They
  pack plugins this snapshot excludes and install DSH globally.
- A future OpenTeamily recipe would use the PR #21 upstream image (DSH
  `0.2.2-rc.1` as pinned there) plus this customization layer, on a base image.
- Open audit items that block redistributing such an image remain: npm ↔ git
  correspondence for DSH, MPL LibreOffice kit, OFL fonts, possible Claude
  payloads, and base-image copyright/source offer.

## DeepSeek Harness / complete function

- This PR does not install DSH and does not run `dsh web`.
- Lark connector dependency is declared on the (now-removed) core package and
  is not vendored or tested here.

## Management / product

- No `RuntimeBackend` adapter points at this snapshot or at PR #21's tree.
- No real Docker start/stop/retain-volume acceptance.
- Bot Social is not configured or authorized by the management server.
- Tree, workflow, project, and timeline **source** is not present. Teamily
  requirements for those areas remain open on the parent issues.
- No Teamily side-by-side browser acceptance is claimed.

## License audit completeness

Issue #3 stays open. Importing these pins does not finish the DSH closure,
trademark, or image-redistribution work, and must not be used to close #1 or #3.
