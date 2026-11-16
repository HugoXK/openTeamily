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
| `appearance` | `system`, `light`, `dark`, `auto` | `system` |
| `appearance_schedule` | `sunset_sunrise`, `custom` | `sunset_sunrise` |
| `appearance_start` / `appearance_end` | `HH:MM` 24-hour | `18:00` / `07:00` |
| `language` | 18 recaptured system languages, mapped to BCP-47 (see below) | `zh-CN` |
| `chat_language` | `auto` or the 17 recaptured chat languages | `auto` |
| `auto_translate` | boolean | `false` |
| `send_shortcut` | `enter`, `mod_enter` | `enter` |
| `message_folding` | `compact`, `standard`, `none` | `standard` |
| `document_cards` | boolean | `false` |
| `link_previews` | boolean | `true` |
| `task_completion_reminders` | boolean | `true` |
| `likes_visible` / `favorites_visible` | boolean | `true` |

Option semantics follow the 2026-11-16 round-1 and round-2 Teamily contrasts. System languages (18) and chat languages (17) use our BCP-47 mappings because Teamily does not expose codes: system `en,fa,fr,de,es,it,pt-BR,ru,id,ms,hi,bn,th,ja,ko,zh-HK,zh-TW,zh-CN`; chat adds `auto` plus `en,fa,fr,de,es,pt,it,ru,id,vi,bn,th,ar,ja,ko,zh-Hant,zh-CN`. Privacy is two default-on checkboxes (allow others to see likes / favorites). The retired `likes_visibility`/`favorites_visibility` values `everyone`/`private` are accepted on write and migrated on read. Custom appearance period fields were **not captured**; `appearance_start`/`appearance_end` as `HH:MM` remain unverified. This is still not settings parity.

## Storage

An additive `user_settings` table (`CREATE TABLE IF NOT EXISTS`) in the existing private management database. Schema `user_version` stays 1; existing v1 databases gain the table on next start. Stored documents are re-validated on read: unknown or invalid stored keys fall back to defaults rather than being returned.

## Settings page (slice 2)

The same-origin page at `/settings` reads and writes `/v1/settings` and lists write-only skill secrets at `/v1/skill-secrets` (name `A-Z` then `A-Z0-9_`, value stored wrapped, never returned). Custom appearance times were not fully captured in the first contrast pass; start/end use `HH:MM`.

The page also has a model API section for an optional personal override. The platform default is shown as the effective configuration when no override is set. Keys are write-only. See [MODEL_API.md](MODEL_API.md). This is not Teamily credits or billing.

The page is not browser E2E evidence. Acceptance against Teamily's real settings pages remains [#14](https://github.com/openTeamily/openTeamily/issues/14).

## Not in this slice

No chat shell, no keyboard handling in the chat input, no translation catalogue, no runtime/instance propagation. Browser acceptance is not claimed.
