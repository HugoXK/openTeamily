import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

type Home = Awaited<ReturnType<typeof home>>;
const ROOT = "/v1/ot";
const SOURCE = "a".repeat(32);
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => { server = await startServer(bulkAuth); });
after(async () => { await server.stop(); });

async function member(name: string) {
  const client = await home(server.base, name);
  const profile = await client.ok("GET", ROOT + "/me");
  return { ...client, id: profile.owner_id as string, name: profile.display_name as string };
}

async function contacts(a: Home, b: Home) {
  const request = await a.ok("POST", ROOT + "/contacts", { handle: b.handle });
  await b.ok("POST", ROOT + "/contacts/" + request.id, { action: "accept" });
  return request.id;
}

function sharing(conversationId: string, ...recipientIds: string[]) {
  return {
    conversation_id: conversationId, recipient_ids: recipientIds, source_id: SOURCE,
    revision: 1, title: "Launch notes", started_at: 1719879200, summary: "The launch is ready.\nNext step follows.",
    action_items: [{ text: "Confirm launch", owner: "On-call", done: true }, { text: "Check tickets", owner: "", done: false }],
    client_key: "meeting-share-example-001",
  };
}

function recipients(scope: string, conversationId: string) {
  return scope + "/meeting-share-recipients?conversation_id=" + conversationId;
}

async function team(owner: Home, key: string, ...members: Home[]) {
  const row = await owner.ok("POST", ROOT + "/workspaces", { idempotency_key: key, name: "Review team" });
  for (const teammate of members) {
    const { code } = await owner.ok("POST", ROOT + "/teams/" + row.id + "/invites", {});
    await teammate.ok("POST", ROOT + "/invites/accept", { code });
  }
  return row;
}

