# Owned functional completion aggregate

Base: ef71b3d1, after merged342; ordinary-synced main13641eb9 including contributor332. Local branch: feat/functional-completion-big. Not a claim of Teamily parity or all controls complete.

| Gap/control | Implementation and state | Automated proof | Acceptance still required |
|---|---|---|---|
| Registration entry, policy, create, session, first-use | `/register` + links + GET auth policy; unchanged operator opt-in; actual session verification; first-home initialization ordering and 201 handling | test_registration_page (new account/settings/personal agent/actual controlled inference/restart/tenant isolation); registration_page Node; added real CI form/home/agent scenes | CI captures pending; Deployment owns actual HTTPS/Host/policy validation, not this worktree |
| Import private instruction / install / use / upgrade / revoke / history | imported_skill_versions/heads + existing scoped bindings/task material; v2 capability handshake in Python and container; immutable versions/digest/CAS/explicit consent; no file or shell hooks | test_imported_skills + existing skills/runtime suites, skill_imports Node, CI import/run/update/revoke scenes | Current own v2 runtime and configured model; real quality unverified; executable/signed remote registry/shared DSH absent |
| Live chat/notification/sidebar invalidation | authenticated SSE /workspaces/id/events, constant-memory fingerprints; 250ms query budget, 2s heartbeat/check, bounded20s connection, 2 streams/user/32 process, no write lock during waits | streamed WSGI tests, real persisted update/reconnect/session/member revoke/nonmember silence; JS connection epochs/visibility/fallback | Proxy must not buffer; current social-message refresh is explicit banner, private inference remains polling; not durable event replay/token streaming/webpush |
| Document version awareness / explicit latest read | real persisted revision invalidation; draft preserved; confirmed load; existing CAS writes unchanged | WSGI/JS plus added real CI revision-change/draft-retention scene | No CRDT/merge/presence or collaborative editor claim |
| Word / PDF / spreadsheet downloads | actual DOCX OPC/XML, Unicode text-PDF, dashboard data XLSX; current and historical auth/version checks; no renderer execution, network fetch, macro or formula | test_office_exports validates ZIP/XML/relationships/formula safety/history/xref; local independent Poppler extraction; CI actual downloads added | Text PDF only BMP Unicode/CJK viewer-font substitution; DOCX retains text/headings, not full Markdown/Office; XLSX all strings; full Office/PPTX/media/thumbnail editing still engineering |

## Contributor ownership refreshed before coding and again before publication (48 open)
Do not edit other branches or count these as landed:352/271 old search hit loading;349 reminders;348 run details;345 mute/notification;346 agent proactivity;320 chat-language prompt;284 preference/notification consumers;309/340 notification writers;335 Discover author;299 memory share;315 composer;277/326 image;322 edit;330/310 automation;273 meeting works;289 action save;313/290 team/template;281 invite;293 email auth;282 runtime key;316 archive restore;298 profile;302 guide;317 docs;325 avatar;280 follow URL;197 preference honesty;294 onboarding;237 checklist. 283 boolean-only remains superseded. No124 reply-protocol changes.

## Remaining complete scope
See FUNCTIONAL_COMPLETION_PLAN.md and VISIBLE_FUNCTIONS_INVENTORY.md for all six categories and source census. None is silently hidden or called credential-blocked wholesale. No operator/model/Composio credentials discovered or reused; Composio remains each user's own key; model platform default+user override retained. No production, user computer, :3320 or :3786 changes. No npm installation, external invitations/sends/payments, cloud sessions, proprietary assets, or upstream vendor byte edits. All current tests/captures are synthetic, not real-vendor or Teamily acceptance.

Latest refresh additionally protects363 memory history84d3f736f,362 self-delete45765a294,361 memory preferencesd139d5dde,356 memory dream24a7590e4,358 unread dividercafded7a0,354 attachment search913480e28. Updated28449de89563,34967691d71a,348e838eec41 remain separate. Registration293410c6a45c covers email-code identity, not this same-origin form for the existing username/password endpoint.

## Public HTTP model policy: reviewed, not integrated or enabled
The independent operator-policy draft is not production-ready. Python's
`ipaddress.is_global` alone also returns true for multicast (`224.0.0.1`,
`239.255.255.250`, `ff02::1`); the draft accepts these and issues grants. Its
11 helper tests pass but do not exercise this case, private-file loading, either
credential issuance route, authenticated grant provenance, or actual redirect
credential isolation. Do not infer application approval from those tests.

This aggregate does not enable public HTTP model endpoints, read/import any
provider key, or broaden shared `insecure_http_allowed`. Existing HTTPS and
local/private rules remain unchanged. A future complete operator-only,
default-disabled implementation needs strict public unicast IP/port/path
validation, private bounded no-symlink loading, both issuance paths rechecking
current policy, Python/container runtime grant checks, and denial of every HTTP
redirect with integration tests. No hostname/wildcard/global insecure bypass is
acceptable. Deployment must independently confirm its own concrete endpoint
and key authorization; another agent's report is not that authorization.

Contributor332 personal message hiding is now landed in the synced base. The
SSE fingerprint respects the current user's deletion rows; another member's
snapshot is unchanged. Overlapping session loads now commit one current
workspace/user/request snapshot only, including the per-agent fanout phase.
