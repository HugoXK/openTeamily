# Capability map and issue handoff

The target is full functional parity, not just visual parity or a rearrangement of existing FlyBot capabilities. Unsupported backends are implementation work, not permanent exclusions. Do not expose nonfunctional product entry points as completed features.

## Functional domains

1. Conversations, sharing, invitations, approval and revocation semantics.
2. Agent creation, configuration, modes, directory/public profiles and execution.
3. Messages, attachments, interaction tools and authorized historical search/context.
4. Automation, scheduling, time zones, execution output and failure recovery.
5. Memory, relationship graph, user profile, actions and editing.
6. Artifacts: persistent creation, browsing, editing, versions, export and sharing.
7. Workspaces, teams, membership/roles and multi-Agent collaboration.
8. Channels, app connectors, OAuth/secrets, MCP and skills.
9. Agent API, runtime registration, routing and scoped access.
10. Settings, appearance, language, shortcuts and message folding.
11. Discovery, profiles, downloads, calls, guides, help and notifications.
12. Seats, usage/quotas and configurable open-source equivalents for optional billing/rewards/invites.
13. Browser acceptance, accessibility, keyboard/input methods, responsive layouts and interaction states across all domains.

## Suggested dependency sequence

- Foundation: management/runtime architecture decisions, identity/permissions, lifecycle and persistence/isolation.
- First implementation: authenticated workspace and runtime lifecycle vertical slice with a test adapter, then real container acceptance.
- Product slices: conversation/collaboration and search; Agent/automation; memory; Artifacts; channels/MCP/skills; Agent API; workspace experience; discovery/calls/help; usage/optional commercial equivalents.
- Cross-cutting: license/dependency audit, security, migration compatibility and real browser/end-to-end acceptance.

Each work package needs scope, dependencies, exclusions limited to that delivery, and executable acceptance criteria. Create native subissue relationships in this repository and read them back. This file is not a claim that new-repository issues have already been created.

## Existing planning input (historical, read-only)

An earlier requirement inventory and 11 work-package issues exist in [FlyBot #3110](https://github.com/ThinkFlowLab/FlyBot/issues/3110) and #3113–#3123. They are reference material only: the subsequent decision to create this independent repository supersedes their instructions to develop in the original repository and their fixed branding assumptions. Do not close, rewrite or extend those old issues as part of the new project.

The new plan should adapt that functional breakdown, not blindly copy its implementation or licensing assumptions. Existing FlyBot PRs do not mean features are implemented or tested in OpenTeamily. Original screenshots were hand-authored mockups; the later real-component fixture was blocked before file:// navigation. Neither is browser acceptance for this project.

## Plugin selection

Assess `project`, `timeline` and other plugins against actual capabilities, dependencies, target requirements and licenses. Questions about whether they are needed are not a decision to delete them. No plugin is imported or declared permanently excluded in this bootstrap.
