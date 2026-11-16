# OpenTeamily

An independent, open-source, self-hostable project targeting full Teamily feature parity. This is a new project under the openTeamily organization, not a continuation of development in the original FlyBot repository.

OpenTeamily is a project name, not a claim of affiliation with or endorsement by Teamily. Final product branding remains open; no proprietary code, logos, fonts or legal text are included.

## Status

**Current slice:** a runnable Python/SQLite authentication, workspace, and simulated instance/jobs API; an **opt-in operator Compose execution CLI** (default disabled) with HTTP/subprocess-stub tests; and a first, minimal source import of related FlyBot and Bot Social trees. Live Docker/FlyBot/real-volume acceptance, management integration of the imported trees, and browser workflows remain **unverified or missing**. See [operator setup, recovery, evidence limits and next tasks](docs/COMPOSE_MANAGER.md), [lifecycle scope and remaining gates](docs/RUNTIME_IMPLEMENTATION.md), and [implemented routes, startup/test commands, security configuration and gaps](docs/MANAGEMENT_API.md). Older FlyBot tests, screenshots and PRs do not establish functionality in this repository.

## Architecture

- **Management server:** accounts, authentication, workspaces, permissions and container lifecycle.
- **FlyBot runtime containers:** execute Agents and expose an authenticated runtime adapter contract.
- Both layers must be open-source and self-hostable. The first optional runtime adapter uses local Compose with independent instance IDs; final user/workspace allocation granularity is not decided.
- FlyBot is the candidate runtime. A minimal needed set of related public source from FlyBot and Bot Social is imported as isolated snapshots under [`runtime/flybot`](runtime/flybot/ORIGIN.md) and [`services/bot-social`](services/bot-social/ORIGIN.md); they keep their original licenses and are not relicensed as OpenTeamily MIT. The management server is not yet wired to those trees, and a complete FlyBot image is not claimed (DeepSeek Harness and base-image closures are not vendored). See [migration notes](docs/upstream/MIGRATION.md), [gaps](docs/upstream/GAPS.md) and [licensing](docs/LICENSING.md).

## Next steps

1. Review the architecture and full capability map.
2. Create native issues/subissues in **this repository**, including dependencies and observable acceptance criteria.
3. Review the authentication/workspace foundation, then deliver durable runtime jobs and the fake backend; review the opt-in manager/Compose adapter, then perform separately approved real container and Teamily comparison acceptance.

See [architecture](docs/ARCHITECTURE.md), [capability roadmap](docs/ROADMAP.md) and [reuse policy](docs/REUSE_POLICY.md).

## License

New material authored in this repository is licensed under MIT; see [LICENSE](LICENSE). Imported FlyBot source remains Apache-2.0 with its `NOTICE`. Imported Bot Social source remains MIT, Copyright (c) 2026 Birfy. The root MIT license does not relicense those trees. See [docs/LICENSING.md](docs/LICENSING.md).
