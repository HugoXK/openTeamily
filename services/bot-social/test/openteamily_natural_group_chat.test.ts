import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

type Actor = Awaited<ReturnType<typeof home>>;
type Job = {id: string; agent_id: string; agent_owner_id: string; status: string};
let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const lead = {agent_ref: "z-manager", name: "产品经理助理"};
const engineer = {agent_ref: "a-engineer", name: "研发工程师助理"};
const reviewer = {agent_ref: "b-reviewer", name: "测试工程师助理"};
const queue = "/v1/ot/agent-inbox?managed=1";
const ownerId = async (actor: Actor) => (await actor.ok("GET", "/v1/ot/me")).owner_id;
const roomPath = (group: {id: string}) => "/v1/ot/conversations/" + group.id;
const targets = (message: {reply_jobs: Job[]}) => message.reply_jobs.map(job => job.agent_id);

async function answer(actor: Actor, room: string, request: any, job: Job, isolated = false) {
  const claim_id = randomUUID();
  const attempt = 1;
  const receipt = await actor.ok("POST", "/v1/ot/agent-reply-jobs/" + job.id, {
    action: "start", attempt, source_revision: request.revision, claim_id, accept_group_text_turn: true,
  });
  assert.equal(receipt.group_text_only === true, isolated);
  const reply = await actor.ok("POST", room + "/agent-messages", {
    agent_ref: job.agent_id, body: "收到，已开始核对。", mode: "mention", reply_to: request.id,
    job_id: job.id, claim_id, attempt,
  });
  assert.equal(reply.reply_job_id, job.id);
  return reply;
}

test("an existing single-member agent group answers naturally without creating fake mentions", async () => {
  const owner = await home(service.base, "natural-owner");
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "产品研发小队", agents: [lead, engineer, reviewer],
  });
  const room = roomPath(group);
  assert.deepEqual(group.group_agent_routing, {mode: "personal", default: "all", policy: {mode: "default"}, can_edit: true});
  const send = (body: string, extras = {}) => owner.ok("POST", room + "/messages", {body, direct: true, ...extras});
  const ordinary = await send("帮我整理一下验收计划");
  assert.deepEqual(targets(ordinary), [lead.agent_ref, engineer.agent_ref, reviewer.agent_ref]);
  assert.deepEqual(ordinary.mentions, []);
  assert.equal(ordinary.body, "帮我整理一下验收计划");

  const hello = await send("你们好", {client_key: "natural-hello-fixture"});
  assert.deepEqual(targets(hello), [lead.agent_ref, engineer.agent_ref, reviewer.agent_ref]);
  assert.equal(hello.body, "你们好");
  const duplicate = await send("你们好", {client_key: "natural-hello-fixture"});
  assert.equal(duplicate.id, hello.id);
  assert.deepEqual(duplicate.reply_jobs, hello.reply_jobs);
  const loaded = (await owner.ok("GET", room + "/messages")).messages.find((row: any) => row.id === hello.id);
  assert.deepEqual(loaded.reply_jobs, hello.reply_jobs);
  assert.deepEqual(loaded.mentions, []);
  const requested = await send("都回复我一下");
  assert.deepEqual(targets(requested), targets(hello));
  const inbox = await owner.ok("GET", queue);
  assert.ok(inbox.jobs.some((row: any) => row.message.id === hello.id));
  assert.deepEqual((await owner.ok("GET", "/v1/ot/agent-inbox")).items, []);
  const replies = await Promise.all(hello.reply_jobs.map((job: Job) => answer(owner, room, hello, job)));
  assert.deepEqual((await owner.ok("GET", queue)).jobs.filter((row: any) => replies.some(reply => reply.id === row.message.id)), []);
  const followup = await send("请再解释一下", {reply_to: replies[1].id});
  assert.deepEqual(targets(followup), [engineer.agent_ref]);

  await owner.ok("PATCH", room + "/agents/" + reviewer.agent_ref, {auto_reply: true});
  assert.deepEqual((await owner.ok("GET", room)).group_agent_routing,
    {mode: "personal", default: "auto", policy: {mode: "default"}, can_edit: true});
  const autos = await send("现在总结一下");
  assert.deepEqual(targets(autos), []);
  const addressed = await send("@研发工程师助理 你好");
  assert.deepEqual(targets(addressed), [engineer.agent_ref]);
  const explicitAll = await send("@所有智能体 再给一个建议");
  assert.deepEqual(targets(explicitAll), targets(hello));
  const latest = await owner.ok("GET", queue);
  assert.deepEqual(latest.items.filter((item: any) => item.message.id === autos.id).map((item: any) => item.agent_ref), [reviewer.agent_ref]);
  assert.deepEqual(latest.items.filter((item: any) => item.message.id === addressed.id), []);
  assert.equal((await owner.call("POST", room + "/agent-messages", {
    agent_ref: reviewer.agent_ref, body: "Unselected automatic answer", mode: "auto", reply_to: addressed.id,
  })).data.error.code, "reply_job_unavailable");

  const source = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "转发来源", agents: [lead],
  });
  const toForward = await owner.ok("POST", roomPath(source) + "/messages", {body: "你们好"});
  const forwarded = await owner.ok("POST", roomPath(source) + "/forward", {target_conversation_id: group.id, message_ids: [toForward.id]});
  assert.equal(forwarded.forwarded, 1);
  const copy = (await owner.ok("GET", room + "/messages")).messages.at(-1);
  assert.notEqual(copy.id, toForward.id);
  assert.deepEqual(copy.reply_jobs, []);
  assert.equal((await owner.ok("GET", queue)).items.some((item: any) => item.message.id === copy.id), false);
});

