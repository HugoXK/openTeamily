# Object identity, not route-only migration

Each account routes exclusively to its attested runtime. The agents feature's
`native_agent_objects` table binds each stable 32-hex legacy agent ID to one
actual DS-Bot roster Bot ID. `agents/reconcile` idempotently creates missing
native objects, recovering interrupted creates from native Bot metadata. It does
not send messages or greetings. Both IDs are returned by create/get/list.

Native name/instruction/hidden edits are pulled on platform reads (with revision
bumps); platform writes call the native roster APIs. Native deletion produces a
visible archived/tombstoned mapping, never silent recreation. The compatibility
SQLite holds workspace, category, quick-start and legacy history metadata; it is
not another execution engine. Native names have a 40-character constraint; long
or colliding legacy names use a deterministic ID suffix without changing the
legacy ID/title.

`native_agent_sessions` maps each logical agent conversation key to a real native
Session. New agent turns run on that mapped Bot and Session, not on the Main Bot
with a persona prompt. List/create returns native session IDs for inspection.

## Historical sessions increment (acceptance pending)

Main Bot thread chains are adopted by their original bridge key, including the
pre-plugin plain agent-conversation ID. Chains move to the mapped Bot without
copying native logs. A newer mapped thread is retained; both chains are scanned
before missing messages are appended. Durable Bot sessionKeys recover interrupted
create/map commits; native_agent_events maps source messages after native flush.
Source IDs recover the flush/ledger crash window. Original timestamps remain in
source metadata; native append sequence stays append-only. Failed historical
messages remain diagnostics, not fabricated assistant replies.

c3f226 functional/model/isolation acceptance passed. dd647 consumed all retained
agent/automation bundles but failed conversation creation with a ReferenceError.
#523 fixes it; historical native-view/dedup acceptance is still pending.

Outstanding: explicit workspace selection and reverse mapping on native creation,
complete historical ordering/native-view acceptance, remaining user administration
and profile/onboarding central paths, real skill-run abort, and Teamily reference
inspection (unverified, not claimed). These are gaps, not completed capabilities.

## Shared group increment

Bot Social conversation reads now reconcile a real native roster room/Session,
with `openteamily.conversation_id` pointing to the canonical shared conversation.
The group exposes native_room_id/native_session_id. Local agent participants use
mapped native Bot IDs; human participants remain remote humans, never fake Bots.
Native room-chat reads Bot Social directly, including edits/retractions/history
paging. Native text send/title/agent membership/announcement changes are routed
to that same shared record. Native delete leaves the shared conversation for the
current member and archives its local room; it does not delete other people's
history. Unsupported native-only settings fail visibly instead of diverging.

Native remote-human editor is merged for the next deployment; acceptance pending.

Remaining: reverse native
creation requires explicit workspace selection; initial reconciliation still
requires a conversation read; historical event import/adoption still needs native-view evidence. Do not label full feature parity accepted until test-account
native-view consistency evidence exists after deployment.


## Current closeout: personal execution identity correction (acceptance pending)

Private `chat/*` now delegates creation, listing, messages and actual model execution to
its existing, explicitly scoped workspace-agent/native Bot mapping. It no longer executes
through Main Bot. Existing Bot IDs are retained; the native Main Bot remains a separate
native assistant, not falsely relabelled as the platform agent. No duplicate Bot is created.

Owner-filtered agents bundles carry the authoritative `personal_agents` binding. During
import, retained `chat.sqlite3` conversations/messages are copied by their original IDs
into canonical agent history; originals are retained. Conflicting workspace/agent/message
ownership is rejected. Chat feature loads before agent import so acceptance cannot precede
this adoption. All owned legacy `agent:...`, plain conversation and `plugin:...` Main Bot
Session parts are adopted; existing mapped parts are retained and scanned too. Historical
`otp:` user request IDs are matched before text matching. No historical turn is replayed.
The schema adapter is installed before core restoration; append-only old logs are not rewritten.

Deployment and real-model/native-history proof are still pending for this correction.
Private chat rename/remove via the old plugin API are explicitly rejected rather than
silently altering retained legacy rows; full native part deletion parity is not implemented.
Previously documented unrelated migration gaps and Teamily interaction verification remain open.


### Native persistence format defect found during restart acceptance

The first history importer produced incomplete native v4 envelopes (missing identified
user/assistant messages, nested model source, turn/step boundaries, and ignorable
status-record grammar). Earlier runtime-only stream normalization was insufficient.
The import writer now emits the complete native schema. Historical provider/model were
not retained: metadata explicitly says `openteamily-history` / `historical-unknown`,
with `imported:true`, no API invocation and no invented token usage.

A one-shot offline repair uses the published native strict format codec and JSONL
persistence provider, not ad-hoc binary edits. It rejects any affected suffix containing
unrecognized/unmarked events, surface replacements or sequence references. Original
compressed files and all source data are retained. A fsynced manifest records the exact
old/new event-sequence mapping before any replacement; the canonical message ledger is
remapped transactionally by message ID. Bot, Session, platform message IDs, content and
original timestamps are preserved. Native envelope events are inserted, explicitly marked
as imported transcript boundaries rather than newly executed model turns. Completion still
requires deployment, repair proof, restart, and test-account native/history acceptance.
