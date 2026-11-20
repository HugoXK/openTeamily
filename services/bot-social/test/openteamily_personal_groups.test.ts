import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("personal groups share confirmed contacts and atomic agent rosters without a team", async () => {
  const [owner, peer, stranger] = await Promise.all([
    home(S.base,"personal-owner"), home(S.base,"personal-peer"), home(S.base,"personal-stranger"),
  ]);
  const root = "/v1/ot/conversations";
  const request = await owner.ok("POST","/v1/ot/contacts",{handle:peer.handle});
  const options = {kind:"group",account_group:true,title:"Personal test",members:[peer.handle],
    agents:[{agent_ref:"agent_1",name:"Launch helper"}],idempotency_key:"personal-group-attempt"};
  assert.equal((await owner.call("POST",root,options)).status,403);
  await peer.ok("POST","/v1/ot/contacts/"+request.id,{action:"accept"});
  const group = await owner.ok("POST",root,options);
  assert.equal(group.account_group,true);
  assert.equal(group.team_id,null);
  assert.deepEqual(group.agents.map((row:any)=>row.agent_ref),["agent_1"]);
  assert.equal((await owner.ok("POST",root,options)).id,group.id);
  assert.equal((await owner.call("POST",root,{...options,title:"Other title"})).status,409);
  assert.equal((await peer.ok("GET",root+"?scope=personal")).conversations[0].id,group.id);
  assert.equal((await stranger.call("GET",root+"/"+group.id)).status,404);
  assert.equal((await owner.call("POST",root+"/"+group.id+"/members",{handle:stranger.handle})).status,403);
  assert.equal((await stranger.ok("GET",root+"?scope=personal")).conversations.length,0);
  const added = await peer.ok("GET","/v1/ot/notifications?personal=1");
  assert.equal(added.notifications.filter((row:any)=>row.kind==="messenger.added"&&row.data.conversation_id===group.id).length,1);

  const room = root+"/"+group.id;
  const data = Buffer.from("private group file").toString("base64");
  const file = await owner.ok("POST",room+"/messages",{direct:true,attachment:{title:"group.txt",mime:"text/plain",data}});
  assert.equal((await peer.ok("GET",room+"/messages/"+file.id+"/file")).data,data);
  assert.equal((await stranger.call("GET",room+"/messages/"+file.id+"/file")).status,404);
  const msg = await peer.ok("POST",room+"/messages",{body:"@agent_1 personal launch"});
  assert.ok((await owner.ok("GET","/v1/ot/agent-inbox")).items.some((row:any)=>row.message.id===msg.id && row.agent_ref==="agent_1"));
  assert.deepEqual((await peer.ok("GET","/v1/ot/agent-inbox")).items,[]);
  const search = "/v1/ot/messages/personal-search?q=personal%20launch";
  assert.ok((await owner.ok("GET",search)).items.some((row:any)=>row.message_id===msg.id));
  assert.deepEqual((await stranger.ok("GET",search)).items,[]);
  assert.equal((await peer.call("POST",room+"/announcement",{body:"Member",revision:0})).status,403);
  await owner.ok("POST",room+"/announcement",{body:"Group plan",revision:0});
  assert.equal((await peer.ok("GET",room+"/announcement")).announcement.body,"Group plan");
  const translated = await owner.ok("POST",room+"/translation-sources",{items:[{id:msg.id,revision:1}]});
  assert.equal(translated.sources[0].body,"@agent_1 personal launch");
  assert.equal((await stranger.call("POST",room+"/translation-sources",{items:[]})).status,404);

  const team = await owner.ok("POST","/v1/ot/teams",{name:"Separate team"});
  assert.deepEqual((await owner.ok("GET",root+"?scope=member&team_id="+team.id)).conversations,[]);
  await owner.ok("DELETE",room+"/members/"+encodeURIComponent(peer.handle));
  assert.equal((await peer.call("GET",room)).status,404);
  assert.deepEqual((await peer.ok("GET",search)).items,[]);
});

