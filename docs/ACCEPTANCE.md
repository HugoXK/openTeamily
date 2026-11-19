# Evidence and acceptance status

Full functionality is the goal; a merged slice does not close #1 or #2. Every product acceptance requires a real Teamily comparison. No mock HTTP test, fake backend, guide excerpt or screenshot of a handmade mock UI counts as equivalent product behavior.

## Record per check

Preserve these fields even when empty, using `pending-verification` rather than a guessed result:

```json
{
  "check_id": "workspace-create",
  "scope": "product-comparison",
  "openteamily": {
    "commit_or_image": null, "config": null, "role": null,
    "steps_and_input": [], "actual_result": null, "evidence": [],
    "status": "not-executed"
  },
  "teamily": {
    "page_url": null, "role": null, "steps_and_input": [],
    "actual_result": null, "evidence": [],
    "observed_at_asia_shanghai": null, "status": "pending-verification"
  },
  "comparison_status": "pending-verification",
  "gap_and_followup": "Record both same-role real operation results before accepting parity"
}
```

Do not place secrets, cookie values, personal data or access-bearing URLs into public evidence. A guide-only or unavailable gray rollout stays `pending-verification`; it is not evidence of absence or a parity pass. Independently verify negative/permission/error paths where possible and record differences instead of erasing them.

## PR16 foundation snapshot (not the later runtime follow-up)

Current lifecycle implementation/gaps are separately recorded in [RUNTIME_IMPLEMENTATION.md](RUNTIME_IMPLEMENTATION.md). PR16 retains24 tests; the expanded branch adds simulation/manager/planner coverage, never real container or product parity acceptance.

| Check | OpenTeamily evidence/status | Teamily evidence/status | Overall status |
|---|---|---|---|
| Auth, CSRF, private persistence, owner-only workspace records | 24 executable self-authored in-process WSGI/SQLite tests passed locally; test source in `tests/test_management.py` | Real same-role/page/action/result comparison not performed in this slice; pending-verification | Self-hosting foundation tested, not independent product acceptance |
| Browser signup/login/workspace interaction | No frontend or browser test in this slice; not-executed | pending-verification | pending-verification |
| Lifecycle/manager/volumes/jobs | Not implemented; no fake/runtime test pass claimed | Internal Teamily implementation unknown, not assumed identical | Pending self-hosting implementation and real deployment acceptance |
| Full13 product domains | Not implemented by this PR | Existing partial inventory cannot replace real operation evidence | Not accepted |

CI status must come from actual GitHub checks; a workflow file is not proof CI passed. Independent reviewer acceptance is pending. No real server, browser, Docker container, public ingress, firewall change or deployment was run for these local tests. The development runner was invoked with `--help` only.
