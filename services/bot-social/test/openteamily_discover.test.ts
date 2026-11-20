// OpenTeamily Discover on Bot Social: publish/unpublish, search and tabs, likes, collections, follows
// and follow notifications. Fixture homes only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("publish, discover, like, collect, follow and notify followers", async () => {
  const A = await home(S.base, "creator");
  const B = await home(S.base, "fan");
  const tag = `${Date.now() % 100000}`;
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle });
  assert.ok((await A.ok("GET", "/v1/ot/notifications")).notifications.some((n: any) => n.kind === "follow.new" && n.data.follower.handle === B.handle));
  assert.equal((await A.call("POST", "/v1/ot/follows", { handle: A.handle })).status, 400);

  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_writer", slug: `writer-${tag}`, title: "Writer", summary: "drafts posts", category: "content-creation" });
  assert.equal(agent.path, `/a/writer-${tag}`);
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "art_1", slug: `deck-${tag}`, title: "Quarterly deck", work_kind: "slides", snapshot: "# Q3\n- growth" });
  assert.equal(work.snapshot, "# Q3\n- growth");
  assert.equal((await B.call("PUT", "/v1/ot/listings", { kind: "work", ref: "x", slug: `deck-${tag}`, title: "steal" })).status, 409);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: "settings", title: "bad" })).status, 400);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: `ok-${tag}`, title: "bad", category: "nope" })).status, 400);
  const published = (await B.ok("GET", "/v1/ot/notifications")).notifications.filter((n: any) => n.kind === "discover.published");
  assert.equal(published.length, 2);

  const all = await B.ok("GET", `/v1/ot/discover?q=quarterly`);
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].following, true);
  assert.equal(all.items[0].snapshot, undefined, "list never carries snapshots");
  assert.equal((await B.ok("GET", `/v1/ot/discover?kind=agent&creator=${A.handle}`)).items.length, 1);
  assert.equal((await B.ok("GET", `/v1/ot/discover?tab=following&creator=${A.handle}`)).items.length, 2);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, {});
  await B.ok("POST", `/v1/ot/listings/${work.id}/collect`, {});
  const detail = await B.ok("GET", `/v1/ot/discover/deck-${tag}`);
  assert.deepEqual([detail.likes, detail.collections, detail.liked, detail.collected, detail.own], [1, 1, true, true, false]);
  assert.equal(detail.snapshot, "# Q3\n- growth");
  assert.equal((await B.ok("GET", "/v1/ot/discover?tab=collected")).items.length, 1);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, { on: false });
  assert.equal((await B.ok("GET", `/v1/ot/discover/deck-${tag}`)).likes, 0);

  assert.equal((await B.call("DELETE", `/v1/ot/listings/${work.id}`)).status, 404, "only the creator unlists");
  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await B.call("GET", `/v1/ot/discover/deck-${tag}`)).status, 404);
  assert.equal((await A.ok("GET", `/v1/ot/discover/deck-${tag}`)).listed, false, "the creator still sees it");
  assert.equal((await A.ok("GET", "/v1/ot/listings/mine")).listings.length, 2);
  const f = await A.ok("GET", "/v1/ot/follows");
  assert.deepEqual(f.followers.map((p: any) => p.handle), [B.handle]);
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle, on: false });
  assert.equal((await A.ok("GET", "/v1/ot/follows")).followers.length, 0);
});

test("public listing pages need no token and hide unlisted works", async () => {
  const { publicPrefix } = await import("../src/openteamily/discover.ts");
  assert.equal(publicPrefix("https://openteamily.botawaken.com/social"), "/social");
  assert.equal(publicPrefix("https://openteamily.botawaken.com/social/"), "/social");
  assert.equal(publicPrefix("https://openteamily.botawaken.com"), "");

  const A = await home(S.base, "public-creator");
  const tag = `${Date.now() % 100000}`;
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "pub_1", slug: `essay-${tag}`, title: "Public essay", work_kind: "document", snapshot: "hello <script> world" });
  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_pub", slug: `guide-${tag}`, title: "Guide bot", snapshot: JSON.stringify({ name: "Guide bot", quick_starts: ["介绍一下你"] }) });
  assert.equal(work.path, `/w/essay-${tag}`);
  assert.equal(agent.path, `/a/guide-${tag}`);

  const anon = await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`);
  assert.equal(anon.status, 200);
  const body = await anon.json() as any;
  assert.equal(body.title, "Public essay");
  assert.equal(body.liked, false);
  assert.equal(body.own, false);
  assert.equal(body.snapshot, "hello <script> world");

  const html = await fetch(`${S.base}/w/essay-${tag}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /text\/html/);
  const page = await html.text();
  assert.match(page, /Public essay/);
  assert.equal(page.includes("<script>"), false, "snapshot is escaped");
  assert.match(page, /hello &lt;script&gt; world/);

  const preview = await fetch(`${S.base}/w/essay-${tag}/preview`);
  assert.equal((await preview.json() as any).preview, "hello <script> world");

  const agentPage = await fetch(`${S.base}/a/guide-${tag}`);
  assert.match(await agentPage.text(), /介绍一下你/);

  const asJson = await fetch(`${S.base}/a/guide-${tag}`, { headers: { accept: "application/json" } });
  assert.equal((await asJson.json() as any).kind, "agent");

  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await fetch(`${S.base}/w/essay-${tag}`)).status, 404);
  assert.equal((await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`)).status, 404);
});
