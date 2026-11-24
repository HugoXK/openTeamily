// The ranked works feed carries the three ranking semantics the Discover page depends on (#8):
// an already opened work is demoted without leaving the feed, one author cannot fill the first page,
// and explain reports the components that produced each position. Fixture homes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

type Page = { items: { slug: string; explain?: any }[] };
const slugs = (page: Page) => page.items.map(item => item.slug);

test("an opened work ranks below an equally scored unseen work and stays in the paged feed", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "ranking-seen-author");
  const reader = await home(server.base, "ranking-seen-reader");
  const publish = async (slug: string) => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {
      kind: "work", work_kind: "document", ref: slug, slug, title: `Seen fixture ${slug}`, snapshot: "Seen fixture body",
    });
  };
  await publish("rank-seen-older");
  const newer = await publish("rank-seen-newer");
  const feed = "/v1/ot/discover?kind=work&sort=popular&q=" + encodeURIComponent("seen fixture");
  assert.deepEqual(slugs(await reader.ok("GET", feed)), ["rank-seen-newer", "rank-seen-older"], "the fresher work starts first");

  await reader.ok("GET", `/v1/ot/discover/${newer.slug}/detail`);
  const ranked = await reader.ok("GET", feed);
  assert.deepEqual(slugs(ranked), ["rank-seen-older", "rank-seen-newer"],
    "the opened work is demoted below the equally scored unseen one");

  const first = await reader.ok("GET", feed + "&limit=1");
  assert.deepEqual(slugs(first), ["rank-seen-older"]);
  const second = await reader.ok("GET", feed + "&limit=1&cursor=" + encodeURIComponent(first.next_cursor));
  assert.deepEqual(slugs(second), ["rank-seen-newer"], "the demoted work is still reachable in the paged result");
});

test("one author cannot fill the first page of the ranked feed", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const reader = await home(server.base, "ranking-div-reader");
  const publish = async (owner: Awaited<ReturnType<typeof home>>, slug: string) => {
    now += 1_000;
    return owner.ok("PUT", "/v1/ot/listings", {
      kind: "work", work_kind: "document", ref: slug, slug, title: `Diversity fixture ${slug}`,
      snapshot: "Diversity fixture body",
    });
  };
  for (const name of ["1", "2", "3"]) await publish(await home(server.base, "ranking-div-other-" + name), "rank-div-other-" + name);
  const prolific = await home(server.base, "ranking-div-prolific");
  for (const name of ["a1", "a2", "a3", "a4", "a5"]) await publish(prolific, "rank-div-" + name);

  const page = await reader.ok("GET", "/v1/ot/discover?kind=work&sort=popular&q=" +
    encodeURIComponent("diversity fixture") + "&limit=6");
  const byOneAuthor = page.items.filter((item: {slug: string}) => item.slug.startsWith("rank-div-a")).length;
  assert.equal(byOneAuthor, 3, "at most three works by one author reach the first page");
  assert.equal(page.items.length, 6);
  assert.equal(page.items.filter((item: {slug: string}) => item.slug.startsWith("rank-div-other-")).length, 3,
    "the rest of the first page is filled by the next best works by other authors");
});

test("explain reports the components behind each ranked position", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "ranking-explain-author");
  const reader = await home(server.base, "ranking-explain-reader");
  const publish = async (slug: string) => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {
      kind: "work", work_kind: "document", ref: slug, slug, title: `Explain fixture ${slug}`, snapshot: "Explain fixture body",
    });
  };
  const quiet = await publish("rank-explain-quiet");
  await publish("rank-explain-busy");
  await reader.ok("POST", `/v1/ot/listings/${quiet.id}/like`, {});
  await reader.ok("GET", "/v1/ot/discover/rank-explain-busy/detail");
  const feed = "/v1/ot/discover?kind=work&sort=popular&q=" + encodeURIComponent("explain fixture");

  const plain = await reader.ok("GET", feed);
  assert.ok(plain.items.every((item: any) => item.explain === undefined), "explain stays absent when it is not requested");

  const explained = await reader.ok("GET", feed + "&explain=1");
  assert.deepEqual(slugs(explained), slugs(plain));
  for (const [index, item] of explained.items.entries()) {
    const view = item.explain;
    assert.ok(view, "every ranked item carries its components when explain=1");
    assert.equal(view.rank, index + 1);
    assert.equal(view.engagement, view.weights.like * view.likes + view.weights.collection * view.collections);
    assert.equal(view.recency, view.age_weeks === 0 ? 0 : -view.age_weeks);
    assert.equal(view.seen_penalty, view.seen * view.weights.seen);
    assert.equal(view.score, view.engagement + view.recency - view.seen_penalty + view.follow_boost);
  }
  const demoted = explained.items.find((item: any) => item.slug === "rank-explain-busy").explain;
  assert.equal(demoted.seen, 1, "the opened work reports the seen flag");
  const ranked = explained.items.find((item: any) => item.slug === "rank-explain-quiet").explain;
  assert.equal(ranked.engagement, 2, "one like is worth two engagement points");
  assert.equal((await reader.call("GET", feed + "&explain=2")).status, 400);
});
