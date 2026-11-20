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

Outstanding parity work (do not claim complete): historical plugin-only messages
have not yet been replayed into native Session events; pre-existing Main Bot
agent-session parts need explicit history-preserving adoption; Bot Social groups
need native group/remote-human participant mapping; reverse creation from the
native UI needs explicit workspace assignment. Group membership/history remains
canonical in Bot Social, and compatibility tables retain all legacy history.
