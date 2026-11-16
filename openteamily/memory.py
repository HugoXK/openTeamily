"""Workspace memory pages and next actions (issue 8).

Self-written for OpenTeamily; no upstream, Timeline, Project, or Teamily
source, fonts or marketing copy. Pages and next actions are workspace-scoped,
persisted on create, and can be edited or deleted. This is not a relationship
graph, profile, share/export, or Teamily memory parity, and it is not browser
E2E acceptance.
"""
import re

from .security import digest

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_pages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 body TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS memory_page_workspace ON memory_pages(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_actions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 notes TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'done')),
 due_at INTEGER CHECK(due_at IS NULL OR due_at >= 0),
 memory_page_id TEXT REFERENCES memory_pages(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash));
CREATE INDEX IF NOT EXISTS memory_action_workspace ON memory_actions(workspace_id, status, id);
"""

TITLE_MAX = 80
BODY_MAX = 8000
ROW_SELECT = (
    'SELECT p.*, cu.username AS created_by_username, uu.username AS updated_by_username '
    'FROM memory_pages p '
    'JOIN users cu ON cu.id=p.created_by '
    'JOIN users uu ON uu.id=p.updated_by '
)


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def valid_body(value):
    return isinstance(value, str) and len(value) <= BODY_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def title_hash(title):
    return digest(title.strip().casefold())


def view(row, include_body=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_body:
        data['body'] = row['body']
    return data


def can_edit(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def load(db, workspace_id, page_id):
    return db.execute(
        ROW_SELECT + 'WHERE p.id=? AND p.workspace_id=?',
        (page_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        ROW_SELECT + 'WHERE p.workspace_id=? ORDER BY p.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]

NOTES_MAX = 2000
ACTION_STATUSES = ('open', 'done')
ACTION_ROW_SELECT = (
    'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username, '
    'mp.title AS memory_page_title '
    'FROM memory_actions a '
    'JOIN users cu ON cu.id=a.created_by '
    'JOIN users uu ON uu.id=a.updated_by '
    'LEFT JOIN memory_pages mp ON mp.id=a.memory_page_id '
)


def valid_notes(value):
    return isinstance(value, str) and len(value) <= NOTES_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def valid_status(value):
    return value in ACTION_STATUSES


def valid_due_at(value):
    return value is None or (type(value) is int and 0 <= value <= 2 ** 31)


def valid_page_ref(value):
    return value is None or (isinstance(value, str) and bool(re.fullmatch(r'[0-9a-f]{32}', value)))


def action_view(row, include_notes=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'status': row['status'],
        'due_at': row['due_at'],
        'memory_page_id': row['memory_page_id'],
        'memory_page_title': row['memory_page_title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_notes:
        data['notes'] = row['notes']
    return data


def load_action(db, workspace_id, action_id):
    return db.execute(
        ACTION_ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?',
        (action_id, workspace_id),
    ).fetchone()


def action_listing(db, workspace_id, cursor, limit, needle='', status=''):
    rows = db.execute(
        ACTION_ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if status:
        rows = [row for row in rows if row['status'] == status]
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]
