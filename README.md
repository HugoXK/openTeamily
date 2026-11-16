# OpenTeamily

An independent, open-source, self-hostable project targeting full Teamily feature parity. This is a new project under the openTeamily organization, not a continuation of development in the original FlyBot repository.

OpenTeamily is a project name, not a claim of affiliation with or endorsement by Teamily. Final product branding remains open; no proprietary code, logos, fonts or legal text are included.

## Status

**Documentation-only bootstrap.** No management API, authentication, Agent execution or browser workflow is implemented here yet. Older FlyBot tests, screenshots and PRs do not establish that functionality exists in this repository.

## Architecture

- **Management server:** accounts, authentication, workspaces, permissions and container lifecycle.
- **FlyBot runtime containers:** execute Agents and expose an authenticated runtime adapter contract.
- Both layers must be open-source and self-hostable. Container allocation granularity and orchestration technology are not decided.
- FlyBot is a candidate runtime component, not a requirement to continue changing its original repository. Source/image reuse requires a license, provenance and dependency audit first.

## Next steps

1. Review the architecture and full capability map.
2. Create native issues/subissues in **this repository**, including dependencies and observable acceptance criteria.
3. Deliver the management-server/runtime-contract vertical slice with tests, followed by actual runtime integration.

See [architecture](docs/ARCHITECTURE.md), [capability roadmap](docs/ROADMAP.md) and [reuse policy](docs/REUSE_POLICY.md).

## License

New material authored in this repository is licensed under MIT; see [LICENSE](LICENSE). This does not relicense any FlyBot, Bot Social, runtime or third-party material. None of their source or histories has been imported in this bootstrap.
