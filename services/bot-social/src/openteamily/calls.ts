import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, OtContext, params, query, text } from "./core.js";
import { requireMember } from "./teams.js";

export const CALLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_live_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL UNIQUE REFERENCES ot_conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('audio','video')), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_call_peers (
  id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES ot_live_calls(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, expires INTEGER NOT NULL, UNIQUE(call_id,owner_id)
);
CREATE INDEX IF NOT EXISTS ot_call_peer_expiry ON ot_call_peers(expires);
CREATE TABLE IF NOT EXISTS ot_call_signals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES ot_live_calls(id) ON DELETE CASCADE,
  sender TEXT NOT NULL REFERENCES ot_call_peers(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES ot_call_peers(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(sender, client_key)
);
CREATE INDEX IF NOT EXISTS ot_call_signals_recipient ON ot_call_signals(recipient,seq);
`;

const PEER_TTL = 60_000;
const MAX_PEERS = 6;
const MAX_SIGNALS = 240;
const SIGNAL_KEY = /^[a-zA-Z0-9_-]{16,64}$/;
type Call = { id: string; conversation_id: string; kind: "audio" | "video"; created_at: number };
type Peer = { id: string; owner_id: string };

function callContext(ot: OtContext, req: FastifyRequest, teamId: unknown) {
  const me = ot.me(req);
  const conversation = ot.get(
    "SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON c.id=m.conversation_id WHERE c.id=? AND m.owner_id=?",
    params(req).id, me.ownerId,
  );
  assert(conversation, 404, "conversation_not_found", "no such conversation");
  if (teamId !== undefined) {
    assert(typeof teamId === "string" && (!conversation.team_id || teamId === conversation.team_id),
      404, "conversation_not_found", "no such conversation in this team");
  }
  const team = conversation.team_id || teamId;
  if (team) requireMember(ot, team, me.ownerId);
  return { me, conversation, team };
}

function prune(ot: OtContext, conversationId?: string) {
  ot.run("DELETE FROM ot_call_peers WHERE expires<=?", ot.now());
  if (conversationId) {
    ot.run(`DELETE FROM ot_call_peers WHERE call_id IN (SELECT id FROM ot_live_calls WHERE conversation_id=?)
      AND owner_id NOT IN (SELECT owner_id FROM ot_conversation_members WHERE conversation_id=?)`, conversationId, conversationId);
    ot.run(`DELETE FROM ot_call_peers WHERE call_id IN (SELECT c.id FROM ot_live_calls c JOIN ot_conversations g
      ON c.conversation_id=g.id WHERE g.id=? AND g.team_id IS NOT NULL)
      AND owner_id NOT IN (SELECT m.owner_id FROM ot_team_members m JOIN ot_conversations g ON g.team_id=m.team_id
        WHERE g.id=? AND m.suspended=0)`, conversationId, conversationId);
  }
  ot.run("DELETE FROM ot_live_calls WHERE id NOT IN (SELECT call_id FROM ot_call_peers)");
}

function describe(ot: OtContext, call: Call) {
  const peers = ot.all<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE call_id=? ORDER BY id", call.id);
  return {
    id: call.id, kind: call.kind, created_at: call.created_at,
    peers: peers.map(peer => {
      const profile = ot.profileView(peer.owner_id);
      return { id: peer.id, name: profile.display_name || profile.handle || "成员" };
    }),
  };
}

function lease(ot: OtContext, conversationId: string, owner: string, input: any) {
  prune(ot, conversationId);
  assert(typeof input.call_id === "string" && typeof input.peer_id === "string",
    400, "invalid_request", "provide a call and peer");
  const call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE id=? AND conversation_id=?", input.call_id, conversationId);
  const peer = call && ot.get<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE id=? AND call_id=? AND owner_id=?",
    input.peer_id, call.id, owner);
  assert(call && peer, 404, "call_ended", "call has ended or this tab left");
  return { call, peer };
}

function signalPayload(input: any) {
  if (input?.description) {
    const {type, sdp} = input.description;
    assert(type === "offer" || type === "answer", 400, "invalid_signal", "expected an offer or answer");
    return {description: {type, sdp: text(sdp, "sdp", {min: 1, max: 24_000, multiline: true})}};
  }
  const candidate = input?.candidate;
  assert(candidate && (candidate.sdpMid == null || typeof candidate.sdpMid === "string" && candidate.sdpMid.length <= 80)
    && (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex)
      && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex < 64)
    && (candidate.sdpMid != null || candidate.sdpMLineIndex != null),
  400, "invalid_signal", "invalid ICE candidate");
  return {candidate: {
    candidate: text(candidate.candidate, "candidate", {min: 1, max: 2048}),
    sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    ...(typeof candidate.usernameFragment === "string" && candidate.usernameFragment.length <= 128
      ? {usernameFragment: candidate.usernameFragment} : {}),
  }};
}

function iceConfig() {
  const stun = process.env.OT_CALL_STUN_URL?.trim();
  const turn = process.env.OT_CALL_TURN_URL?.trim();
  const file = process.env.OT_CALL_TURN_SECRET_FILE?.trim();
  if (stun && !/^stuns?:(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(stun)) throw new Error("Invalid OT_CALL_STUN_URL");
  if (turn && (!/^turns?:(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(turn) || !file)) {
    throw new Error("Configure a valid TURN URL and its credential secret file");
  }
  const secret = turn && file ? readFileSync(file, "utf8").trim() : undefined;
  if (turn && (!secret || secret.length < 32)) throw new Error("TURN requires a secret of at least 32 characters");
  return (peerId: string, now: number) => {
    const ice: {urls: string; username?: string; credential?: string}[] = stun ? [{urls: stun}] : [];
    if (turn && secret) {
      const username = Math.floor(now / 1000 + 21_600) + ":" + peerId;
      ice.push({urls: turn, username, credential: createHmac("sha1", secret).update(username).digest("base64")});
    }
    return ice;
  };
}

export function registerCalls(app: FastifyInstance, ot: OtContext) {
  const root = "/v1/ot/conversations/:id/call";
  const iceServers = iceConfig();
  app.get(root, async req => {
    const {conversation} = callContext(ot, req, query(req).team_id);
    prune(ot, conversation.id);
    const call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE conversation_id=?", conversation.id);
    return {call: call ? describe(ot, call) : null};
  });

  app.post(root + "/join", async req => {
    const input = body(req);
    const {me, conversation, team} = callContext(ot, req, input.team_id);
    assert(input.kind === "audio" || input.kind === "video", 400, "invalid_request", "choose audio or video");
    const now = ot.now();
    return ot.tx(() => {
      prune(ot, conversation.id);
      let call = ot.get<Call>("SELECT * FROM ot_live_calls WHERE conversation_id=?", conversation.id);
      const starting = !call;
      if (!call) {
        assert(input.start === true, 404, "call_ended", "call is no longer active");
        call = {id: newId("otcav"), conversation_id: conversation.id, kind: input.kind, created_at: now};
        ot.run("INSERT INTO ot_live_calls VALUES(?,?,?,?)", call.id, conversation.id, call.kind, now);
      }
      const existing = ot.get<Peer>("SELECT id,owner_id FROM ot_call_peers WHERE call_id=? AND owner_id=?", call.id, me.ownerId);
      // A retried join from this tab returns the same peer. Another tab can
      // explicitly leave the existing call or wait for its lease to expire.
      assert(typeof input.peer_id === "string" && SIGNAL_KEY.test(input.peer_id),
        400, "invalid_request", "provide the tab identifier");
      const peerId = input.peer_id;
      assert(!existing || existing.id === peerId, 409, "call_already_joined", "this account is already in the call");
      if (!existing) {
        assert(!ot.get("SELECT 1 FROM ot_call_peers WHERE id=?", peerId), 409, "peer_in_use", "peer already in use");
        const count = ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_call_peers WHERE call_id=?", call.id);
        assert(count && count.n < MAX_PEERS, 409, "call_full", "call is full");
        ot.run("INSERT INTO ot_call_peers VALUES(?,?,?,?)", peerId, call.id, me.ownerId, now + PEER_TTL);
      }
      if (starting) {
        const by = ot.profileView(me.ownerId);
        for (const member of ot.all<{owner_id: string}>(
          "SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", conversation.id, me.ownerId)) {
          if (team && !ot.get("SELECT 1 FROM ot_team_members WHERE team_id=? AND owner_id=? AND suspended=0", team, member.owner_id)) continue;
          ot.notify(member.owner_id, "messenger.call", {conversation_id: conversation.id, team_id: team || undefined,
            title: conversation.title, call_kind: call.kind, by});
        }
      }
      return {call: describe(ot, call), peer_id: peerId, ice_servers: iceServers(peerId, now)};
    });
  });

  app.post(root + "/poll", async req => {
    const input = body(req);
    const {me, conversation} = callContext(ot, req, input.team_id);
    const {call, peer} = lease(ot, conversation.id, me.ownerId, input);
    const after = input.after ?? 0;
    assert(Number.isSafeInteger(after) && after >= 0, 400, "invalid_request", "invalid signal cursor");
    ot.run("UPDATE ot_call_peers SET expires=? WHERE id=?", ot.now() + PEER_TTL, peer.id);
    const signals = ot.all<{seq: number; sender: string; payload: string}>(
      "SELECT seq,sender,payload FROM ot_call_signals WHERE call_id=? AND recipient=? AND seq>? ORDER BY seq LIMIT 64", call.id, peer.id, after);
    return {call: describe(ot, call), signals: signals.map(row => ({seq: row.seq, from: row.sender, ...JSON.parse(row.payload)}))};
  });

  app.post(root + "/signal", async req => {
    const input = body(req);
    const {me, conversation} = callContext(ot, req, input.team_id);
    const {call, peer} = lease(ot, conversation.id, me.ownerId, input);
    const to = input.to;
    assert(typeof to === "string" && to !== peer.id && ot.get("SELECT 1 FROM ot_call_peers WHERE call_id=? AND id=?", call.id, to),
      404, "peer_left", "peer is no longer in the call");
    const key = input.client_key;
    assert(typeof key === "string" && SIGNAL_KEY.test(key), 400, "invalid_request", "provide a signal key");
    if (ot.get("SELECT 1 FROM ot_call_signals WHERE sender=? AND client_key=?", peer.id, key)) return {sent: true};
    const count = ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_call_signals WHERE sender=?", peer.id);
    assert(count && count.n < MAX_SIGNALS, 429, "signal_limit", "call signal limit reached");
    ot.run("INSERT INTO ot_call_signals(call_id,sender,recipient,client_key,payload) VALUES(?,?,?,?,?)",
      call.id, peer.id, to, key, JSON.stringify(signalPayload(input)));
    return {sent: true};
  });

  app.post(root + "/leave", async req => {
    const input = body(req);
    const {me, conversation} = callContext(ot, req, input.team_id);
    if (typeof input.peer_id === "string" && typeof input.call_id === "string") {
      ot.run(`DELETE FROM ot_call_peers WHERE id=? AND owner_id=? AND call_id IN
        (SELECT id FROM ot_live_calls WHERE id=? AND conversation_id=?)`, input.peer_id, me.ownerId, input.call_id, conversation.id);
    }
    prune(ot, conversation.id);
    return {left: true};
  });
}
