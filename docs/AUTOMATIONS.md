# Automations API (issue #6, slice 1)

Related: [#6](https://github.com/openTeamily/openTeamily/issues/6) (agent creation, modes, public pages, in-container runs and scheduled tasks — **not completed**), [#7](https://github.com/openTeamily/openTeamily/issues/7), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice stores automation *configuration* on the management API: a title, a prompt, a schedule and participating workspace members. It is self-written. No FlyBot Project plugin, Bot Social, DS-Bot or Teamily source was used, and **nothing is executed or scheduled**. Enabling a record does not start a timer or a container.

Teamily's automation UI was opened historically (template, prompt, time, participating members) but no automation was created or run. The `custom` template, schedule field shapes and role defaults below are OpenTeamily assumptions. Do not describe this slice as automation parity, and do not treat a successful unit test as in-container execution acceptance.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/automation-templates` | Session required. Currently only the self-authored `custom` template |
| GET | `/v1/workspaces/{id}/automations` | Visible to workspace owner and members |
| POST | `/v1/workspaces/{id}/automations` | `{title,prompt,template_id,schedule,participants}`. Owner or admin. Requires `Idempotency-Key`, exact Origin and CSRF. Created records are **disabled** |
| GET | `/v1/workspaces/{id}/automations/{id}` | Visible to workspace owner and members |
| POST | `/v1/workspaces/{id}/automations/{id}` | `{revision,changes}` partial update. Stale `revision` → `409` with `error.current` |
| POST | `/v1/workspaces/{id}/automations/{id}/remove` | `{}`. Owner or admin |

`participants` is a list of existing usernames that must already be the owner or a member of the workspace. Titles are unique per workspace (case-insensitive) and are the dedup key; the same `Idempotency-Key` plus payload returns the original record.

## Schedule (OpenTeamily defaults — not yet Teamily-verified)

| `kind` | Fields |
|---|---|
| `once` | `date` (`YYYY-MM-DD`), `time` (`HH:MM` 24h), `time_zone` (IANA, validated with `zoneinfo`) |
| `daily` | `time`, `time_zone` |
| `weekly` | `time`, `time_zone`, `weekday` (`1`=Monday … `7`=Sunday) |

## Storage and roles

Additive `automations` table on schema `user_version` 1. Members may read; only owner and admin may create, update or delete. Default cap is 20 automations per workspace.

## Not in this slice

No scheduler, no container run, no execution feedback, no public page, no agent-mode switch, no UI. Multi-target delivery beyond a list of workspace members, and any comparison with Teamily templates, remain later work.
