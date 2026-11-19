# Screenshots — save a completed task's agent result as a document (issue #266)

- before `af18ab1aa95d40ec0ed460f4c80924ddf68ed282` (live main this branch starts from)
- after `684a8e6618ee92a859ee4ac016eb7570f4032d02` (this branch's tip)

40 PNGs: zh-CN light/dark × 1440×900 / 390×844, states

- before: `01-empty-favorites` (the 保存智能体成果 CTA is a disabled placeholder),
  `02-task-panel` (tapping it cannot open anything; the picture is unchanged),
- after: `01-empty-favorites` (the same CTA is live), `02-task-panel` (the panel
  lists the succeeded tasks that have a text result), `03-saved` (after 保存, the
  document is in the list and the status line says 已保存).

The en set is byte-identical to zh-CN: `/artifacts` has no i18n layer on this
tip, so the language axis is a settings state, not different strings.

Captured with headless Chromium against a loopback
`scripts/ci_ui_screenshots.py --serve` fixture on 2026-11-19. The fixture
already seeds two succeeded runtime tasks with text results, so the panel lists
real rows from `GET /v1/runtime/tasks`; 保存 goes to
`POST /v1/runtime/tasks/{id}/artifact` and the reloaded list shows the stored
document.
