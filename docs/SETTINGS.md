# Account settings API (issue #4, slice 1)

Related: [#4](https://github.com/openTeamily/openTeamily/issues/4) (settings, chat shell and message tools — **not completed**), [#14](https://github.com/openTeamily/openTeamily/issues/14) (browser acceptance), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This slice adds server-side persistence for per-account interface preferences in the management API. It is self-written; no FlyBot, Bot Social, DS-Bot or Teamily source was used.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/settings` | Current account only. Returns `{settings:{values,revision}}`; `revision` 0 means nothing stored yet and `values` are defaults |
| POST | `/v1/settings` | `{revision, changes}`; session + exact Origin + CSRF required. Partial update of known keys. Stale `revision` → `409 conflict` with `error.current` (no write). Unchanged values → 200 without bumping `revision` |

Unknown keys, wrong types, unsupported values or an empty `changes` object are refused with 400 and nothing is written. There is no cross-account read or write path; the owner is always the session user.

## Keys (OpenTeamily defaults — not yet Teamily-verified)

| Key | Allowed | Default |
|---|---|---|
| `appearance` | `system`, `light`, `dark` | `system` |
| `language` | `zh-CN`, `en` | `zh-CN` |
| `send_shortcut` | `enter`, `mod_enter` | `enter` |
| `fold_long_messages` | boolean | `true` |
| `document_cards` | boolean | `true` |

The capability areas (appearance, language basics, shortcuts, message folding and document cards) come from the #4 scope. The **specific option values and defaults are OpenTeamily assumptions**; they have not been compared with Teamily's real settings page, role, operation and result. Until that comparison is recorded (#14), this slice must not be described as settings parity. Additional Teamily options found during comparison are added as new keys, not invented ahead of time.

## Storage

An additive `user_settings` table (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the table on next start. Stored documents are re-validated on read: unknown or invalid stored keys fall back to defaults rather than being returned.

## Not in this slice

No web UI yet (no clickable shell is shipped), no keyboard handling, no translation catalogue, no runtime/instance propagation. Browser acceptance is not claimed.