test("personal receipts save distinct immutable versions, page privately and revoke by author", async () => {
  const [author, reader, unselected, outsider] = await Promise.all([
    member("note-author"), member("note-reader"), member("note-unselected"), member("note-outsider"),
  ]);
  await contacts(author, reader);
  await contacts(author, unselected);
  const group = await author.ok("POST", ROOT + "/conversations", { kind: "group", account_group: true,
    title: "Launch team", members: [reader.handle, unselected.handle] });
  const selector = recipients(ROOT, group.id);
  const shares = ROOT + "/meeting-shares";
  assert.deepEqual((await author.ok("GET", selector)).items, [
    { id: reader.id, name: reader.name }, { id: unselected.id, name: unselected.name },
  ]);
  assert.equal((await outsider.call("GET", selector)).status, 404);
  const payload = sharing(group.id, reader.id);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [reader.id, outsider.id] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [reader.handle] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, recipient_ids: [author.id] })).status, 404);
  assert.equal((await author.call("POST", shares, { ...payload, transcript: "private" })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, live_code: "private" })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, action_items: [{ text: "task", done: "true" }] })).status, 400);
  assert.equal((await author.call("POST", shares, { ...payload, action_items: [{ text: "task", transcript: "private" }] })).status, 400);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });

  const responses = await Promise.all([author.call("POST", shares, payload), author.call("POST", shares, payload)]);
  const original = responses.find(response => response.status === 201);
  const replay = responses.find(response => response.status === 200);
  assert.ok(original);
  assert.deepEqual(replay?.data, { ...original.data, replayed: true });
  const first = original.data.meeting;
  assert.match(first.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(first, {
    id: first.id, title: payload.title, revision: 1, started_at: payload.started_at, created: first.created,
    organizer: author.name, action_count: 2, done_count: 1, shared: true, summary: payload.summary, action_items: payload.action_items,
  });
  assert.ok(Math.abs(first.created - Math.floor(Date.now() / 1000)) <= 5);
  assert.equal((await author.call("POST", shares, { ...payload, summary: "different" })).status, 409);
  const second = (await author.ok("POST", shares, { ...payload, revision: 2, summary: "Updated", client_key: "meeting-share-example-002" })).meeting;
  assert.notEqual(second.id, first.id);
  const outgoing = await author.ok("GET", shares + "?source_id=" + SOURCE);
  assert.deepEqual(outgoing.items.map((row: any) => [row.id, row.recipients]), [
    [second.id, [reader.name]], [first.id, [reader.name]],
  ]);
  const sentPage = await author.ok("GET", shares + "?sent=1&limit=1");
  assert.deepEqual(sentPage, { items: [outgoing.items[0]], cursor: second.id });
  assert.deepEqual(await author.ok("GET", shares + "?sent=1&limit=1&cursor=" + sentPage.cursor),
    { items: [outgoing.items[1]], cursor: null });
  assert.deepEqual(await reader.ok("GET", shares + "?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await outsider.ok("GET", shares + "?sent=1&cursor=" + sentPage.cursor), { items: [], cursor: null });
  assert.equal((await author.call("GET", shares + "?sent=1&source_id=" + SOURCE)).status, 400);
  assert.deepEqual(await author.ok("GET", shares), { items: [], cursor: null });
  assert.deepEqual(await reader.ok("GET", shares + "?source_id=" + SOURCE), { items: [], cursor: null });
  const page = await reader.ok("GET", shares + "?limit=1");
  assert.equal(page.cursor, second.id);
  assert.deepEqual(page.items, [
    { id: second.id, title: payload.title, revision: 2, started_at: payload.started_at, created: second.created,
      organizer: author.name, action_count: 2, done_count: 1, shared: true },
  ]);
  assert.deepEqual((await reader.ok("GET", shares + "/" + first.id)).meeting, first);
  assert.deepEqual(await unselected.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await unselected.call("GET", shares + "/" + first.id)).status, 404);
  assert.equal((await outsider.call("GET", shares + "/" + first.id)).status, 404);
  assert.equal((await reader.call("POST", shares + "/" + second.id + "/revoke", {})).status, 404);
  const anonymous = await fetch(server.base + shares + "/" + first.id);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await author.ok("POST", shares + "/" + second.id + "/revoke", {}), { revoked: true });
  assert.deepEqual(await author.ok("POST", shares + "/" + second.id + "/revoke", {}), { revoked: true });
  assert.equal((await reader.call("GET", shares + "/" + second.id)).status, 404);
  const afterRevokedCursor = await reader.ok("GET", shares + "?limit=1&cursor=" + page.cursor);
  assert.deepEqual(afterRevokedCursor.items.map((row: any) => row.id), [first.id]);
  assert.equal(afterRevokedCursor.cursor, null);
  await author.ok("DELETE", ROOT + "/conversations/" + group.id + "/members/" + reader.handle);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await reader.call("GET", shares + "/" + first.id)).status, 404);
  assert.deepEqual(await author.ok("GET", shares + "?sent=1"), { items: [outgoing.items[1]], cursor: null });
  assert.deepEqual(await author.ok("POST", shares + "/" + first.id + "/revoke", {}), { revoked: true });
  assert.deepEqual(await author.ok("GET", shares + "?sent=1"), { items: [], cursor: null });
  const messages = server.platform.db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM ot_messages WHERE conversation_id=?").get(group.id);
  assert.equal(messages?.n, 0);
});

