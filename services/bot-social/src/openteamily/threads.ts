// Cross-user threaded replies on shared messenger conversations (ported from the legacy
// threads.py slice). Bot Social stores only the shared thread state; the caller authorizes
// workspace/conversation membership through the messenger route helpers. Soft deletion keeps
// an audit row while removing it from views, reply counts and unread counts. Unread means
// visible replies by other members newer than the viewer's read cursor.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, intParam, one, params, query, text, type OtContext } from "./core.js";
import { accountConversation, workspaceConversation } from "./messenger.js";

export const THREADS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_message_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  root_message_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  title TEXT,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, root_message_id)
);
CREATE INDEX IF NOT EXISTS ot_message_threads_page ON ot_message_threads(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS ot_message_threads_root ON ot_message_threads(conversation_id, root_message_id);
CREATE INDEX IF NOT EXISTS ot_message_threads_resolved ON ot_message_threads(conversation_id, resolved, created_at, id);
CREATE TABLE IF NOT EXISTS ot_thread_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES ot_message_threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX IF NOT EXISTS ot_thread_replies_page ON ot_thread_replies(thread_id, created_at, id);
CREATE INDEX IF NOT EXISTS ot_thread_replies_workspace ON ot_thread_replies(workspace_id, thread_id, created_at, id);
CREATE TABLE IF NOT EXISTS ot_thread_reads (
  thread_id TEXT NOT NULL REFERENCES ot_message_threads(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  last_read INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, owner_id)
);
CREATE INDEX IF NOT EXISTS ot_thread_reads_owner ON ot_thread_reads(owner_id, updated_at);
`;

export const TITLE_MAX = 80;
export const BODY_MAX = 4000;
export const PAGE_MAX = 100;
export const DEFAULT_LIMIT = 50;

// Replies written before any read cursor are unread. Use the smallest SQLite integer
// rather than 0 so a zero/epoch clock still works.
const UNREAD_START = "-9223372036854775808";

type ThreadScope = { workspace: string; conversation: any };
type ThreadRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  root_message_id: string;
  created_by: string;
  title: string | null;
  resolved: number;
  created_at: number;
  updated_at: number;
};
type ReplyRow = {
  id: string;
  thread_id: string;
  workspace_id: string;
  author_id: string;
  body: string;
  created_at: number;
  deleted: number;
};
type ReadRow = { thread_id: string; owner_id: string; last_read: number; updated_at: number };

const IDENTIFIER_CONTROL = /[\u0000-\u001f\u007f]/;

function identifier(value: unknown, name: string): string {
  assert(typeof value === "string" && value.length > 0 && value.length <= 200 && !IDENTIFIER_CONTROL.test(value),
    400, "invalid_request", `${name} must be a non-empty bounded string`);
  return value;
}

function pageLimit(raw: unknown): number {
  if (typeof raw === "number") {
    assert(Number.isSafeInteger(raw) && raw > 0, 400, "invalid_request", "limit must be a positive integer");
    return Math.min(raw, PAGE_MAX);
  }
  const limit = intParam(raw, "limit", DEFAULT_LIMIT, PAGE_MAX);
  assert(limit > 0, 400, "invalid_request", "limit must be a positive integer");
  return limit;
}

function scopeFor(ot: OtContext, owner: string, workspace: string | undefined, conversationId: string): ThreadScope {
  const conv = workspace !== undefined
    ? workspaceConversation(ot, workspace, conversationId, owner).conv
    : accountConversation(ot, conversationId, owner);
  // A team conversation belongs to its team's workspace. A DM or personal group has no
  // workspace, so its threads stay under the empty scope even when reached through a team.
  const team = conv.team_id
    ? ot.get<{ workspace_id: string }>("SELECT workspace_id FROM ot_teams WHERE id = ?", conv.team_id)
    : undefined;
  return { workspace: team?.workspace_id ?? "", conversation: conv };
}

function threadRowView(row: ThreadRow, replyCount: number, unread: number) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    conversation_id: row.conversation_id,
    root_message_id: row.root_message_id,
    created_by: row.created_by,
    title: row.title,
    resolved: Boolean(row.resolved),
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Port aliases: the legacy threads module named these `created` and `updated`.
    created: row.created_at,
    updated: row.updated_at,
    reply_count: replyCount,
    unread,
  };
}

function replyView(row: ReplyRow) {
  return {
    id: row.id,
    thread_id: row.thread_id,
    workspace_id: row.workspace_id,
    author_id: row.author_id,
    body: row.body,
    created_at: row.created_at,
    created: row.created_at,
    deleted: Boolean(row.deleted),
  };
}

function loadThread(ot: OtContext, scope: ThreadScope, threadId: string): ThreadRow | undefined {
  identifier(threadId, "thread_id");
  return ot.get<ThreadRow>(
    "SELECT * FROM ot_message_threads WHERE id = ? AND conversation_id = ? AND workspace_id = ?",
    threadId, scope.conversation.id, scope.workspace,
  );
}

function requireThread(ot: OtContext, scope: ThreadScope, threadId: string): ThreadRow {
  const row = loadThread(ot, scope, threadId);
  assert(row, 404, "thread_not_found", "no such thread in this conversation");
  return row;
}

function replyCount(ot: OtContext, scope: ThreadScope, threadId: string): number {
  return ot.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM ot_thread_replies WHERE thread_id = ? AND workspace_id = ? AND deleted = 0",
    threadId, scope.workspace,
  )!.n;
}

function unreadCount(ot: OtContext, scope: ThreadScope, threadId: string, viewer: string): number {
  return ot.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ot_thread_replies r
      WHERE r.thread_id = ? AND r.workspace_id = ? AND r.deleted = 0 AND r.author_id <> ?
        AND r.created_at > COALESCE(
          (SELECT last_read FROM ot_thread_reads WHERE thread_id = ? AND owner_id = ?), ${UNREAD_START})`,
    threadId, scope.workspace, viewer, threadId, viewer,
  )!.n;
}

