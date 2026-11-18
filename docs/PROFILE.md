# Account profile and public Teamily ID

Related: [#130](https://github.com/openTeamily/openTeamily/issues/130), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#4](https://github.com/openTeamily/openTeamily/issues/4).

The 2026-11-18 real-account contrast (#130) and the app's localized profile editor define:
name, Teamily ID (handle), bio, tags, gender, location, website, private life goals, avatar,
and account deletion. This slice implements the **text profile fields, private life goals and a
read-only public handle projection**. It deliberately does **not** add posts, follows, likes,
comments or a feed: that social layer is Birfy's Bot Social domain and must not be duplicated here.
Avatar upload and account deletion are separate slices.

## API

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/v1/profile` | session | `{profile}` for the caller, or `{profile:null}`. Never creates. |
| POST | `/v1/profile` | session + Origin + CSRF | `{revision, changes}`. `revision:0` creates; `200` on update, `201` on create, `409` with `error.current` on a stale revision. |
| GET | `/v1/profiles/{handle}` | none | Read-only public projection. Unknown handles are `404`. |

`changes` fields: `handle`, `name`, `bio`, `tags` (list), `gender` (`""|male|female|other`),
`location`, `website`, `goals` (`{health,finance,career,hobbies,family,productivity,other}`).
Unknown keys, wrong types, unsupported values and an empty changes object are rejected with `400`
and nothing is written.

The public projection contains `handle,name,bio,tags,gender,location,website,created`. It never
contains `goals`, `revision`, email, account id or other users' data.

## Handle rules

- 3–30 characters, lowercase `a-z`, `0-9`, `.` and `_`, starting and ending with a letter/digit.
- No consecutive dots and no reserved management/api paths (`admin`, `settings`, `chat`, `team`,
  `discover`, `memory`, `space`, `v1`, …).
- Unique case-insensitively; an unavailable handle returns `409`.
- On first save without a handle, a default is derived from the username (invalid characters
  become dots, dots collapse and trim, short names are padded). A numeric suffix resolves collisions.

## Bounds

- `name` 1–40; `bio` ≤200; `location` ≤80; `website` ≤200 and `http`/`https` with a host and no
  userinfo; `tags` ≤8 with ≤20 characters each, unique case-insensitively; each goal ≤200.
- Profile revision starts at 1 and increases on change; an unchanged update returns `200` without
  bumping it.

## Storage

Additive `user_profiles` table (`CREATE TABLE IF NOT EXISTS`) keyed by `user_id` with a unique
`handle_lower` index. Tags and goals are JSON text. Schema `user_version` stays 1.

## Page

`/profile` is a same-origin editor with a public-information card and a private life-goals card.
It keeps the existing shell/nav/account IDs, shows the signed-in username, and links to the public
JSON projection. `docs/screenshots/profile/profile-editor.png` is synthetic review material; it is not
browser acceptance.

## Explicitly not in this slice

- Posts, follows, followers, likes, comments, feeds or remix (Birfy/Bot Social overlap).
- Avatar/photo upload, account deletion, email change, and Teamily ID cooldown.
- A rendered public profile page; only the JSON projection exists.
- Teamily comparison acceptance. Tests are in-process WSGI + temporary SQLite plus pure Node helpers.
