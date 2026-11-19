# Skills library page

Related: [#231](https://github.com/openTeamily/openTeamily/issues/231), [#10](https://github.com/openTeamily/openTeamily/issues/10), [#1](https://github.com/openTeamily/openTeamily/issues/1), [#263](https://github.com/openTeamily/openTeamily/issues/263).

This is the `/skills` slice: a visible, searchable skills catalogue whose
install/uninstall choice is stored per account. It is **not** a skill runtime,
marketplace, credential surface or MCP implementation: installing a skill records
the choice and nothing else. The catalogue is OpenTeamily-authored; it does not
copy Teamily skill names, prose or counts.

## Page

`/skills` serves the shared app shell and shows:

- the `技能库` heading and a search field labelled `搜索技能`;
- ten skill cards, each with an icon slot, name, one-line description and an
  `安装` / `已安装` button;
- `共 N 个技能` or `显示 N / M 个技能` feedback;
- `没有匹配的技能` when the search has no hits;
- a server-supplied reason above the grid when a request fails.

Search filters by name and description in the loaded page. On load the page asks
`GET /v1/skills/installed` for the signed-in account and marks those cards; an
install posts the skill id, an uninstall deletes it, and the card only changes
after the server answers. A refresh, a new session or another device signed into
the same account therefore shows the same installed set. A refusal (signed out,
bad id, CSRF, storage error) is printed in the page and the card stays as it was.

Every shell page that already has the app rail links `技能` to `/skills`.

## Assets and routes

| Path | Content |
|---|---|
| `/skills` | HTML page (`Cache-Control: no-store`, strict CSP) |
| `/skills/app.mjs` | self-written `SKILLS` catalogue, `filterSkills`, `mountSkills`, `readInstalled`, `writeInstalled` |
| `/skills/app.css` | card grid, search pill, installed state, error line, narrow layout |
| `GET /v1/skills/installed` | `{"installed": ["<skill id>", …]}` for the session account |
| `POST /v1/skills/installed` | body `{"skill": "<id>"}`, answers the new list |
| `DELETE /v1/skills/installed` | body `{"skill": "<id>"}`, answers the new list |

The three API routes require a signed-in session and are scoped to its user id;
`POST` and `DELETE` also require the same-origin CSRF token. `DELETE` is admitted
for this one path only — every other path keeps the server's GET/POST-only policy
and still answers `405`. Unknown skill ids answer `400` with a reason. Rows live in
the `skill_installs(user_id, skill_id, installed)` table created by
`openteamily/skill_installs.py` and added to the `Store` schema; deleting the
account row cascades. The server allowlist is the same ten ids as the page
catalogue, and a test fails if the two drift apart.

Unknown `/skills/...` paths return `404`; queries, cross-origin requests and
non-GET methods on the page assets are rejected like the other management pages.

## Explicitly not in this slice

- Real skill execution, permissions, secrets or provider calls; installing only
  records the choice.
- A skills marketplace, ratings, reviews, or a remote catalogue.
- MCP/provider OAuth.
- Teamily skill names, prose, counts or visual comparison acceptance.

## Screenshot

`docs/screenshots/skills/` holds synthetic captures. They are review material, not
browser E2E or Teamily comparison.

## Tests

`tests/test_skills_page.py` checks the served markup, strict headers, rejection
paths, the catalogue parity between page and server, and the install API round
trip, per-account scoping, signed-out rejection, CSRF/origin checks and the
narrow `DELETE` exemption. `tests/skills_page.test.mjs` checks the catalogue
bounds, search, the request helpers (method, body, CSRF header, server-reason
errors) and the mounted page's load/install/uninstall/failure behaviour. These are
in-process/unit tests, not browser E2E or Teamily comparison.
