// OpenTeamily shared-state routes on Bot Social. Each area registers its schema and routes here.
import type { FastifyInstance } from "fastify";
import type { Platform } from "../platform.js";
import { CORE_SCHEMA, OtContext, registerCore } from "./core.js";
import { registerTeams, TEAMS_SCHEMA } from "./teams.js";

export const OT_SCHEMAS = [CORE_SCHEMA, TEAMS_SCHEMA];

export function registerOpenTeamily(app: FastifyInstance, platform: Platform) {
  for (const schema of OT_SCHEMAS) platform.db.exec(schema);
  const ot = new OtContext(platform);
  registerCore(app, ot);
  registerTeams(app, ot);
  return ot;
}
