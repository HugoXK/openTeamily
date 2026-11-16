# Automations API (issue #6, slices 1–2)

Related: [#6](https://github.com/openTeamily/openTeamily/issues/6) (agent creation, modes, public pages, in-container runs and scheduled tasks — **not completed**), [#7](https://github.com/openTeamily/openTeamily/issues/7), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice stores automation *configuration* on the management API: a title, a prompt, a schedule and participating workspace members. It is self-written. No FlyBot Project plugin, Bot Social, DS-Bot or Teamily source was used, Slice 2 adds due-time evaluation, run records and a dispatch hook. Enabling a record still does **not** start a background timer in the Web process. A tick is an explicit call. The bundled fake backend records the hook and never starts Docker. A successful hook or unit test is not in-container execution acceptance.

Teamily's automation UI was opened historically (template, prompt, time, participating members) but no automation was created or run. The `custom` template, schedule field shapes and role defaults below are OpenTeamily assumptions. Do not describe this slice as automation parity, and do not treat a successful unit test as in-container execution acceptance.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/automation-templates` | Session required. `custom` plus twelve work and twelve life templates (rephrased titles) |
| GET | `/v1/workspaces/{id}/automations` | Visible to workspace owner and members. Optional `q` (title/prompt search) and `category` (`work`, `life`, `custom`, `mine`) |
| POST | `/v1/workspaces/{id}/automations` | `{title,prompt,template_id,schedule,participants}` plus optional tag fields `intent` (`research`,`monitor`,`create`,`analyze`,`plan`,`collaborate`), `scope` (`once` / `ongoing`), `agents`. An omitted/empty prompt is compiled from the tags and template. Owner or admin. Requires `Idempotency-Key`, exact Origin and CSRF. Created records are **disabled** |
| GET | `/v1/workspaces/{id}/automations/{id}` | Visible to workspace owner and members |
| POST | `/v1/workspaces/{id}/automations/{id}` | `{revision,changes}` partial update. Stale `revision` → `409` with `error.current` |
| POST | `/v1/workspaces/{id}/automations/{id}/remove` | `{}`. Owner or admin |
| POST | `/v1/workspaces/{id}/automations/tick` | Owner or admin. Evaluates due slots for this workspace only, records at most one run per slot, and calls the runtime dispatch hook. CSRF + exact Origin required |
| GET | `/v1/workspaces/{id}/automations/{id}/runs` | Visible to workspace owner and members. Bounded pagination (`limit`, `cursor`) |


`participants` is a list of existing usernames that must already be the owner or a member of the workspace. Titles are unique per workspace (case-insensitive) and are the dedup key; the same `Idempotency-Key` plus payload returns the original record.

## Schedule (round-1 contrast; not parity)

| `kind` | Fields |
|---|---|
| `now` | `time_zone` only. Fires a single stable slot (`due_at=0`) on the first tick after the record is enabled |
| `once` (also accepts `later`) | `date` (`YYYY-MM-DD`), `time` (`HH:MM` 24h), `time_zone` (IANA, validated with `zoneinfo`) |
| `daily` | `time`, `time_zone` |
| `weekly` | `time`, `time_zone`, `weekday` (`1`=Monday … `7`=Sunday) |
| `monthly` | `time`, `time_zone`, `day` (`1`–`31`; skipped in months that do not have that day) |
| `weekdays` | `time`, `time_zone`; Monday–Friday |

Tag fields compile into an editable prompt: template text, intent, scope, schedule, participating agents and members. Editing the prompt marks `compiled` false. Twelve life templates were added from the 2026-11-16 round-2 recapture, with rephrased titles and prompts. Intent is one of six verbs recaptured in that pass. The monthly day-of-month input was **not seen**; `day` 1–31 is an unverified default.

## Storage and roles

Additive `automations` table on schema `user_version` 1. Members may read; only owner and admin may create, update or delete. Default cap is 20 automations per workspace.

## Scheduler (slice 2)

`Scheduler.tick_workspace` / `tick_all` and `POST .../automations/tick` use `due_at()`:

- Only the **current** slot is considered (today's daily/weekly time, or a past `once` instant). Missed earlier days are not backfilled.
- Disabled automations are skipped. A slot that already has a non-`queued` run is not fired again.
- The hook is `backend.dispatch_automation(payload, db=)`. `FakeRuntimeBackend` records the call and, if the workspace has instance rows, returns their ids. It does not run Compose or Docker. With no backend, runs are `skipped` / `no_backend`. With no instances, `skipped` / `no_instance`. Hook exceptions become `failed` / `runtime_failure` without exception text.
- The Web runner does not start a background timer. Operators tick explicitly.

Run rows are an additive `automation_runs` table on schema `user_version` 1. Default cap is 200 runs per automation (`Config.max_runs_per_automation`).

## Not in this slice

No background daemon, no real container execution, no public unauthenticated page, no agent-mode switch. A same-origin page at `/automations` lists automations with search and 我的/工作/生活 tabs, and edits the tag fields, schedule kinds and compiled prompt through the existing API. Enabling a record still does not start a background timer; the page can request an explicit tick. This is still not Teamily automation parity.

Dispatch hooks receive the workspace-or-platform model API (redacted in run records). See [MODEL_API.md](MODEL_API.md). This is not container execution and not Teamily parity.
