# Architecture baseline

## Confirmed direction

The system is a **management server plus FlyBot runtime containers**, not one process that runs everything and not two unrelated applications presented as a completed integration.

| Boundary | Responsibility |
|---|---|
| Management server | Accounts/sessions, workspace membership and roles, authorization, runtime registration, desired lifecycle, status and audit metadata |
| Runtime container | Agent execution and runtime-owned conversation/workload state behind an authenticated adapter |
| Browser client | Authenticated product workflows; no direct privileged access to the orchestration substrate |

Management credentials, user credentials and container control credentials must be separate. Every control operation must authorize the account/workspace/runtime relationship. A runtime cannot select another workspace merely by supplying an identifier. Logs and APIs must not disclose secrets or other tenants' content.

## Decisions still open

- Container allocation: per account, workspace, Agent, or another justified model.
- Orchestration backend and self-hosting topology; no vendor or scheduler is selected.
- Management storage, runtime state ownership details, API routing and compatibility policy.
- Which existing runtime components can be reused after provenance, licensing and dependency review.

## First proposed vertical slice

After the relevant issues are created: authenticated workspace/runtime records; an explicit lifecycle backend interface; create/register, start, observe, stop and restart transitions; authorization and idempotence tests. A fake backend is useful for deterministic unit tests but must never be reported as successful real container deployment. Add a real self-hostable adapter only after lifecycle and isolation decisions are recorded.

Deployment must document storage/backup and credential handling; no privileged host socket should be exposed to browsers or Agents. Destructive lifecycle actions require explicit semantics and authorization. Do not start production containers as part of this documentation bootstrap.

## Scope of this baseline

This is a starting contract for collaborative design, not an implemented service or final orchestration specification. Full product capabilities remain owed even when their model, API or runtime support does not exist yet.
