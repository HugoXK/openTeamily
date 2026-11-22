import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";
import { STUDIO_SCHEMA } from "../src/openteamily/studio.js";

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

test("team document versions restore atomically and stay scoped to the current roster", async t => {
  const {base, stop, platform} = await startServer(bulkAuth);
  t.after(stop);
  const [owner, editor, stranger] = await Promise.all([
    home(base, "versions-owner"), home(base, "versions-editor"), home(base, "versions-stranger"),
  ]);
  const team = await owner.ok("POST", "/v1/ot/workspaces", {
    name:"History", slug:"workspace-versions", idempotency_key:"studio-versions-fixture",
  });
  await owner.ok("POST", `/v1/ot/teams/${team.id}/members`, {handle:editor.handle,role:"member"});
  const collection = `/v1/ot/teams/${team.workspace_id}/studio/documents`;
  const {document} = await owner.ok("POST", collection, {title:"Initial",body:"First",client_key:"studio-history-original"});
  const path = collection + "/" + document.id;
  await editor.ok("PUT", path, {title:"Edited",body:"Second",revision:1});
  assert.equal((await stranger.call("GET", path+"/versions/1")).status,404);
  const history = await editor.ok("GET", path+"/versions");
  assert.equal(history.current_revision,2);
  assert.deepEqual(history.items.map((item: Record<string, unknown>)=>[item.revision,item.title,item.body]),
    [[2,"Edited",undefined],[1,"Initial",undefined]]);
  assert.equal((await editor.ok("GET", path+"/versions/1")).version.body,"First");
  assert.equal((await owner.call("POST", path+"/restore", {revision:1,to:1})).data.error.code,"revision_conflict");
  const outcomes = await Promise.all([
    editor.call("POST", path+"/restore", {revision:2,to:1}),
    owner.call("POST", path+"/restore", {revision:2,to:1}),
  ]);
  assert.deepEqual(outcomes.map(item=>item.status).sort(),[200,409]);
  const restored = await owner.ok("GET", path+"/versions/3");
  assert.equal(restored.version.body,"First");
  assert.equal(restored.version.restored_from,1);
  assert.equal((await editor.ok("GET", path+"/versions/2")).version.body,"Second");
  for(let rev=3;rev<33;rev++) await editor.ok("PUT", path, {title:"Bounded",body:String(rev),revision:rev});
  const bounded = await editor.ok("GET", path+"/versions");
  assert.equal(bounded.items.length,30);
  assert.equal(bounded.items.at(-1).revision,4);
  assert.equal((await owner.call("GET",path+"/versions/3")).status,404);
  // Upgrading a store that only kept the current document should resume at its existing revision.
  platform.db.exec("DROP TABLE ot_studio_revisions");
  platform.db.exec(STUDIO_SCHEMA);
  platform.db.exec(STUDIO_SCHEMA);
  const migrated = await owner.ok("GET",path+"/versions");
  assert.deepEqual(migrated.items.map((version: {revision: number})=>version.revision),[33]);
  await owner.ok("DELETE",path,{revision:33});
  assert.equal((await editor.call("GET",path+"/versions/33")).status,404);
  const remaining = platform.db.prepare("SELECT count(*) AS n FROM ot_studio_revisions WHERE document_id=?")
    .get(document.id) as {n: number};
  assert.equal(remaining.n,0);
});
