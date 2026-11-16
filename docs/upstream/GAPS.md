# Honest gaps after the first source import

This list is the difference between “needed, audited source now lives in the
tree” and “OpenTeamily can build, run, and accept a complete Teamily-equivalent
system.”

## Runtime baseline vs. this snapshot

- OpenTeamily tracks upstream DS-Bot **v0.3.6** as the runtime baseline
  ([PR #21](https://github.com/openTeamily/openTeamily/pull/21) (now on `main`)). This snapshot
  does not vendor that tree and does not vendor the old FlyBot `core/` fork.
- `@flybot/social` has a first-slice host adapter in `runtime/flybot-social-host/`
  (façade over unmodified v0.3.6 `createRuntime()`, group rooms on the 0.3.5+
  write-ahead ledger). An OpenTeamily-authored image recipe lives in
  `runtime/flybot-image/` (CI builds and smokes it under the compose manager
  contract). The dsh web `__flybot__` slot host lives in
  `runtime/flybot-web-slots/`. Live Bot Social onboarding is enabled when a
  server URL is configured (CI uses a fake server and `ot-fake-` tokens only).
  Management-plane injection of that URL, composer `@` mentions / Bot details
  in the official ds-bot drawer, and a license-complete public image release
  are still open. The social façade now posts group/DM lines and hosts
  face-to-face rooms on the v0.3.6 ledger; Teamily comparison of those
  flows is not done.
- Host-integration tests that imported FlyBot `core/` were removed, not ported.
  The new adapter tests cover façade + ledger + `apply()` on the v0.3.6 host.

## Docker / image

- Official FlyBot `Dockerfile` and `compose.yaml` were **not** imported. They
  pack plugins this snapshot excludes and assume a root entrypoint.
- `runtime/flybot-image/` is the OpenTeamily recipe: USER 1000, port 8080,
  HEALTHCHECK, `/data` workspace, wrapper plugin on unmodified v0.3.6 plus
  the social host. CI (`.github/workflows/flybot-runtime-image.yml`) builds
  and smokes it. That does not close issue #3 and is not a public release.
- Open audit items that still block redistributing a published image: npm ↔ git
  correspondence for DSH 0.2.2-rc.1, MPL LibreOffice kit, OFL fonts, possible
  Claude payloads, and base-image copyright/source offer.

## DeepSeek Harness / complete function

- The import PRs did not run `dsh web`. The image recipe CI does, as a container
  smoke only.
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
