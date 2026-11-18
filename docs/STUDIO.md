# Studio: slide decks in the works library

Related: [#90](https://github.com/openTeamily/openTeamily/issues/90), [#9](https://github.com/openTeamily/openTeamily/issues/9), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This is the first Studio slice: an editable **slide deck** artifact in the works library (`/space`, `/artifacts`). It is self-written for OpenTeamily. It is **not** Teamily Studio parity: there is no dashboard builder, real-time collaboration, rich text, animation, speaker mode, external data source, or slide template catalogue yet. Dashboards are the remaining half of #90.

## Deck format

```json
{"schema": "openteamily.slides.v1", "slides": [
  {"title": "目标", "bullets": ["统一入口", "更快的回复"]},
  {"title": "下一步", "bullets": ["接入运行时"]}
]}
```

- 1–30 slides; each slide has a title (≤120 chars) and 0–10 bullets (≤200 chars each).
- A slide with neither a title nor bullets is rejected.
- The serialized deck is at most 65536 bytes.
- Text is escaped on render; scripted HTML is not accepted.

## API

The routes are the existing artifact routes; slides are a new kind.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/workspaces/{id}/artifacts` | `{title, kind:"slides", slides}` + `Idempotency-Key` → `201` |
| GET | `/v1/workspaces/{id}/artifacts/{id}` | Returns `kind:"slides"` and the `slides` deck |
| POST | `/v1/workspaces/{id}/artifacts/{id}` | `{revision, changes:{title?, slides?}}` |
| GET | `.../preview` | Sandboxed HTML deck |
| GET | `.../export` and `.../versions/{revision}/export` | HTML deck attachment |
| GET | `.../versions` / `.../versions/{revision}` | History; slide snapshots report `kind:"slides"` |
| POST | `.../restore` | Restores a deck as a new revision; identical content does not bump |
| GET/POST | `.../shares` | The existing revocable read-only share renders the deck |

Permissions, title uniqueness, quota and revision conflicts are unchanged: members may read and create; the author, owner or admin may edit; outsiders get `404`.

## Storage

An additive `artifact_slides` side table (`artifact_id`, `deck`) keeps schema `user_version` 1. `artifacts.kind` and `artifact_versions.kind` are unchanged. A slide snapshot is recorded in the existing version table as a `document` whose body is the deck JSON; `version_view` recognises the schema and presents it as `slides`, and restore writes it back to `artifact_slides`.

## UI

The works-library「新建」menu adds「幻灯片」. The editor renders one card per slide with a title field and a newline-per-bullet textarea, plus add/remove controls. The list, filter (`幻灯片`), preview, export, history and share flows reuse the existing artifact UI. `docs/screenshots/` holds synthetic Playwright captures for review; they are not browser E2E acceptance.

## Explicitly not in this slice

- Dashboards, charts, or data-connected widgets.
- Real-time/OT/CRDT collaboration, comments, speaker notes, animation, or present mode.
- Slide templates, import from DOCX/PDF, or a public gallery.
- Teamily page-by-page comparison. Tests are in-process WSGI + temporary SQLite plus pure Node helpers.