export function createThread(ot: OtContext, scope: ThreadScope, createdBy: string, input: Record<string, unknown>, now: number) {
  const rootMessageId = identifier(input.root_message_id, "root_message_id");
  const title = input.title === undefined || input.title === null
    ? null
    : text(input.title, "title", { min: 1, max: TITLE_MAX });
  const existing = ot.get(
    "SELECT 1 FROM ot_message_threads WHERE conversation_id = ? AND root_message_id = ?",
    scope.conversation.id, rootMessageId,
  );
  assert(!existing, 409, "thread_exists", "a thread already exists for that root message");
  const id = newId("otmt");
  try {
    ot.run(
      `INSERT INTO ot_message_threads(id, workspace_id, conversation_id, root_message_id, created_by,
        title, resolved, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, scope.workspace, scope.conversation.id, rootMessageId, createdBy, title, 0, now, now,
    );
  } catch (error) {
    if (typeof (error as { code?: unknown })?.code === "string"
        && (error as { code: string }).code.startsWith("SQLITE_CONSTRAINT")) {
      assert(false, 409, "thread_exists", "a thread already exists for that root message");
    }
    throw error;
  }
  return threadRowView(
    ot.get<ThreadRow>("SELECT * FROM ot_message_threads WHERE id = ?", id)!,
    0, 0,
  );
}

export function addReply(
  ot: OtContext, scope: ThreadScope, threadId: string, authorId: string, input: Record<string, unknown>, now: number,
) {
  const thread = requireThread(ot, scope, threadId);
  const message = text(input.body, "body", { min: 1, max: BODY_MAX, multiline: true });
  const id = newId("otmr");
  ot.run(
    `INSERT INTO ot_thread_replies(id, thread_id, workspace_id, author_id, body, created_at, deleted)
      VALUES (?,?,?,?,?,?,0)`,
    id, thread.id, scope.workspace, authorId, message, now,
  );
  ot.run(
    "UPDATE ot_message_threads SET updated_at = MAX(updated_at, ?) WHERE id = ? AND workspace_id = ?",
    now, thread.id, scope.workspace,
  );
  return replyView(ot.get<ReplyRow>("SELECT * FROM ot_thread_replies WHERE id = ? AND workspace_id = ?", id, scope.workspace)!);
}

export function listThreads(
  ot: OtContext, scope: ThreadScope, viewer: string,
  { includeResolved = true, limit = DEFAULT_LIMIT, cursor }: { includeResolved?: boolean; limit?: number; cursor?: string } = {},
) {
  const page = pageLimit(limit);
  let where = "workspace_id = ? AND conversation_id = ?";
  const args: unknown[] = [scope.workspace, scope.conversation.id];
  if (!includeResolved) where += " AND resolved = 0";
  if (cursor !== undefined) {
    identifier(cursor, "cursor");
    const current = ot.get<{ created_at: number; id: string }>(
      "SELECT created_at, id FROM ot_message_threads WHERE id = ? AND conversation_id = ? AND workspace_id = ?",
      cursor, scope.conversation.id, scope.workspace,
    );
    if (!current) return [];
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    args.push(current.created_at, current.created_at, current.id);
  }
  const rows = ot.all<ThreadRow>(
    `SELECT * FROM ot_message_threads WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...args, page,
  );
  return rows.map((row) => threadRowView(row, replyCount(ot, scope, row.id), unreadCount(ot, scope, row.id, viewer)));
}

export function threadView(
  ot: OtContext, scope: ThreadScope, threadId: string, viewer: string,
  { limit = DEFAULT_LIMIT, cursor }: { limit?: number; cursor?: string } = {},
) {
  const page = pageLimit(limit);
  const thread = loadThread(ot, scope, threadId);
  if (!thread) return undefined;
  let where = "thread_id = ? AND workspace_id = ? AND deleted = 0";
  const args: unknown[] = [thread.id, scope.workspace];
  if (cursor !== undefined) {
    identifier(cursor, "cursor");
    const current = ot.get<{ created_at: number; id: string }>(
      "SELECT created_at, id FROM ot_thread_replies WHERE id = ? AND thread_id = ? AND workspace_id = ?",
      cursor, thread.id, scope.workspace,
    );
    if (!current) return undefined;
    where += " AND (created_at > ? OR (created_at = ? AND id > ?))";
    args.push(current.created_at, current.created_at, current.id);
  }
  const replies = ot.all<ReplyRow>(
    `SELECT * FROM ot_thread_replies WHERE ${where} ORDER BY created_at ASC, id ASC LIMIT ?`,
    ...args, page,
  );
  const unread = unreadCount(ot, scope, thread.id, viewer);
  return {
    thread: threadRowView(thread, replyCount(ot, scope, thread.id), unread),
    replies: replies.map(replyView),
    unread,
  };
}

export function markRead(ot: OtContext, scope: ThreadScope, threadId: string, userId: string, now: number) {
  const thread = loadThread(ot, scope, threadId);
  if (!thread) return undefined;
  ot.run(
    `INSERT INTO ot_thread_reads(thread_id, owner_id, last_read, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(thread_id, owner_id) DO UPDATE SET
        last_read = MAX(last_read, excluded.last_read),
        updated_at = MAX(updated_at, excluded.updated_at)`,
    thread.id, userId, now, now,
  );
  const state = ot.get<ReadRow>("SELECT * FROM ot_thread_reads WHERE thread_id = ? AND owner_id = ?", thread.id, userId)!;
  return {
    thread_id: state.thread_id,
    user_id: state.owner_id,
    last_read: state.last_read,
    updated_at: state.updated_at,
    updated: state.updated_at,
    unread: unreadCount(ot, scope, thread.id, userId),
  };
}

export function resolveThread(ot: OtContext, scope: ThreadScope, threadId: string, now: number, resolved = true) {
  const thread = loadThread(ot, scope, threadId);
  if (!thread) return undefined;
  ot.run(
    "UPDATE ot_message_threads SET resolved = ?, updated_at = MAX(updated_at, ?) WHERE id = ? AND workspace_id = ?",
    resolved ? 1 : 0, now, thread.id, scope.workspace,
  );
  const row = ot.get<ThreadRow>("SELECT * FROM ot_message_threads WHERE id = ? AND workspace_id = ?", thread.id, scope.workspace)!;
  return threadRowView(row, replyCount(ot, scope, row.id), unreadCount(ot, scope, row.id, row.created_by));
}

export function deleteReply(
  ot: OtContext, scope: ThreadScope, threadId: string, replyId: string, authorId: string, now: number,
) {
  const thread = loadThread(ot, scope, threadId);
  if (!thread) return "missing" as const;
  identifier(replyId, "reply_id");
  const reply = ot.get<ReplyRow>(
    "SELECT * FROM ot_thread_replies WHERE id = ? AND thread_id = ? AND workspace_id = ?",
    replyId, thread.id, scope.workspace,
  );
  if (!reply) return "missing" as const;
  if (reply.author_id !== authorId) return "forbidden" as const;
  if (!reply.deleted) {
    ot.run(
      "UPDATE ot_thread_replies SET deleted = 1 WHERE id = ? AND thread_id = ? AND workspace_id = ? AND author_id = ?",
      reply.id, thread.id, scope.workspace, authorId,
    );
    ot.run(
      "UPDATE ot_message_threads SET updated_at = MAX(updated_at, ?) WHERE id = ? AND workspace_id = ?",
      now, thread.id, scope.workspace,
    );
  }
  return "deleted" as const;
}

function readBoolean(raw: unknown, name: string, fallback: boolean): boolean {
  const value = one(raw, name);
  if (value === undefined || value === "") return fallback;
  assert(value === "1" || value === "0" || value === "true" || value === "false",
    400, "invalid_request", `${name} must be true or false`);
  return value === "1" || value === "true";
}

function registerThreadRoutes(app: FastifyInstance, ot: OtContext, scoped: boolean) {
  const base = scoped
    ? "/v1/ot/workspaces/:workspace/conversations/:id/threads"
    : "/v1/ot/conversations/:id/threads";
  const scope = (req: any, owner: string) => scopeFor(
    ot,
    owner,
    scoped ? params(req).workspace : undefined,
    identifier(params(req).id, "conversation_id"),
  );
  const threadId = (req: any) => identifier(params(req).thread_id, "thread_id");

  app.post(base, async (req, reply) => {
    const me = ot.me(req);
    const result = ot.tx(() => createThread(ot, scope(req, me.ownerId), me.ownerId, body(req), ot.now()));
    return reply.status(201).send(result);
  });

  app.get(base, async (req) => {
    const me = ot.me(req);
    const q = query(req);
    return listThreads(ot, scope(req, me.ownerId), me.ownerId, {
      includeResolved: readBoolean(q.include_resolved, "include_resolved", true),
      limit: pageLimit(q.limit),
      cursor: one(q.cursor, "cursor"),
    });
  });

  app.get(base + "/:thread_id", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const view = threadView(ot, scope(req, me.ownerId), threadId(req), me.ownerId, {
      limit: pageLimit(q.limit),
      cursor: one(q.cursor, "cursor"),
    });
    assert(view, 404, "thread_not_found", "no such thread in this conversation");
    return view;
  });

  app.post(base + "/:thread_id/replies", async (req, reply) => {
    const me = ot.me(req);
    const result = ot.tx(() => addReply(ot, scope(req, me.ownerId), threadId(req), me.ownerId, body(req), ot.now()));
    return reply.status(201).send(result);
  });

  app.post(base + "/:thread_id/read", async (req) => {
    const me = ot.me(req);
    const input = body(req);
    assert(Object.keys(input).every((key) => key === "last_read"), 400, "invalid_request", "unknown read fields");
    const now = ot.now();
    assert(input.last_read === undefined || (Number.isSafeInteger(input.last_read) && input.last_read >= 0
      && input.last_read <= now), 400, "invalid_request", "last_read must be a current timestamp");
    const state = ot.tx(() => markRead(ot, scope(req, me.ownerId), threadId(req), me.ownerId, input.last_read ?? now));
    assert(state, 404, "thread_not_found", "no such thread in this conversation");
    return state;
  });

  app.post(base + "/:thread_id/resolve", async (req) => {
    const me = ot.me(req);
    const input = body(req);
    assert(Object.keys(input).every((key) => key === "resolved"), 400, "invalid_request", "unknown resolve fields");
    assert(input.resolved === undefined || typeof input.resolved === "boolean",
      400, "invalid_request", "resolved must be a boolean");
    const thread = ot.tx(() => resolveThread(
      ot, scope(req, me.ownerId), threadId(req), ot.now(), input.resolved !== false,
    ));
    assert(thread, 404, "thread_not_found", "no such thread in this conversation");
    return thread;
  });

  app.delete(base + "/:thread_id/replies/:reply_id", async (req) => {
    const me = ot.me(req);
    const result = ot.tx(() => deleteReply(
      ot, scope(req, me.ownerId), threadId(req), identifier(params(req).reply_id, "reply_id"), me.ownerId, ot.now(),
    ));
    assert(result !== "missing", 404, "reply_not_found", "no such reply in this thread");
    assert(result !== "forbidden", 403, "forbidden", "only the reply author can delete it");
    return { deleted: true };
  });
}

export function registerThreads(app: FastifyInstance, ot: OtContext) {
  registerThreadRoutes(app, ot, true);
  registerThreadRoutes(app, ot, false);
}
