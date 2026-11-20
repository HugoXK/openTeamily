"""Threaded annotations on workspace artifacts.

Self-written for OpenTeamily; no upstream or Teamily source. This module is
local annotation storage only: threads are pinned to an artifact revision and
can be resolved, and comments are soft-deleted by their author. The caller is
responsible for authorizing membership, workspace access, and access to the
artifact before calling these functions. There is no HTTP route, browser UI,
push delivery, real-time/live collaboration, or Teamily parity claim here.
"""
import json
import re
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS annotation_threads (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL,
 artifact_revision INTEGER NOT NULL CHECK(artifact_revision >= 0),
 anchor TEXT,
 resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
 created_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS annotation_thread_artifact
 ON annotation_threads(workspace_id, artifact_id, id);
CREATE INDEX IF NOT EXISTS annotation_thread_open
 ON annotation_threads(workspace_id, artifact_id, resolved, id);
CREATE INDEX IF NOT EXISTS annotation_thread_revision
 ON annotation_threads(workspace_id, artifact_id, artifact_revision, id);
CREATE TABLE IF NOT EXISTS annotation_comments (
 id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL REFERENCES annotation_threads(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL,
 mentions TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS annotation_comment_thread
 ON annotation_comments(workspace_id, thread_id, deleted, id);
CREATE INDEX IF NOT EXISTS annotation_comment_author
 ON annotation_comments(workspace_id, author_id, id);
'''

BODY_MAX = 4000
ANCHOR_MAX = 1000
MAX_MENTIONS = 20
LIMIT = 50
MAX_LIMIT = 100

# Usernames follow the account rule in app.py: 3-64 characters, starting with
# an alphanumeric character. A mention must not be part of an e-mail address or
# another word, and trailing sentence punctuation is not part of the username.
USERNAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}')
MENTION = re.compile(r'(?<![\w@.])@([A-Za-z0-9][A-Za-z0-9_.-]{2,63})(?![\w-])')

THREAD_SELECT = (
    'SELECT t.*, u.username AS created_by_username, '
    '(SELECT COUNT(*) FROM annotation_comments c '
    ' WHERE c.thread_id=t.id AND c.workspace_id=t.workspace_id AND c.deleted=0) AS comment_count '
    'FROM annotation_threads t JOIN users u ON u.id=t.created_by '
)
COMMENT_SELECT = (
    'SELECT c.*, u.username AS author_username '
    'FROM annotation_comments c JOIN users u ON u.id=c.author_id '
)


def ensure_schema(db):
    """Create annotation tables and indexes if they are not present yet."""
    db.executescript(SCHEMA)


def valid_revision(value):
    return type(value) is int and value >= 0


def _check_revision(value):
    if not valid_revision(value):
        raise ValueError('artifact revision must be a non-negative integer')


def _text(value, name, limit, required=False):
    if value is None:
        if required:
            raise ValueError(name + ' is required')
        return None
    if not isinstance(value, str):
        raise ValueError(name + ' must be text')
    if len(value) > limit:
        raise ValueError(name + ' exceeds its bound')
    if '\x00' in value or any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value):
        raise ValueError(name + ' contains control characters')
    if required and not value.strip():
        raise ValueError(name + ' is required')
    return value


def _validate_body(body):
    return _text(body, 'body', BODY_MAX, required=True)


def extract_mentions(body):
    """Return distinct, canonical usernames from @mentions, in first-seen order."""
    names = []
    seen = set()
    for match in MENTION.finditer(body or ''):
        name = match.group(1).rstrip('.').lower()
        if not USERNAME.fullmatch(name) or name in seen:
            continue
        seen.add(name)
        names.append(name)
        if len(names) >= MAX_MENTIONS:
            break
    return names


def _mentions_text(names):
    return json.dumps(names, ensure_ascii=True, separators=(',', ':'))


def _decode_mentions(raw):
    try:
        value = json.loads(raw or '[]')
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [name for name in value if isinstance(name, str) and USERNAME.fullmatch(name)][:MAX_MENTIONS]


def _limit(value):
    if value is None:
        return LIMIT
    if type(value) is not int or value < 1:
        raise ValueError('limit must be a positive integer')
    return min(value, MAX_LIMIT)


def _thread_row(db, workspace_id, thread_id):
    return db.execute(
        THREAD_SELECT + 'WHERE t.id=? AND t.workspace_id=?',
        (thread_id, workspace_id),
    ).fetchone()


def _comment_row(db, workspace_id, comment_id):
    return db.execute(
        COMMENT_SELECT + 'WHERE c.id=? AND c.workspace_id=?',
        (comment_id, workspace_id),
    ).fetchone()


def _comment_view(row):
    return {
        'id': row['id'],
        'thread_id': row['thread_id'],
        'workspace_id': row['workspace_id'],
        'author_id': row['author_id'],
        'author_username': row['author_username'],
        'body': row['body'],
        'mentions': _decode_mentions(row['mentions']),
        'created': row['created'],
        'updated': row['updated'],
        'deleted': bool(row['deleted']),
    }


def _thread_view(row, comments=None):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'artifact_id': row['artifact_id'],
        'artifact_revision': row['artifact_revision'],
        'anchor': row['anchor'],
        'resolved': bool(row['resolved']),
        'created_by': row['created_by'],
        'created_by_username': row['created_by_username'],
        'created': row['created'],
        'updated': row['updated'],
        'comment_count': row['comment_count'],
    }
    if comments is not None:
        data['comments'] = comments
    return data


def create_thread(db, workspace_id, artifact_id, artifact_revision, created_by, now,
                  anchor=None, body=None):
    _check_revision(artifact_revision)
    anchor = _text(anchor, 'anchor', ANCHOR_MAX)
    if body is not None:
        _validate_body(body)
    thread_id = uuid4().hex
    db.execute(
        'INSERT INTO annotation_threads '
        '(id,workspace_id,artifact_id,artifact_revision,anchor,resolved,created_by,created,updated) '
        'VALUES(?,?,?,?,?,0,?,?,?)',
        (thread_id, workspace_id, artifact_id, artifact_revision, anchor, created_by, now, now),
    )
    if body is not None:
        add_comment(db, workspace_id, thread_id, created_by, body, now)
    return thread_view(db, workspace_id, thread_id)


def list_threads(db, workspace_id, artifact_id, revision=None, resolved=None,
                 limit=LIMIT, cursor=None):
    if revision is not None:
        _check_revision(revision)
    limit = _limit(limit)
    if cursor is not None and not isinstance(cursor, str):
        raise ValueError('cursor must be a thread id')
    sql = THREAD_SELECT + 'WHERE t.workspace_id=? AND t.artifact_id=?'
    args = [workspace_id, artifact_id]
    if revision is not None:
        sql += ' AND t.artifact_revision=?'
        args.append(revision)
    if resolved is not None:
        sql += ' AND t.resolved=?'
        args.append(1 if resolved else 0)
    if cursor:
        sql += ' AND t.id>?'
        args.append(cursor)
    sql += ' ORDER BY t.id ASC LIMIT ?'
    args.append(limit)
    return [_thread_view(row) for row in db.execute(sql, args).fetchall()]


def add_comment(db, workspace_id, thread_id, author_id, body, now):
    _validate_body(body)
    if _thread_row(db, workspace_id, thread_id) is None:
        raise LookupError('Annotation thread not found')
    mentions = extract_mentions(body)
    comment_id = uuid4().hex
    db.execute(
        'INSERT INTO annotation_comments '
        '(id,thread_id,workspace_id,author_id,body,mentions,created,updated,deleted) '
        'VALUES(?,?,?,?,?,?,?,?,0)',
        (comment_id, thread_id, workspace_id, author_id, body, _mentions_text(mentions), now, now),
    )
    db.execute(
        'UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?',
        (now, thread_id, workspace_id),
    )
    return _comment_view(_comment_row(db, workspace_id, comment_id))


def edit_comment(db, workspace_id, comment_id, author_id, body, now):
    row = _comment_row(db, workspace_id, comment_id)
    if row is None:
        raise LookupError('Annotation comment not found')
    if row['author_id'] != author_id:
        raise PermissionError('Only the comment author may edit it')
    if row['deleted']:
        raise LookupError('Annotation comment was deleted')
    _validate_body(body)
    mentions = extract_mentions(body)
    db.execute(
        'UPDATE annotation_comments SET body=?, mentions=?, updated=? '
        'WHERE id=? AND workspace_id=?',
        (body, _mentions_text(mentions), now, comment_id, workspace_id),
    )
    db.execute(
        'UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?',
        (now, row['thread_id'], workspace_id),
    )
    return _comment_view(_comment_row(db, workspace_id, comment_id))


def delete_comment(db, workspace_id, comment_id, author_id, now):
    row = _comment_row(db, workspace_id, comment_id)
    if row is None:
        raise LookupError('Annotation comment not found')
    if row['author_id'] != author_id:
        raise PermissionError('Only the comment author may delete it')
    db.execute(
        'UPDATE annotation_comments SET deleted=1, updated=? WHERE id=? AND workspace_id=?',
        (now, comment_id, workspace_id),
    )
    db.execute(
        'UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?',
        (now, row['thread_id'], workspace_id),
    )
    return _comment_view(_comment_row(db, workspace_id, comment_id))


def resolve_thread(db, workspace_id, thread_id, now, resolved=True):
    if _thread_row(db, workspace_id, thread_id) is None:
        raise LookupError('Annotation thread not found')
    db.execute(
        'UPDATE annotation_threads SET resolved=?, updated=? WHERE id=? AND workspace_id=?',
        (1 if resolved else 0, now, thread_id, workspace_id),
    )
    return thread_view(db, workspace_id, thread_id)


def thread_view(db, workspace_id, thread_id):
    row = _thread_row(db, workspace_id, thread_id)
    if row is None:
        raise LookupError('Annotation thread not found')
    comments = db.execute(
        COMMENT_SELECT + 'WHERE c.workspace_id=? AND c.thread_id=? AND c.deleted=0 '
        'ORDER BY c.id ASC',
        (workspace_id, thread_id),
    ).fetchall()
    return _thread_view(row, [_comment_view(comment) for comment in comments])


def count_open(db, workspace_id, artifact_id):
    return db.execute(
        'SELECT COUNT(*) FROM annotation_threads '
        'WHERE workspace_id=? AND artifact_id=? AND resolved=0',
        (workspace_id, artifact_id),
    ).fetchone()[0]
