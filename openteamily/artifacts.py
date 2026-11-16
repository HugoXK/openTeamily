"""Workspace document artifacts (issue #9, first slice).

Self-written for OpenTeamily; no upstream or Teamily source, fonts or
marketing copy. This slice stores permission-scoped documents only. It is
not a works library parity claim, not a website or whiteboard builder, and
not browser E2E acceptance.
"""
import re

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('document')),
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
CREATE INDEX IF NOT EXISTS artifact_workspace ON artifacts(workspace_id, id);
'''

KINDS = ('document',)
TITLE_MAX = 80
BODY_MAX = 8000


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
        'kind': row['kind'],
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


def load(db, workspace_id, artifact_id):
    return db.execute(
        'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username '
        'FROM artifacts a '
        'JOIN users cu ON cu.id=a.created_by '
        'JOIN users uu ON uu.id=a.updated_by '
        'WHERE a.id=? AND a.workspace_id=?',
        (artifact_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username '
        'FROM artifacts a '
        'JOIN users cu ON cu.id=a.created_by '
        'JOIN users uu ON uu.id=a.updated_by '
        'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]