test("shared conversation uses natural fanout only for explicit all-agent language and isolates other owners", async () => {
  const [author, colleague, outsider] = await Promise.all([
    home(service.base, "natural-author"), home(service.base, "natural-peer"), home(service.base, "natural-other"),
  ]);
  const team = await author.ok("POST", "/v1/ot/teams", {name: "Shared team"});
  const {code} = await author.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await colleague.ok("POST", "/v1/ot/invites/accept", {code});
  const group = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", team_id: team.id, title: "共享产品讨论", members: [colleague.handle], agents: [lead],
  });
  const room = roomPath(group);
  await colleague.ok("PUT", room + "/agents/" + engineer.agent_ref, {name: engineer.name, auto_reply: true});
  assert.deepEqual((await author.ok("GET", room)).group_agent_routing, {mode: "shared", policy: {mode: "default"}, can_edit: true});
  const conversation = await author.ok("POST", room + "/messages", {body: "你们好，这里先讨论排期"});
  assert.deepEqual(targets(conversation), []);
  assert.deepEqual((await colleague.ok("GET", queue)).items.map((item: any) => [item.message.id, item.mode]), [[conversation.id, "auto"]]);
  const observation = await author.ok("POST", room + "/messages", {body: "所有智能体回复得太慢"});
  assert.deepEqual(targets(observation), []);
  const command = await author.ok("POST", room + "/messages", {body: "让智能体都回复我一下"});
  assert.deepEqual(targets(command), [lead.agent_ref, engineer.agent_ref]);
  const alias = await author.ok("POST", room + "/messages", {body: "@all 请都检查一下"});
  assert.deepEqual(targets(alias), targets(command));
  const handle = await author.ok("POST", room + "/messages", {body: "@all.home 请检查一下"});
  assert.deepEqual(targets(handle), []);
  const colleagueId = await ownerId(colleague);
  const remote = command.reply_jobs.find((job: Job) => job.agent_owner_id === colleagueId);
  const agentInbox = await colleague.ok("GET", queue);
  assert.equal(agentInbox.jobs.find((row: any) => row.job_id === remote.id).group_text_only, true);
  assert.equal(agentInbox.items.some((row: any) => row.message.id === command.id), false);
  assert.equal((await outsider.ok("GET", queue)).jobs.length, 0);
  assert.equal((await outsider.call("POST", room + "/messages", {body: "让智能体都回复我一下"})).status, 404);
  assert.equal((await colleague.call("POST", "/v1/ot/agent-reply-jobs/" + remote.id, {action: "start", attempt: 1})).status, 409);
  const reply = await answer(colleague, room, command, remote, true);
  const quoted = await author.ok("POST", room + "/messages", {body: "能举个例子吗？", reply_to: reply.id});
  assert.deepEqual(targets(quoted), [engineer.agent_ref]);
  assert.equal(quoted.reply_jobs[0].agent_owner_id, colleagueId);
});

test("plural inference is bounded when a group has a large agent roster", async () => {
  const owner = await home(service.base, "natural-cap");
  const group = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", account_group: true, title: "Roster", agents: [lead]});
  const room = roomPath(group);
  for (let index = 0; index < 21; index++) {
    await owner.ok("PUT", room + "/agents/number-" + index, {name: "Agent " + index});
  }
  const result = await owner.ok("POST", room + "/messages", {body: "请所有智能体都回答"});
  assert.equal(result.reply_jobs.length, 20);
  assert.equal(new Set(targets(result)).size, 20);
  assert.equal(targets(result)[0], lead.agent_ref);
});
