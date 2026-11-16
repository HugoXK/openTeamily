"""Workspace agent directory (issue #6, directory slice).

Self-written for OpenTeamily; no upstream or Teamily source. Teamily's
create flow and Auto / Instant / Agentic mode differences were not fully
observed, so this slice does not invent modes, public homepages, or embed
routes. These records live in the management database only: the management
process does not run agents. Container execution and Teamily comparison
remain later slices and must not be claimed from these tests.
"""
import re

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_agents (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 summary TEXT NOT NULL,
 instructions TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, name_hash));
CREATE INDEX IF NOT EXISTS workspace_agent_list ON workspace_agents(workspace_id, archived, id);
'''

NAME_MAX = 80
SUMMARY_MAX = 500
INSTRUCTIONS_MAX = 16000
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= NAME_MAX and not CONTROL.search(value)


def valid_summary(value):
    return isinstance(value, str) and len(value) <= SUMMARY_MAX and not CONTROL.search(value)


def valid_instructions(value):
    return (isinstance(value, str) and len(value) <= INSTRUCTIONS_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def name_hash(name):
    return digest(name.strip().casefold())


def view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'name', 'summary', 'instructions', 'revision',
        'created', 'updated', 'created_by', 'archived')}


def can_manage(actor):
    return actor in ('owner', 'admin')


def load(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agents WHERE id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, include_archived):
    clause = 'archived IN (0, 1)' if include_archived else 'archived=0'
    return db.execute(
        'SELECT * FROM workspace_agents WHERE workspace_id=? AND ' + clause +
        ' AND id>? ORDER BY id LIMIT ?',
        (workspace_id, cursor, limit),
    ).fetchall()
