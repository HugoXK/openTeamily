// Cross-user messenger threads on Bot Social: one root per conversation, ordered replies,
// per-user read cursors, soft deletion and workspace/conversation isolation. Fixtures only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let clock = 1_800_000_000_000;
const tick = () => ++clock;

async function teamOf(owner: Awaited<ReturnType<typeof home>>, ...members: Awaited<ReturnType<typeof home>>[]) {
  const team = await owner.ok("POST", "/v1/ot/teams", { name: "Threads team" });
  for (const member of members) {
    const { code } = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await member.ok("POST", "/v1/ot/invites/accept", { code });
  }
  const { workspaces } = await owner.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id as string;
  return { team, workspace };
}

async function room(
  owner: Awaited<ReturnType<typeof home>>,
  members: Awaited<ReturnType<typeof home>>[],
  title: string,
) {
  const { team, workspace } = await teamOf(owner, ...members);
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title, team_id: team.id, members: members.map((member) => member.handle),
  });
  return { team, workspace, group };
}

const threadsPath = (workspace: string, conversationId: string) =>
  `/v1/ot/workspaces/${workspace}/conversations/${conversationId}/threads`;

test("a thread is unique per conversation root and isolated by workspace", async (t) => {
  const service = await startServer({ ...bulkAuth, now: () => clock });
  t.after(service.stop);
  const [alice, bob, carol] = await Promise.all([
    home(service.base, "thread-alice"), home(service.base, "thread-bob"), home(service.base, "thread-carol"),
  ]);
  const { team, workspace, group } = await room(alice, [bob], "Thread roots");
  const base = threadsPath(workspace, group.id);

  tick();
  const created = await alice.ok("POST", base, { root_message_id: "root-launch", title: "Launch notes" });
  assert.match(created.id, /^otmt_/);
  assert.equal(created.workspace_id, workspace);
  assert.equal(created.conversation_id, group.id);
  assert.equal(created.root_message_id, "root-launch");
  assert.equal(created.title, "Launch notes");
  assert.equal(created.resolved, false);
  assert.equal(created.reply_count, 0);
  assert.equal(created.unread, 0);
  assert.equal(created.created_by, (await alice.ok("GET", "/v1/ot/me")).owner_id);

  assert.equal((await bob.call("POST", base, { root_message_id: "root-launch" })).status, 409);
  assert.equal((await bob.call("POST", base, { root_message_id: "" })).status, 400);
  assert.equal((await bob.call("POST", base, { root_message_id: "root-empty", title: "   " })).status, 400);
  assert.equal((await bob.call("POST", base, { root_message_id: "root-long", title: "x".repeat(81) })).status, 400);

  const other = await alice.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Another room", team_id: team.id, members: [bob.handle],
  });
  const repeated = await alice.ok("POST", threadsPath(workspace, other.id), { root_message_id: "root-launch" });
  assert.notEqual(repeated.id, created.id);
  assert.equal(repeated.conversation_id, other.id);

  const { group: carolGroup, workspace: carolWorkspace } = await room(carol, [], "Carol room");
  const foreign = threadsPath(carolWorkspace, group.id);
  assert.equal((await carol.call("GET", foreign)).status, 404);
  assert.equal((await carol.call("POST", foreign, { root_message_id: "root-launch" })).status, 404);
  assert.deepEqual(await carol.ok("GET", threadsPath(carolWorkspace, carolGroup.id)), []);
});

test("replies page in order and unread is per user until each read cursor advances", async (t) => {
  const service = await startServer({ ...bulkAuth, now: () => clock });
  t.after(service.stop);
  const [alice, bob, carol] = await Promise.all([
    home(service.base, "reply-alice"), home(service.base, "reply-bob"), home(service.base, "reply-carol"),
  ]);
  const { workspace, group } = await room(alice, [bob, carol], "Reply room");
  const base = threadsPath(workspace, group.id);
  const thread = await alice.ok("POST", base, { root_message_id: "root-replies" });

  tick();
  const first = await alice.ok("POST", `${base}/${thread.id}/replies`, { body: "first" });
  tick();
  const second = await bob.ok("POST", `${base}/${thread.id}/replies`, { body: "second" });
  tick();
  const third = await carol.ok("POST", `${base}/${thread.id}/replies`, { body: "third" });
  assert.match(first.id, /^otmr_/);
  assert.equal(first.thread_id, thread.id);
  assert.equal(first.deleted, false);

  const page = await bob.ok("GET", `${base}/${thread.id}?limit=2`);
  assert.deepEqual(page.replies.map((reply: any) => reply.body), ["first", "second"]);
  assert.equal(page.thread.reply_count, 3);
  assert.equal(page.unread, 2, "alice and carol wrote replies bob has not read");

  const following = await bob.ok("GET", `${base}/${thread.id}?limit=2&cursor=${second.id}`);
  assert.deepEqual(following.replies.map((reply: any) => reply.body), ["third"]);
  assert.equal(following.thread.reply_count, 3);
  assert.equal((await bob.call("GET", `${base}/${thread.id}?cursor=missing-reply`)).status, 404);
  assert.equal((await bob.call("GET", `${base}/${thread.id}?limit=0`)).status, 400);

  const listed = await alice.ok("GET", base);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].reply_count, 3);
  assert.equal(listed[0].unread, 2, "bob and carol wrote replies alice has not read");
  assert.deepEqual(await bob.ok("GET", `${base}?cursor=missing-thread`), []);

  const read = await bob.ok("POST", `${base}/${thread.id}/read`, {});
  assert.equal(read.user_id, (await bob.ok("GET", "/v1/ot/me")).owner_id);
  assert.equal(read.unread, 0);
  assert.equal((await bob.ok("GET", `${base}/${thread.id}`)).unread, 0);
  assert.equal((await alice.ok("GET", `${base}/${thread.id}`)).unread, 2);

  tick();
  await alice.ok("POST", `${base}/${thread.id}/replies`, { body: "after read" });
  assert.equal((await bob.ok("GET", `${base}/${thread.id}`)).unread, 1);
  const old = await bob.ok("POST", `${base}/${thread.id}/read`, { last_read: second.created_at });
  assert.equal(old.last_read, read.last_read, "a read cursor never moves backwards");
  assert.equal(old.unread, 1);
  tick();
  const current = await bob.ok("POST", `${base}/${thread.id}/read`, { last_read: clock });
  assert.equal(current.unread, 0);
});

