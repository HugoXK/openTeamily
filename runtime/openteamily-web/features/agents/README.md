# features/agents (B2)

Workspace agents live in this DS-Bot (`agents.sqlite3`). Each message is a native DS-Bot turn via
`chatTurn('agent:<agent>:<conversation>', …)` with the persona header of `conversations.compose_prompt`.
`agents/turn` is the in-process contract used by the external API and team runs. Public homepages and
discover stay cross-user (phase C, Bot Social).
