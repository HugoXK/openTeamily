# UI screenshots (synthetic fixtures)

Playwright captures of the OpenTeamily management UI on a throwaway loopback app
with **synthetic fixture data**. They are review material for the Studio slide and dashboard
slices, not browser E2E acceptance, not a real vendor/container run, and not a
Teamily comparison.

- `studio-library.png`: `/space` works library with a slide deck in the list.
- `studio-slides-editor.png`: the slide editor with one card per page
  (title + newline-per-bullet body), version and share panels.
- `studio-slides-preview.png`: the sandboxed HTML deck preview.
- `studio-dashboard-library.png`: `/space` with a dashboard in the list.
- `studio-dashboard-editor.png`: the dashboard editor with metric/table/bar widgets.
- `studio-dashboard-preview.png`: the sandboxed HTML dashboard preview.

Do not reuse as marketing material. The capture script and data directory are
local-only and not committed.
