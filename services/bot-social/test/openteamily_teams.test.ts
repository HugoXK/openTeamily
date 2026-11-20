// OpenTeamily teams, members, invites, join requests and directory on Bot Social, driven with the
// FlyBot home connector token exactly as each user's DS-Bot plugin does. Fixture accounts only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

let n = 0;
export async function home(base: string, name: string) {
  const u = `${name}${++n}${Date.now() % 100000}`;
  const r: any = await (await fetch(`${base}/v1/onboard/flybot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: u }) })).json();
  const token = r.connector.token as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await res.json();
    return { status: res.status, data };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const me = await ok("GET", "/v1/ot/me");
  return { call, ok, handle: me.handle as string };
}

test("profile comes from the FlyBot home; no token is refused", async () => {
  const A = await home(S.base, "ann");
  assert.match(A.handle, /\.home$/);
  const p = await A.ok("PUT", "/v1/ot/profile", { display_name: "Ann", bio: "hi" });
  assert.equal(p.display_name, "Ann");
  assert.equal((await fetch(S.base + "/v1/ot/teams")).status, 401);
});

test("team lifecycle: create, invite, accept, roles, suspend, leave", async () => {
  const A = await home(S.base, "owner");
  const B = await home(S.base, "bea");
  const C = await home(S.base, "cid");
  const team = await A.ok("POST", "/v1/ot/teams", { name: "Content Studio", slug: `studio-${n}`, summary: "we write" });
  assert.equal(team.role, "owner");
  assert.equal((await B.call("GET", `/v1/ot/teams/${team.id}`)).status, 404, "non-member learns nothing");
  assert.equal((await B.call("POST", `/v1/ot/teams/${team.id}/invites`, {})).status, 404);

  const { code, invite } = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { role: "member", max_uses: 2 });
  assert.equal(typeof code, "string");
  assert.equal(invite.code, undefined);
  const preview = await B.ok("POST", "/v1/ot/invites/preview", { code });
  assert.equal(preview.team.name, "Content Studio");
  assert.equal((await B.ok("POST", "/v1/ot/invites/accept", { code })).status, "member");
  assert.equal((await B.ok("POST", "/v1/ot/invites/accept", { code })).status, "member", "idempotent");
  assert.equal((await B.ok("GET", "/v1/ot/teams")).teams.length, 1);

  const members = await A.ok("GET", `/v1/ot/teams/${team.id}/members`);
  assert.deepEqual(members.members.map((m: any) => m.role), ["owner", "member"]);
  assert.equal((await B.call("PATCH", `/v1/ot/teams/${team.id}/members/${A.handle}`, { role: "member" })).status, 403);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${B.handle}`, { role: "admin" });
  // admin invites C, then may suspend C (a member) but not change roles
  const second = await B.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await C.ok("POST", "/v1/ot/invites/accept", { code: second.code });
  assert.equal((await B.call("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { role: "admin" })).status, 403);
  await B.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: true });
  assert.equal((await C.call("GET", `/v1/ot/teams/${team.id}`)).status, 404, "suspended member loses access");
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/members/${C.handle}`, { suspended: false });
  assert.equal((await C.call("GET", `/v1/ot/teams/${team.id}`)).status, 200);
  assert.equal((await A.call("DELETE", `/v1/ot/teams/${team.id}/members/${A.handle}`)).status, 409, "owner cannot leave");
  await C.ok("DELETE", `/v1/ot/teams/${team.id}/members/${C.handle}`);
  assert.equal((await C.ok("GET", "/v1/ot/teams")).teams.length, 0);

  // freeze, revoke and use limits
  const inv = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { max_uses: 1 });
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/invites/${inv.invite.id}`, { frozen: true });
  assert.equal((await C.call("POST", "/v1/ot/invites/accept", { code: inv.code })).status, 410);
  await A.ok("PATCH", `/v1/ot/teams/${team.id}/invites/${inv.invite.id}`, { frozen: false });
  await C.ok("POST", "/v1/ot/invites/accept", { code: inv.code });
  const D = await home(S.base, "dee");
  assert.equal((await D.call("POST", "/v1/ot/invites/accept", { code: inv.code })).status, 410, "used up");
  assert.equal((await D.call("POST", "/v1/ot/invites/accept", { code: "x".repeat(32) })).status, 404);
});

test("approval invites and the team directory queue join requests for owners and admins", async () => {
  const A = await home(S.base, "lead");
  const B = await home(S.base, "joiner");
  const team = await A.ok("POST", "/v1/ot/teams", { name: "Open Research Guild" });
  const inv = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, { requires_approval: true });
  const pending = await B.ok("POST", "/v1/ot/invites/accept", { code: inv.code });
  assert.equal(pending.status, "pending");
  const notes = await A.ok("GET", "/v1/ot/notifications");
  assert.ok(notes.notifications.some((x: any) => x.kind === "team.join_request" && x.data.member.handle === B.handle));
  const queue = await A.ok("GET", `/v1/ot/teams/${team.id}/join-requests`);
  assert.equal(queue.requests.length, 1);
  await A.ok("POST", `/v1/ot/teams/${team.id}/join-requests/${queue.requests[0].id}`, { decision: "reject" });
  assert.equal((await A.call("POST", `/v1/ot/teams/${team.id}/join-requests/${queue.requests[0].id}`, { decision: "approve" })).status, 409);
  assert.equal((await B.ok("GET", "/v1/ot/teams")).teams.length, 0);

  // directory
  const C = await home(S.base, "seeker");
  assert.equal((await C.ok("GET", "/v1/ot/directory?q=guild")).teams.length, 0, "unlisted teams are hidden");
  await A.ok("PUT", `/v1/ot/teams/${team.id}/listing`, { listed: true, summary: "papers and reading group" });
  const found = await C.ok("GET", "/v1/ot/directory?q=reading");
  assert.equal(found.teams.length, 1);
  assert.equal(found.teams[0].membership, null);
  assert.equal((await C.ok("POST", `/v1/ot/directory/${team.id}/join`)).status, "pending");
  assert.equal((await C.ok("GET", "/v1/ot/directory?q=guild")).teams[0].membership, "pending");
  const q2 = await A.ok("GET", `/v1/ot/teams/${team.id}/join-requests`);
  await A.ok("POST", `/v1/ot/teams/${team.id}/join-requests/${q2.requests[0].id}`, { decision: "approve" });
  assert.equal((await C.ok("GET", "/v1/ot/directory?q=guild")).teams[0].membership, "member");
  const cn = await C.ok("GET", "/v1/ot/notifications");
  assert.ok(cn.notifications.some((x: any) => x.kind === "team.join_decided" && x.data.decision === "approve"));
  await C.ok("POST", "/v1/ot/notifications/read", { up_to: cn.notifications.at(-1).seq });
  assert.equal((await C.ok("GET", "/v1/ot/notifications")).unread, 0);
  await A.ok("PUT", `/v1/ot/teams/${team.id}/listing`, { listed: false });
  assert.equal((await C.call("POST", `/v1/ot/directory/${team.id}/join`)).status, 404);
  await A.ok("DELETE", `/v1/ot/teams/${team.id}`);
  assert.equal((await C.ok("GET", "/v1/ot/teams")).teams.length, 0);
});
