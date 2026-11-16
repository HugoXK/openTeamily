# Upstream snapshots

OpenTeamily-authored documentation for the first FlyBot and Bot Social source import.
This is a **needed-set** import, not a whole-repository copy.

- [SELECTION.md](SELECTION.md) — include and exclude lists with reasons
- [MIGRATION.md](MIGRATION.md) — pins, layout, verification
- [DEPENDENCY-GRAPH.md](DEPENDENCY-GRAPH.md) — core, social, Bot Social, omitted plugins
- [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md) — Project, Timeline, Tree, Workflow path
- [INTEGRATION.md](INTEGRATION.md) — management-server wiring, not done yet
- [GAPS.md](GAPS.md) — Docker, DSH, and product gaps
- [ds-bot-pin-equivalence.json](ds-bot-pin-equivalence.json) — FlyBot's DS-Bot `@2b10c70` pin, tree `5834c00d`, and equivalent post-rewrite commit `0f130e7` (not `v0.3.6`)
- [migration-manifest.json](migration-manifest.json) — counts, pins, exclusion lists
- [flybot-files.json](flybot-files.json) / [bot-social-files.json](bot-social-files.json) — per-file sha256 and git blob

Verify with `python3 scripts/verify-upstream-migration.py`.