test("group mentions retry individual replies after the inbox cursor moves", async () => {
  const [owner, sender] = await Promise.all([
    home(S.base, "reply-owner"), home(S.base, "reply-sender"),
  ]);
  const request = await owner.ok("POST", "/v1/ot/contacts", {handle: sender.handle});
  await sender.ok("POST", "/v1/ot/contacts/" + request.id, {action: "accept"});
  const root = "/v1/ot/conversations";
  const group = await owner.ok("POST", root, {kind: "group", account_group: true,
    title: "Reply retries", members: [sender.handle], agents: [
      {agent_ref: "draft", name: "Draft helper"}, {agent_ref: "review", name: "Review helper"},
    ]});
  const room = root + "/" + group.id;
  const send = {body: "@draft @review Check the draft", client_key: "original"};
  const message = await sender.ok("POST", room + "/messages", send);
  assert.equal((await sender.ok("POST", room + "/messages", send)).id, message.id);
  assert.deepEqual(message.reply_jobs.map((job: any) => job.status), ["queued", "queued"]);
  const inbox = await owner.ok("GET", "/v1/ot/agent-inbox?managed=1");
  assert.deepEqual(inbox.items, []);
  const draft = inbox.jobs.find((job: any) => job.agent_ref === "draft");
  const review = inbox.jobs.find((job: any) => job.agent_ref === "review");
  assert.equal((await sender.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs.length, 0);
  const later = "/v1/ot/agent-inbox?managed=1&after=" + inbox.cursor;
  const change = (job: any) => "/v1/ot/agent-reply-jobs/" + job.job_id;
  const retry = room + "/messages/" + message.id + "/agent-retry";
  const answer = (job: any) => ({agent_ref: job.agent_ref, body: "Checked", reply_to: message.id,
    job_id: job.job_id, attempt: job.attempt});

  assert.equal((await sender.call("POST", change(draft), {action: "start", attempt: 1})).status, 404);
  await owner.ok("POST", change(draft), {action: "start", attempt: 1});
  await owner.ok("POST", change(review), {action: "start", attempt: 1});
  assert.equal((await owner.call("POST", change(draft), {action: "start", attempt: 1})).status, 409);
  assert.deepEqual((await owner.ok("GET", later)).jobs, []);
  const posted = await owner.ok("POST", room + "/agent-messages", answer(review));
  await owner.ok("POST", change(draft), {action: "fail", attempt: 1});
  assert.equal((await owner.call("POST", retry, {job_id: draft.job_id})).status, 404);
  const senderPage = await sender.ok("GET", room + "/messages");
  const ownerPage = await owner.ok("GET", room + "/messages");
  assert.equal(senderPage.messages[0].reply_jobs.find((job: any) => job.id === draft.job_id).can_retry, true);
  assert.equal(ownerPage.messages[0].reply_jobs.find((job: any) => job.id === draft.job_id).can_retry, false);
  const retried = await sender.ok("POST", retry, {job_id: draft.job_id});
  assert.deepEqual(retried.reply_jobs.map((job: any) => job.status), ["queued", "replied"]);
  assert.equal((await sender.call("POST", retry, {job_id: draft.job_id})).status, 409);
  const next = (await owner.ok("GET", later)).jobs;
  assert.deepEqual(next.map((job: any) => [job.job_id, job.attempt]), [[draft.job_id, 2]]);
  await owner.ok("POST", change(draft), {action: "start", attempt: 2});
  assert.equal((await owner.call("POST", room + "/agent-messages", answer(draft))).status, 409);
  const completed = await owner.ok("POST", room + "/agent-messages", answer(next[0]));
  assert.equal((await owner.ok("POST", room + "/agent-messages", answer(next[0]))).id, completed.id);
  const history = (await sender.ok("GET", room + "/messages")).messages;
  assert.deepEqual(history.map((row: any) => row.id), [message.id, posted.id, completed.id]);
  assert.deepEqual(history[0].reply_jobs.map((job: any) => job.status), ["replied", "replied"]);
});
