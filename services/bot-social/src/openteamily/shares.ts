// OpenTeamily team-run sharing on Bot Social. The owner's DS-Bot executes the run (features/team-runs);
// this stores only a teammate-visible snapshot (title, goal, status, step summaries) on a team they
// belong to. Private prompts, memory and credentials never come here.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, OtContext, params, text } from "./core.js";
import { requireMember } from "./teams.js";

export const SHARES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_shared_runs (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, run_ref TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (team_id, owner_id, run_ref)
);
CREATE INDEX IF NOT EXISTS ot_shared_runs_team ON ot_shared_runs(team_id, updated_at);
`;

const STATUSES = new Set(["running", "succeeded", "failed", "cancelled"]);
const SNAPSHOT_MAX = 100_000;
const REF = /^[A-Za-z0-9._:-]{1,80}$/;

function view(ot: OtContext, r: any) {
  return {
    id: r.id, team_id: r.team_id, run_ref: r.run_ref, title: r.title, goal: r.goal, status: r.status,
    snapshot: JSON.parse(r.snapshot), owner: ot.profileView(r.owner_id), created_at: r.created_at, updated_at: r.updated_at,
  };
}

function parseSnapshot(raw: unknown) {
  assert(raw !== undefined && raw !== null && typeof raw === "object" && !Array.isArray(raw), 400, "invalid_request", "snapshot must be an object");
  const texted = JSON.stringify(raw);
  assert(texted.length <= SNAPSHOT_MAX, 400, "invalid_request", "snapshot is too large");
  const steps = Array.isArray((raw as any).steps) ? (raw as any).steps.slice(0, 8) : [];
  // Only the teammate-visible fields: status and a short output, never the instruction or raw errors.
  return JSON.stringify({
    progress: (raw as any).progress ?? null,
    steps: steps.map((s: any) => ({
      position: Number(s?.position) || 0,
      agent_name: String(s?.agent_name ?? "").slice(0, 80),
      status: String(s?.status ?? "").slice(0, 20),
      output: String(s?.output ?? "").slice(0, 2000),
    })),
  });
}

export function registerShares(app: FastifyInstance, ot: OtContext) {
  app.put("/v1/ot/teams/:id/shared-runs", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const b = body(req);
    assert(typeof b.run_ref === "string" && REF.test(b.run_ref), 400, "invalid_request", "run_ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const goal = text(b.goal, "goal", { min: 1, max: 2000, multiline: true });
    assert(STATUSES.has(String(b.status)), 400, "invalid_request", "status is invalid");
    const snapshot = parseSnapshot(b.snapshot);
    const now = ot.now();
    const existing = ot.get<any>("SELECT * FROM ot_shared_runs WHERE team_id = ? AND owner_id = ? AND run_ref = ?", team.id, me.ownerId, b.run_ref);
    const id = existing?.id ?? newId("otsr");
    if (existing) {
      ot.run("UPDATE ot_shared_runs SET title = ?, goal = ?, status = ?, snapshot = ?, updated_at = ? WHERE id = ?", title, goal, b.status, snapshot, now, id);
    } else {
      assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_shared_runs WHERE team_id = ? AND owner_id = ?", team.id, me.ownerId).n < 100, 429, "too_many_shares", "share limit reached");
      ot.run("INSERT INTO ot_shared_runs(id, team_id, owner_id, run_ref, title, goal, status, snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, team.id, me.ownerId, b.run_ref, title, goal, b.status, snapshot, now, now);
      for (const m of ot.all<any>("SELECT owner_id FROM ot_team_members WHERE team_id = ? AND suspended = 0 AND owner_id != ?", team.id, me.ownerId)) {
        ot.notify(m.owner_id, "team.run_shared", { team_id: team.id, team_name: team.name, share_id: id, title, owner: ot.profileView(me.ownerId) });
      }
    }
    return view(ot, ot.get("SELECT * FROM ot_shared_runs WHERE id = ?", id));
  });
  app.get("/v1/ot/teams/:id/shared-runs", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    return { runs: ot.all<any>("SELECT * FROM ot_shared_runs WHERE team_id = ? ORDER BY updated_at DESC LIMIT 200", team.id).map((r) => view(ot, r)) };
  });
  app.get("/v1/ot/teams/:id/shared-runs/:share", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const r = ot.get<any>("SELECT * FROM ot_shared_runs WHERE id = ? AND team_id = ?", params(req).share, team.id);
    assert(r, 404, "share_not_found", "no such shared run");
    return view(ot, r);
  });
  app.delete("/v1/ot/teams/:id/shared-runs/:share", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    const r = ot.get<any>("SELECT * FROM ot_shared_runs WHERE id = ? AND team_id = ?", params(req).share, team.id);
    assert(r, 404, "share_not_found", "no such shared run");
    assert(r.owner_id === me.ownerId, 403, "forbidden", "only the owner can unshare this run");
    ot.run("DELETE FROM ot_shared_runs WHERE id = ?", r.id);
    return { unshared: true };
  });
}
