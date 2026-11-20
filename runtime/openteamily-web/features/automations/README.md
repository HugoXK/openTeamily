# `features/automations` (B2)
Automations and their scheduler run inside this DS-Bot: definitions, editor state and
runs in `features/automations/automations.sqlite3`; the clock ticks here (same slot
rules as `openteamily/automations.py`) once the DS-Bot runtime is attached; each run is
one native DS-Bot turn via `chatTurn('automation:<id>', …)`. Endpoints:
`automations/{templates,list,get,create,update,remove,runs,run,cancel,retry,tick,import}`;
`migrate(bundle)` imports legacy rows and marks the current slot as already run.
