// OpenTeamily Discover on Bot Social: opt-in public catalog of agents and works, likes, collections,
// creator follows and follow notifications. Ported from the legacy discover.py (#87, #313, #335).
// A listing is a whitelisted projection the owner's DS-Bot chose to publish (title, summary,
// category, kind and an optional bounded public snapshot); never instructions, memory or tokens.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, intParam, one, OtContext, optText, params, query, text } from "./core.js";

export const DISCOVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_listings (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('agent','work')), ref TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', category TEXT, work_kind TEXT,
  snapshot TEXT, listed INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS ot_listings_feed ON ot_listings(listed, updated_at);
CREATE TABLE IF NOT EXISTS ot_likes (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_collections (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_follows (follower_id TEXT NOT NULL, creator_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, creator_id), CHECK (follower_id <> creator_id));
CREATE INDEX IF NOT EXISTS ot_follows_creator ON ot_follows(creator_id);
`;

export const CATEGORIES = ["content-creation", "customer-support", "data-analysis", "design", "education", "engineering", "finance", "it-security", "investment", "legal", "life", "marketing", "operations", "product", "recruiting", "research", "sales"];
export const WORK_KINDS = ["document", "website", "whiteboard", "media", "image", "audio", "video", "slides", "dashboard"];
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(["settings", "team", "members", "v1", "discover", "agents", "chat", "messenger", "space", "artifacts", "memory", "automations", "runtimes", "profile", "download", "install", "shell", "share", "a", "d", "api", "login", "logout", "search", "w", "works", "feed"]);
const REF = /^[A-Za-z0-9._:-]{1,80}$/;
const SNAPSHOT_MAX = 200_000;

function engagement(ot: OtContext, l: any, viewer: string) {
  const has = (table: string) => !!ot.get(`SELECT 1 FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, viewer);
  return {
    likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n,
    collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n,
    liked: has("ot_likes"), collected: has("ot_collections"),
    following: !!ot.get("SELECT 1 FROM ot_follows WHERE follower_id = ? AND creator_id = ?", viewer, l.owner_id),
    own: l.owner_id === viewer,
  };
}

/** Path prefix of PUBLIC_BASE_URL (e.g. `/social`) so cards on the site origin hit this Bot Social. */
export function publicPrefix(base: string) {
  try {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    return path && path !== "/" ? path : "";
  } catch {
    return "";
  }
}

function listingPath(ot: OtContext, l: { kind: string; slug: string }) {
  const prefix = publicPrefix(ot.platform.publicBaseUrl);
  return `${prefix}${l.kind === "agent" ? "/a/" : "/w/"}${l.slug}`;
}

const listingView = (ot: OtContext, l: any, viewer: string | null, withSnapshot = false) => ({
  id: l.id, slug: l.slug, kind: l.kind, title: l.title, summary: l.summary, category: l.category, work_kind: l.work_kind,
  creator: ot.profileView(l.owner_id), listed: !!l.listed, updated_at: l.updated_at, created_at: l.created_at,
  path: listingPath(ot, l), ...(viewer ? engagement(ot, l, viewer) : { likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n, collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n, liked: false, collected: false, following: false, own: false }),
  ...(withSnapshot ? { snapshot: l.snapshot ?? null } : {}),
});

function escapeHtml(value: string) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function publicPage(l: any, view: any) {
  const creator = view.creator?.display_name || view.creator?.handle || "";
  const starts = (() => {
    if (l.kind !== "agent" || !l.snapshot) return [];
    try {
      const parsed = JSON.parse(l.snapshot);
      return Array.isArray(parsed?.quick_starts) ? parsed.quick_starts.map((t: unknown) => String(t).slice(0, 80)) : [];
    } catch { return []; }
  })();
  const body = l.kind === "work" && l.snapshot && !String(l.snapshot).startsWith("{")
    ? `<pre>${escapeHtml(String(l.snapshot).slice(0, 20_000))}</pre>`
    : (view.summary ? `<p>${escapeHtml(view.summary)}</p>` : "");
  const startList = starts.length ? `<ul>${starts.map((s: string) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';">
<title>${escapeHtml(view.title || view.slug)} · OpenTeamily</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
.meta{color:#555;font-size:.9rem}
pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:8px}
</style>
</head><body>
<p class="meta">${l.kind === "agent" ? "代理人" : "作品"}${creator ? " · " + escapeHtml(creator) : ""}</p>
<h1>${escapeHtml(view.title || view.slug)}</h1>
${body}
${startList}
</body></html>
`;
}

