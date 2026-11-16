# Team wizard (create or convert)

Self-written for OpenTeamily. Name length (≤60), Team ID pattern (3–30 lowercase letters, digits or hyphens) and the choice between a new independent workspace and converting the current one follow the 2026-11-16 Teamily contrast. Team roles and invites were not comparable on a free personal account and are not claimed as parity.

## Routes

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/teams` | `{name,slug,mode}` with `mode=new` or `mode=convert` plus `workspace_id`. Owner session, CSRF, exact Origin, and `Idempotency-Key` required |
| GET | `/v1/workspaces` / `{id}` | Now also returns `kind` (`workspace` or `team`), `slug`, `team_name`, and `converted` |

`slug` must match `[a-z0-9][a-z0-9-]{1,28}[a-z0-9]` and must not be a reserved path name (`settings`, `team`, `v1`, …). Convert is owner-only; members, instances and the workspace id stay in place. A converted workspace is renamed to the team name. Additive `workspace_teams` / `team_requests` tables on schema `user_version` 1.

A same-origin three-step page is served at `/team`. This is not a Teamily team-roles comparison.
