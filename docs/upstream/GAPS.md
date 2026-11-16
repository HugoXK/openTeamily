# Honest gaps after the first source import

This list is the difference between “needed, audited source now lives in the
tree” and “OpenTeamily can build, run, and accept a complete Teamily-equivalent
system.”

## Docker / image

- Official FlyBot `Dockerfile` and `compose.yaml` were **not** imported. They
  pack plugins this snapshot excludes and install DSH globally.
- A future OpenTeamily recipe would still need `@deepseek-ai/dsh@0.2.1-rc.2`
  (or a later audited pin) on a base image, plus Debian components.
- Open audit items that block redistributing such an image remain: npm ↔ git
  correspondence for DSH, MPL LibreOffice kit, OFL fonts, possible Claude
  payloads, and base-image copyright/source offer.
- No official pre-built FlyBot image digest exists to reuse.

## DeepSeek Harness / complete FlyBot function

- Without DSH there is no `dsh web`, no profile install, no real agent loop,
  no signed-in instance UI.
- FlyBot `core` and `plugins/social` tests are not run in OpenTeamily CI here.
- Lark connector dependency is declared but not vendored or tested here.

## Management / product

- No `RuntimeBackend` adapter points at this snapshot.
- No real Docker start/stop/retain-volume acceptance.
- Bot Social is not configured or authorized by the management server.
- Tree, workflow, project, and timeline **source** is not present. Teamily
  requirements for those areas remain open on the parent issues.
- `core/` still contains some UI seams for omitted plugins; they are
  unsupported without the plugins.
- No Teamily side-by-side browser acceptance is claimed.
- Brand assets were excluded, so imported READMEs that pointed at logos have
  broken image links.

## License audit completeness

Issue #3 stays open. Importing these pins does not finish the DSH closure,
trademark, or image-redistribution work, and must not be used to close #1 or #3.