function listedBySlug(ot: OtContext, slug: string) {
  assert(SLUG.test(slug), 404, "listing_not_found", "no such listing");
  const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ? AND listed = 1", slug);
  assert(l, 404, "listing_not_found", "no such listing");
  return l;
}

export function registerDiscover(app: FastifyInstance, ot: OtContext) {
  app.put("/v1/ot/listings", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    assert(b.kind === "agent" || b.kind === "work", 400, "invalid_request", "kind must be agent or work");
    assert(typeof b.ref === "string" && REF.test(b.ref), 400, "invalid_request", "ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const summary = optText(b.summary, "summary", { max: 500, multiline: true }) ?? "";
    const category = b.category == null || b.category === "" ? null : String(b.category);
    assert(category === null || CATEGORIES.includes(category), 400, "invalid_request", "unknown category");
    const workKind = b.kind === "work" ? String(b.work_kind ?? "document") : null;
    assert(workKind === null || WORK_KINDS.includes(workKind), 400, "invalid_request", "unknown work kind");
    const snapshot = b.snapshot == null ? null : text(b.snapshot, "snapshot", { max: SNAPSHOT_MAX, multiline: true });
    const existing = ot.get<any>("SELECT * FROM ot_listings WHERE owner_id = ? AND kind = ? AND ref = ?", me.ownerId, b.kind, b.ref);
    const slug = String(b.slug ?? existing?.slug ?? "");
    assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "slug must be 3-30 lowercase letters, digits or dashes");
    const clash = ot.get<any>("SELECT id FROM ot_listings WHERE slug = ?", slug);
    assert(!clash || clash.id === existing?.id, 409, "slug_taken", "that address is taken");
    const now = ot.now();
    const id = existing?.id ?? newId("otl");
    ot.tx(() => {
      if (existing) {
        ot.run("UPDATE ot_listings SET slug = ?, title = ?, summary = ?, category = ?, work_kind = ?, snapshot = ?, listed = 1, updated_at = ? WHERE id = ?", slug, title, summary, category, workKind, snapshot, now, id);
      } else {
        assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_listings WHERE owner_id = ?", me.ownerId).n < 500, 429, "too_many_listings", "listing limit reached");
        ot.run("INSERT INTO ot_listings(id, owner_id, kind, ref, slug, title, summary, category, work_kind, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, me.ownerId, b.kind, b.ref, slug, title, summary, category, workKind, snapshot, now, now);
      }
      if (!existing || !existing.listed) {
        for (const f of ot.all<any>("SELECT follower_id FROM ot_follows WHERE creator_id = ? LIMIT 5000", me.ownerId)) {
          ot.notify(f.follower_id, "discover.published", { listing_id: id, slug, kind: b.kind, title, creator: ot.profileView(me.ownerId) });
        }
      }
    });
    return listingView(ot, ot.get("SELECT * FROM ot_listings WHERE id = ?", id), me.ownerId, true);
  });
  app.delete("/v1/ot/listings/:id", async (req) => {
    const me = ot.me(req);
    const r = ot.run("UPDATE ot_listings SET listed = 0, updated_at = ? WHERE id = ? AND owner_id = ?", ot.now(), params(req).id, me.ownerId);
    assert(r.changes === 1, 404, "listing_not_found", "no such listing of yours");
    return { unlisted: true };
  });
  app.get("/v1/ot/listings/mine", async (req) => {
    const me = ot.me(req);
    return { listings: ot.all<any>("SELECT * FROM ot_listings WHERE owner_id = ? ORDER BY updated_at DESC", me.ownerId).map((l) => listingView(ot, l, me.ownerId)) };
  });
  app.get("/v1/ot/discover", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const kind = one(q.kind, "kind");
    const tab = one(q.tab, "tab") ?? "all";
    const category = one(q.category, "category");
    const workKind = one(q.work_kind, "work_kind");
    const creator = one(q.creator, "creator");
    const search = (one(q.q, "q") ?? "").trim().toLowerCase().slice(0, 60);
    const before = intParam(q.before, "before", 0);
    const limit = intParam(q.limit, "limit", 30, 100);
    const where = ["l.listed = 1"]; const args: unknown[] = [];
    if (kind) { assert(kind === "agent" || kind === "work", 400, "invalid_request", "kind must be agent or work"); where.push("l.kind = ?"); args.push(kind); }
    if (category) { where.push("l.category = ?"); args.push(category); }
    if (workKind) { where.push("l.work_kind = ?"); args.push(workKind); }
    if (creator) { where.push("l.owner_id = ?"); args.push(ot.ownerByHandle(creator)); }
    if (tab === "following") { where.push("EXISTS (SELECT 1 FROM ot_follows f WHERE f.creator_id = l.owner_id AND f.follower_id = ?)"); args.push(me.ownerId); }
    else if (tab === "collected") { where.push("EXISTS (SELECT 1 FROM ot_collections c WHERE c.listing_id = l.id AND c.owner_id = ?)"); args.push(me.ownerId); }
    else assert(tab === "all", 400, "invalid_request", "tab must be all, following or collected");
    if (search) { where.push("(instr(lower(l.title), ?) > 0 OR instr(lower(l.summary), ?) > 0 OR instr(p.handle, ?) > 0 OR instr(lower(p.display_name), ?) > 0)"); args.push(search, search, search, search); }
    if (before) { where.push("l.updated_at < ?"); args.push(before); }
    const rows = ot.all<any>(`SELECT l.* FROM ot_listings l LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id WHERE ${where.join(" AND ")} ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`, ...args, limit);
    return { items: rows.map((l) => listingView(ot, l, me.ownerId)), next_before: rows.length === limit ? rows[rows.length - 1].updated_at : null };
  });
  app.get("/v1/ot/discover/:slug", async (req) => {
    const me = ot.me(req);
    const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ?", params(req).slug);
    assert(l && (l.listed || l.owner_id === me.ownerId), 404, "listing_not_found", "no such listing");
    return listingView(ot, l, me.ownerId, true);
  });
  for (const [path, table] of [["like", "ot_likes"], ["collect", "ot_collections"]] as const) {
    app.post(`/v1/ot/listings/:id/${path}`, async (req) => {
      const me = ot.me(req);
      const l = ot.get<any>("SELECT * FROM ot_listings WHERE id = ? AND listed = 1", params(req).id);
      assert(l, 404, "listing_not_found", "no such listing");
      if (body(req).on === false) ot.run(`DELETE FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, me.ownerId);
      else ot.run(`INSERT OR IGNORE INTO ${table}(listing_id, owner_id, created_at) VALUES (?,?,?)`, l.id, me.ownerId, ot.now());
      return listingView(ot, l, me.ownerId);
    });
  }
  app.post("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    const creator = ot.ownerByHandle(b.handle);
    assert(creator !== me.ownerId, 400, "invalid_request", "you cannot follow yourself");
    if (b.on === false) {
      ot.run("DELETE FROM ot_follows WHERE follower_id = ? AND creator_id = ?", me.ownerId, creator);
      return { following: false };
    }
    const r = ot.run("INSERT OR IGNORE INTO ot_follows(follower_id, creator_id, created_at) VALUES (?,?,?)", me.ownerId, creator, ot.now());
    if (r.changes) ot.notify(creator, "follow.new", { follower: ot.profileView(me.ownerId) });
    return { following: true };
  });
  app.get("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const handle = one(query(req).handle, "handle");
    const who = handle ? ot.ownerByHandle(handleKey(handle)) : me.ownerId;
    return {
      following: ot.all<any>("SELECT creator_id FROM ot_follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.creator_id)),
      followers: ot.all<any>("SELECT follower_id FROM ot_follows WHERE creator_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.follower_id)),
    };
  });

  // Public catalog pages: no connector token. The isolated site exposes them at
  // https://<origin>/social/a/<slug> and /social/w/<slug> through the existing edge prefix.
  app.get("/v1/ot/public/listings/:slug", async (req) => {
    const l = listedBySlug(ot, params(req).slug);
    return listingView(ot, l, null, true);
  });
  const sendPublic = async (req: any, reply: any, kind: "agent" | "work") => {
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === kind, 404, "listing_not_found", "no such listing");
    const view = listingView(ot, l, null, true);
    const accept = String(req.headers.accept || "");
    if (accept.includes("application/json") && !accept.includes("text/html")) return view;
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send(publicPage(l, view));
  };
  app.get("/a/:slug", async (req, reply) => sendPublic(req, reply, "agent"));
  app.get("/w/:slug", async (req, reply) => sendPublic(req, reply, "work"));
  app.get("/w/:slug/preview", async (req) => {
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === "work", 404, "listing_not_found", "no such listing");
    const snapshot = l.snapshot ? String(l.snapshot).slice(0, 2000) : "";
    return { preview: snapshot.startsWith("{") ? (listingView(ot, l, null).summary || "") : snapshot };
  });
}
