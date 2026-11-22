import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

test("team Studio coordinates edits between actual account homes and enforces the current roster", async t => {
  const {base, stop, platform} = await startServer(bulkAuth);
  t.after(stop);
  const [owner, editor, peer, outsider] = await Promise.all([
    home(base, "studio-owner"), home(base, "studio-editor"), home(base, "studio-peer"), home(base, "studio-outsider"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Studio workspace", slug: "studio-workspace", idempotency_key: "team-studio-fixture",
  });
  const second = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Separate team", slug: "studio-separate", idempotency_key: "team-second-fixture",
  });
  const unconverted = await owner.ok("POST", "/v1/ot/workspaces", {
    name: "Private workspace", idempotency_key: "team-private-fixture",
  });
  const unbound = await owner.ok("POST", "/v1/ot/teams", {name: "Unbound team", slug: "studio-unbound"});
  const documents = (id: string) => `/v1/ot/teams/${id}/studio/documents`;
  const path = documents(team.workspace_id);
  const draft = {title: "共同编辑", body: "第一段\n留着换行 \t", client_key: "create-shared-doc-001"};
  for (const teamId of [unconverted.id, unconverted.workspace_id, unbound.id]) {
    assert.equal((await owner.call("POST", documents(teamId), draft)).status, 404);
  }
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await outsider.call("GET", path)).status, 404);
  const member = (handle: string) => `/v1/ot/teams/${team.id}/members/${handle}`;
  for (const memberHome of [editor, peer]) {
    await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle:memberHome.handle, role:"member"});
  }
  await owner.ok("PUT", "/v1/ot/profile", {display_name:"Document Owner"});
  await editor.ok("PUT", "/v1/ot/profile", {display_name:"Document Editor"});
  const creations = await Promise.all([
    editor.call("POST", path, draft), editor.call("POST", documents(team.id), draft),
  ]);
  assert.deepEqual(creations.map(row => row.status).sort(), [200,201]);
  const { document } = creations[0].data;
  assert.equal(creations[1].data.document.id, document.id);
  assert.match(document.id, /^[0-9a-f]{32}$/);
  assert.equal(document.revision, 1);
  assert.equal(document.body, draft.body);
  assert.equal(document.created_by, "Document Editor");
  assert.equal(document.updated_by, "Document Editor");
  const one = path + "/" + document.id;
  assert.deepEqual(await owner.ok("GET", one + "?revision=1"), {unchanged:true,revision:1});
  assert.equal((await owner.call("GET", one + "?revision=1&revision=1")).status, 400);
  assert.equal((await owner.call("GET", documents(second.id) + "/" + document.id)).status, 404);
  assert.equal((await outsider.call("GET", one + "?revision=1")).status, 404);
  const list = (await peer.ok("GET", path)).items;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, document.id);
  assert.equal(list[0].can_delete, false);
  assert.equal(list[0].body, undefined);
  assert.equal((await peer.call("DELETE", one, {revision:1})).status, 403);
  assert.equal((await editor.call("POST", path, {...draft,title:"Different title"})).data.error.code, "idempotency_conflict");

  const outcomes = await Promise.all([
    owner.call("PUT", one, {title:draft.title,body:"Owner edit",revision:1}),
    editor.call("PUT", one, {title:draft.title,body:"Editor edit",revision:1}),
  ]);
  assert.deepEqual(outcomes.map(row => row.status).sort(), [200,409]);
  assert.equal(outcomes.find(row => row.status===409)?.data.error.code, "revision_conflict");
  const current = (await peer.ok("GET", one + "?revision=1")).document;
  assert.equal(current.revision, 2);
  assert.equal(current.body, outcomes.find(row => row.status===200)?.data.document.body);
  assert.equal(current.updated_by, outcomes[0].status===200 ? "Document Owner" : "Document Editor");
  assert.equal((await editor.ok("POST", path, draft)).document.revision, 2);
  assert.equal((await editor.ok("PUT", one, {title:current.title, body:current.body, revision:2})).document.revision, 2);
  assert.equal((await editor.call("PUT", one, {title:draft.title,body:"x".repeat(60_001),revision:2})).status, 400);
  await owner.ok("PATCH", member(editor.handle), {suspended:true});
  assert.equal((await editor.call("GET", one + "?revision=2")).status, 404);
  assert.equal((await editor.call("PUT", one, {title:draft.title,body:"Lost access",revision:2})).status, 404);
  assert.equal((await editor.call("DELETE", one, {revision:2})).status, 404);
  assert.equal((await owner.call("DELETE", one, {revision:1})).data.error.code, "revision_conflict");
  assert.deepEqual(await owner.ok("DELETE", one, {revision:2}), {deleted:true});
  assert.equal((await owner.call("GET", one)).status, 404);
  assert.deepEqual((await owner.ok("GET", path)).items, []);
  await owner.ok("PATCH", member(editor.handle), {suspended:false});
  assert.equal((await editor.call("POST", path, draft)).data.error.code, "document_deleted");
  const tombstone = platform.db.prepare("SELECT title,body FROM ot_studio_documents WHERE id=?").get(document.id);
  assert.deepEqual(tombstone, {title:"",body:""});
});
