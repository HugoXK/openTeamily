# C-page execution cutover

Members, team, messenger and discover pages, including their static assets, are
served by the signed-in account's DS-Bot. The edge and browser shim route C APIs
to that same instance. Bot Social retains shared state and enforces membership;
the runtime retains its own connector token. No central inference fallback.

## Membership migration boundary (not performed by the page cutover)

A platform workspace UUID is NOT proof of ownership. Before these changes a
page GET could call `teams/ensure` and make the first caller the social owner.
This is no longer allowed. Likewise a connector cannot self-claim another
platform user UUID. Native social teams without platform workspace IDs remain
available. Existing mappings must be audited against authoritative platform
state; their prior existence alone is not proof of correct ownership.

Missing workspace mappings return `409 membership_migration_required`, never an
empty substitute team. Legacy workspace/member/conversation data is retained;
no GET creates a team, adds a member, or sends an invitation.

A future trusted, idempotent migration must use a consistent platform snapshot:

* platform account UUID -> its actual isolated runtime -> its provisioned Social
  owner/home, verified through manager control, NOT matching display names;
* workspace UUID -> actual platform owner and every membership, role, suspension,
  timestamps and deletion state; refuse conflicting existing social mappings;
* old conversation participants/agents, messages, edits, read cursors and IDs;
  preserve old IDs in an explicit mapping, never replay messages as new sends;
* pending invites/join requests need explicit token/approval semantics; do not
  turn pending or revoked membership into active membership;
* use source-version/digest receipts and transaction-scoped conflict checks.

This PR does not implement that privileged migration and does not mutate live
memberships. `GET/POST /v1/workspaces` and `POST /v1/teams` still remain platform
metadata dependencies; converting/creating a legacy workspace does not magically
create a linked Social team. Team wizard invite generation requires the verified
link first. Existing history is preserved centrally, not silently imported.

## Execution fence

For workspaces whose owner has a published healthy DS-Bot, Flask group-reply
requests cannot enqueue another infer. Old central group tasks cannot be polled,
claimed or obtain model access, and reconciliation cannot publish duplicate
replies. Rows remain for audit; in-flight old runtimes must be stopped/recreated
at deployment before testing the new inbox. Native group agents use the per-user
Social inbox and DS-Bot chatTurn, not platform runtime_tasks.
Unsupported legacy messenger subroutes fail on DS-Bot rather than falling back
to Flask (including legacy manual agent-reply endpoints not yet ported).

## Deploy and proof

Rebuild web, runtime AND independent Bot Social images; regenerate the edge
configuration and recreate edge/manager after a web restart (shared network
namespace). Preserve all volumes, existing local/transport keys and tokens.
Do not target old FlyBot services. Do not claim completion based on page HTTP200.

Use only fixture accounts/teams. Verify C HTML/assets have the current account's
instance marker; direct /v1 and browser-shim calls go to that same DS-Bot. Missing
mappings must fail409 without writes. After a trusted fixture mapping, prove role
and suspension enforcement with two runtimes plus an outsider: list members,
create/test/revoke fixture invitations, DM/group roundtrip, scoped history and
read state, native agent reply once, repeated polling without central task rows,
and rejected old claim/model-access calls. Test discover query/pagination and
fixture-only publication. Prove unauthenticated Location is relative /register/
(no http or :8081), and verify no DSH cookies/tokens leak. No real-user messages,
invitations or publication are authorized by this cutover.
