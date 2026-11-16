# OpenTeamily

An independent, open-source, self-hostable project targeting full Teamily feature parity. This is a new project under the openTeamily organization, not a continuation of development in the original FlyBot repository.

OpenTeamily is a project name, not a claim of affiliation with or endorsement by Teamily. Final product branding remains open; no proprietary code, logos, fonts or legal text are included.

## Status

**First implementation slice (under review):** a runnable Python/SQLite authentication and owner-scoped workspace API. Stacked follow-ups add durable instance/jobs, explicit simulation and an **opt-in operator Compose execution CLI** (default disabled). The manager path has actual HTTP/subprocess-stub tests, but live Docker/FlyBot/real-volume acceptance and browser workflows remain **unverified or missing**. See [operator setup, recovery, evidence limits and next tasks](docs/COMPOSE_MANAGER.md). See [lifecycle scope and remaining gates](docs/RUNTIME_IMPLEMENTATION.md). Older FlyBot tests, screenshots and PRs do not establish functionality in this repository. See [implemented routes, startup/test commands, security configuration and gaps](docs/MANAGEMENT_API.md).

## Architecture

- **Management server:** accounts, authentication, workspaces, permissions and container lifecycle.
- **FlyBot runtime containers:** execute Agents and expose an authenticated runtime adapter contract.
- Both layers must be open-source and self-hostable. The first optional runtime adapter uses local Compose with independent instance IDs; final user/workspace allocation granularity is not decided.
- FlyBot is a candidate runtime component, not a requirement to continue changing its original repository. Source/image reuse requires a license, provenance and dependency audit first.

## Next steps

1. Review the architecture and full capability map.
2. Create native issues/subissues in **this repository**, including dependencies and observable acceptance criteria.
3. Review the authentication/workspace foundation, then deliver durable runtime jobs and the fake backend; review the opt-in manager/Compose adapter, then perform separately approved real container and Teamily comparison acceptance.

See [architecture](docs/ARCHITECTURE.md), [capability roadmap](docs/ROADMAP.md) and [reuse policy](docs/REUSE_POLICY.md).

## License

New material authored in this repository is licensed under MIT; see [LICENSE](LICENSE). This does not relicense any FlyBot, Bot Social, runtime or third-party material. None of their source or histories has been imported in this bootstrap.
