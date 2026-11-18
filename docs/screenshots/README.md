# UI screenshots (synthetic fixtures)

Playwright captures of the OpenTeamily management UI on a throwaway loopback app
with **synthetic fixture data** and a labeled fake model provider. They are
review material for the agent-reply slice, not browser E2E acceptance, not a real
vendor/container run, and not a Teamily comparison.

- `chat-agent-replies.png`: unified `/chat` inbox with a social group, a
  「让智能体回复」 mention tray, and agent replies from 旅行规划 / 财务助手.
- `chat-group-agents.png`: the 新建群组 dialog showing people and AI agents in
  the member picker.
- `discover-catalog.png`: `/discover?tab=agents` with the public catalog and the
  per-workspace publish/revoke controls.

Do not reuse as marketing material. The capture script and data directory are
local-only and not committed.