test("resolving a thread filters the listing and can be reopened", async (t) => {
  const service = await startServer({ ...bulkAuth, now: () => clock });
  t.after(service.stop);
  const [alice, bob] = await Promise.all([home(service.base, "resolve-alice"), home(service.base, "resolve-bob")]);
  const { workspace, group } = await room(alice, [bob], "Resolve room");
  const base = threadsPath(workspace, group.id);
  const first = await alice.ok("POST", base, { root_message_id: "root-one" });
  const second = await alice.ok("POST", base, { root_message_id: "root-two" });

  tick();
  const resolved = await alice.ok("POST", `${base}/${first.id}/resolve`, {});
  assert.equal(resolved.resolved, true);
  assert.deepEqual((await alice.ok("GET", `${base}?include_resolved=false`)).map((row: any) => row.id), [second.id]);
  assert.deepEqual((await alice.ok("GET", base)).map((row: any) => row.id).sort(), [first.id, second.id].sort());
  assert.equal((await bob.call("POST", `${base}/${first.id}/resolve`, { resolved: "yes" })).status, 400);

  const reopened = await alice.ok("POST", `${base}/${first.id}/resolve`, { resolved: false });
  assert.equal(reopened.resolved, false);
  assert.deepEqual((await alice.ok("GET", `${base}?include_resolved=false`)).map((row: any) => row.id).sort(),
    [first.id, second.id].sort());
  assert.equal((await alice.call("POST", `${base}/missing-thread/resolve`, {})).status, 404);
});

test("soft-deleted replies leave views and counts, and only their author can delete them", async (t) => {
  const service = await startServer({ ...bulkAuth, now: () => clock });
  t.after(service.stop);
  const [alice, bob, carol] = await Promise.all([
    home(service.base, "delete-alice"), home(service.base, "delete-bob"), home(service.base, "delete-carol"),
  ]);
  const { workspace, group } = await room(alice, [bob, carol], "Delete room");
  const base = threadsPath(workspace, group.id);
  const thread = await alice.ok("POST", base, { root_message_id: "root-delete" });
  tick();
  const removed = await alice.ok("POST", `${base}/${thread.id}/replies`, { body: "remove me" });
  tick();
  const kept = await bob.ok("POST", `${base}/${thread.id}/replies`, { body: "keep me" });

  assert.equal((await bob.call("DELETE", `${base}/${thread.id}/replies/${removed.id}`)).status, 403);
  assert.equal((await carol.call("DELETE", `${base}/${thread.id}/replies/${kept.id}`)).status, 403);
  assert.deepEqual(await alice.ok("DELETE", `${base}/${thread.id}/replies/${removed.id}`), { deleted: true });
  assert.deepEqual(await alice.ok("DELETE", `${base}/${thread.id}/replies/${removed.id}`), { deleted: true });

  const page = await carol.ok("GET", `${base}/${thread.id}`);
  assert.deepEqual(page.replies.map((reply: any) => reply.id), [kept.id]);
  assert.equal(page.thread.reply_count, 1);
  assert.equal(page.unread, 1, "the deleted reply does not stay unread");
  assert.equal((await alice.ok("GET", base))[0].reply_count, 1);

  const other = await alice.ok("POST", base, { root_message_id: "root-elsewhere" });
  assert.equal((await alice.call("DELETE", `${base}/${other.id}/replies/${kept.id}`)).status, 404);
  assert.equal((await alice.call("DELETE", `${base}/${thread.id}/replies/missing-reply`)).status, 404);

  for (const bad of ["", "x".repeat(4001), "bad\u0000body"]) {
    assert.equal((await alice.call("POST", `${base}/${thread.id}/replies`, { body: bad })).status, 400);
  }
  const exact = await alice.ok("POST", `${base}/${thread.id}/replies`, { body: "x".repeat(4000) });
  assert.equal(exact.body.length, 4000);
});

test("account conversations use the unscoped routes with the same membership checks", async (t) => {
  const service = await startServer({ ...bulkAuth, now: () => clock });
  t.after(service.stop);
  const [alice, bob, carol] = await Promise.all([
    home(service.base, "account-alice"), home(service.base, "account-bob"), home(service.base, "account-carol"),
  ]);
  const contact = await alice.ok("POST", "/v1/ot/contacts", { handle: bob.handle });
  await bob.ok("POST", `/v1/ot/contacts/${contact.id}`, { action: "accept" });
  const dm = await alice.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: bob.handle });
  const base = `/v1/ot/conversations/${dm.id}/threads`;

  const thread = await alice.ok("POST", base, { root_message_id: "root-dm" });
  assert.equal(thread.workspace_id, "");
  const reply = await bob.ok("POST", `${base}/${thread.id}/replies`, { body: "direct reply" });
  assert.equal((await alice.ok("GET", `${base}/${thread.id}`)).replies[0].id, reply.id);
  assert.equal((await carol.call("GET", base)).status, 404);
  assert.equal((await carol.call("POST", `${base}/${thread.id}/replies`, { body: "not mine" })).status, 404);
});