test("team scope follows the exact workspace, active team and conversation seats", async () => {
  const [admin, author, reader, unselected] = await Promise.all([
    member("notes-admin"), member("notes-sender"), member("notes-viewer"), member("notes-other"),
  ]);
  const first = await team(admin, "meetings-test-first-team", author, reader, unselected);
  const second = await team(admin, "meetings-test-second-team", author, reader);
  const scope = ROOT + "/workspaces/" + first.workspace_id;
  const wrong = ROOT + "/workspaces/" + second.workspace_id;
  const group = await admin.ok("POST", ROOT + "/conversations", { kind: "group", team_id: first.id,
    title: "Shared notes", members: [author.handle, reader.handle, unselected.handle] });
  const shares = scope + "/meeting-shares";
  const payload = sharing(group.id, reader.id);
  assert.ok((await author.ok("GET", recipients(scope, group.id))).items.some((row: { id: string }) => row.id === reader.id));
  assert.equal((await author.call("GET", recipients(wrong, group.id))).status, 404);
  assert.equal((await author.call("POST", ROOT + "/meeting-shares", payload)).status, 404);
  assert.equal((await author.call("POST", wrong + "/meeting-shares", payload)).status, 404);
  const share = (await author.ok("POST", shares, payload)).meeting;
  assert.equal((await reader.ok("GET", shares + "/" + share.id)).meeting.id, share.id);
  assert.deepEqual((await author.ok("GET", shares + "?sent=1")).items.map((row: {id: string}) => row.id), [share.id]);
  assert.deepEqual(await author.ok("GET", wrong + "/meeting-shares?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await author.ok("GET", ROOT + "/meeting-shares?sent=1"), { items: [], cursor: null });
  assert.deepEqual(await reader.ok("GET", wrong + "/meeting-shares"), { items: [], cursor: null });
  assert.equal((await reader.call("GET", wrong + "/meeting-shares/" + share.id)).status, 404);
  assert.equal((await reader.call("GET", ROOT + "/meeting-shares/" + share.id)).status, 404);
  assert.equal((await author.call("POST", wrong + "/meeting-shares/" + share.id + "/revoke", {})).status, 404);
  const members = ROOT + "/teams/" + first.id + "/members/";
  await admin.ok("PATCH", members + reader.handle, { suspended: true });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
  assert.ok((await author.ok("GET", recipients(scope, group.id))).items.every((row: { id: string }) => row.id !== reader.id));
  await admin.ok("PATCH", members + reader.handle, { suspended: false });
  assert.equal((await reader.ok("GET", shares + "/" + share.id)).meeting.id, share.id);
  await admin.ok("PATCH", members + author.handle, { suspended: true });
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
  assert.deepEqual(await author.ok("POST", shares + "/" + share.id + "/revoke", {}), { revoked: true });
  await admin.ok("PATCH", members + author.handle, { suspended: false });
  assert.equal((await reader.call("GET", shares + "/" + share.id)).status, 404);
});

test("ordinary direct shares require current reach and public agent threads cannot receive snapshots", async () => {
  const [author, reader] = await Promise.all([member("direct-note-writer"), member("direct-note-reader")]);
  const contact = await contacts(author, reader);
  const dm = await author.ok("POST", ROOT + "/conversations", { kind: "dm", peer: reader.handle });
  const shares = ROOT + "/meeting-shares";
  assert.deepEqual(await author.ok("GET", recipients(ROOT, dm.id)), { items: [{ id: reader.id, name: reader.name }] });
  const receipt = (await author.ok("POST", shares, sharing(dm.id, reader.id))).meeting;
  assert.equal((await reader.ok("GET", shares)).items[0].id, receipt.id);
  await author.ok("POST", ROOT + "/contacts/" + contact, { action: "remove" });
  assert.equal((await author.call("GET", recipients(ROOT, dm.id))).status, 403);
  assert.equal((await reader.call("GET", shares + "/" + receipt.id)).status, 404);
  assert.deepEqual(await reader.ok("GET", shares), { items: [], cursor: null });

  const workspace = await team(author, "meetings-dm-team", reader);
  const scope = ROOT + "/workspaces/" + workspace.workspace_id;
  const scopedShares = scope + "/meeting-shares";
  const scopedPayload = { ...sharing(dm.id, reader.id), client_key: "meeting-share-scoped-dm" };
  assert.equal((await reader.ok("GET", shares)).items[0].id, receipt.id);
  assert.deepEqual(await author.ok("GET", recipients(scope, dm.id)), { items: [{ id: reader.id, name: reader.name }] });
  const scopedReceipt = (await author.ok("POST", scopedShares, scopedPayload)).meeting;
  assert.equal((await reader.ok("GET", scopedShares)).items[0].id, scopedReceipt.id);
  assert.equal((await reader.call("GET", scopedShares + "/" + receipt.id)).status, 404);
  assert.equal((await reader.call("GET", shares + "/" + scopedReceipt.id)).status, 404);
  await author.ok("DELETE", ROOT + "/teams/" + workspace.id + "/members/" + reader.handle);
  assert.equal((await reader.call("GET", scopedShares + "/" + scopedReceipt.id)).status, 404);
  assert.equal((await author.call("POST", scopedShares, { ...scopedPayload, client_key: "meeting-scoped-dm-removed" })).status, 404);
  assert.equal((await reader.call("GET", shares + "/" + receipt.id)).status, 404);

  const slug = "meeting-share-no-public";
  await author.ok("PUT", ROOT + "/listings", { kind: "agent", ref: "notes_pub", slug, title: "Public agent",
    snapshot: JSON.stringify({ version: 1, instructions: "Help with public notes" }), chat_enabled: true });
  const thread = await reader.ok("POST", ROOT + "/discover/" + slug + "/start");
  assert.equal((await reader.call("GET", recipients(ROOT, thread.conversation_id))).status, 404);
  assert.equal((await reader.call("POST", shares, sharing(thread.conversation_id, author.id))).status, 404);
});
