"""Local user blocking, content reports and a moderation queue.

Self-written for OpenTeamily; no upstream or Teamily source. This module stores
blocks and reports in the private management SQLite database and exposes only
Python helpers: it does not add HTTP routes, UI, notifications, automatic
content classification, or enforcement in social/discover delivery. The caller
must authorize the reporter and the reviewer, verify that the target belongs to
the claimed workspace, and decide whether a block or report should affect any
other feature. Blocks are global per user pair; reports are scoped to one
workspace. There is no Teamily parity claim for moderation.
"""
import re
import sqlite3
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_blocks (
 blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(blocker_id, blocked_id),
 CHECK(blocker_id<>blocked_id));
CREATE INDEX IF NOT EXISTS user_block_blocked
 ON user_blocks(blocked_id, blocker_id);
CREATE TABLE IF NOT EXISTS content_reports (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_type TEXT NOT NULL CHECK(target_type IN ('message','work','agent','user','comment')),
 target_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','reviewed','actioned','dismissed')),
 reviewer_id TEXT REFERENCES users(id),
 resolution TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS content_report_open
 ON content_reports(reporter_id, workspace_id, target_type, target_id)
 WHERE status='pending';
CREATE INDEX IF NOT EXISTS content_report_queue
 ON content_reports(workspace_id, status, id);
CREATE INDEX IF NOT EXISTS content_report_target
 ON content_reports(workspace_id, target_type, target_id, id);
CREATE TABLE IF NOT EXISTS moderation_actions (
 id TEXT PRIMARY KEY,
 report_id TEXT NOT NULL REFERENCES content_reports(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS moderation_action_report
 ON moderation_actions(report_id, created, id);
'''

TARGET_TYPES = ('message', 'work', 'agent', 'user', 'comment')
# A self-chosen vocabulary. Callers should present these labels; the store does
# not attempt to infer a reason from the content.
REASONS = frozenset((
    'spam', 'scam', 'fraud', 'phishing', 'malware',
    'harassment', 'harass', 'abuse', 'bullying', 'threat', 'threats',
    'hate', 'hate_speech', 'hate-speech', 'offensive', 'inappropriate', 'rude',
    'violence', 'graphic', 'dangerous', 'terrorism', 'weapons', 'drugs',
    'sexual', 'sexual_content', 'nudity', 'adult', 'porn', 'obscenity',
    'self_harm', 'self-harm', 'child_safety', 'csam',
    'misinformation', 'disinformation', 'misleading',
    'impersonation', 'privacy', 'doxxing', 'defamation',
    'copyright', 'illegal', 'unwanted', 'other',
))
STATUSES = ('pending', 'reviewed', 'actioned', 'dismissed')
TERMINAL_STATUSES = ('reviewed', 'actioned', 'dismissed')
DETAILS_MAX = 4000
RESOLUTION_MAX = 2000
ACTION_MAX = 120
IDENTIFIER_MAX = 128
TARGET_ID_MAX = 200
REASON_MAX = 64
LIMIT = 50
MAX_LIMIT = 100

# Friendly aliases for callers that name their bounds explicitly.
MAX_DETAILS = DETAILS_MAX
MAX_RESOLUTION = RESOLUTION_MAX

_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def ensure_schema(db):
    """Create the moderation tables and indexes if they do not already exist."""
    db.executescript(SCHEMA)


def _text(value, name, limit, required=True):
    if value is None:
        if required:
            raise ValueError(name + ' is required')
        return ''
    if not isinstance(value, str):
        raise ValueError(name + ' must be text')
    if len(value) > limit:
        raise ValueError(name + ' exceeds its bound')
    if _CONTROL.search(value):
        raise ValueError(name + ' contains control characters')
    if required and not value.strip():
        raise ValueError(name + ' is required')
    return value


def _integer(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(name + ' must be a non-negative integer')
    return value


def _identifier(value, name):
    return _text(value, name, IDENTIFIER_MAX)


def _target_type(value):
    value = _text(value, 'target_type', 16)
    if value not in TARGET_TYPES:
        raise ValueError('target_type must be one of: ' + ', '.join(TARGET_TYPES))
    return value


def _reason(value):
    value = _text(value, 'reason', REASON_MAX)
    if value not in REASONS:
        raise ValueError('reason is not recognized')
    return value


def _status(value):
    value = _text(value, 'status', 16)
    if value not in STATUSES:
        raise ValueError('status must be one of: ' + ', '.join(STATUSES))
    return value


def _limit(value):
    if type(value) is not int or not 1 <= value <= MAX_LIMIT:
        raise ValueError('limit must be an integer from 1 to %d' % MAX_LIMIT)
    return value


def _block_view(row):
    return {
        'blocker_id': row['blocker_id'],
        'blocked_id': row['blocked_id'],
        'created': row['created'],
    }


def _report_view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'reporter_id': row['reporter_id'],
        'target_type': row['target_type'],
        'target_id': row['target_id'],
        'reason': row['reason'],
        'details': row['details'],
        'status': row['status'],
        'reviewer_id': row['reviewer_id'],
        'resolution': row['resolution'],
        'created': row['created'],
        'updated': row['updated'],
    }


def block(db, blocker_id, blocked_id, now):
    """Block a user globally for this blocker. Repeating the call keeps the first row."""
    _identifier(blocker_id, 'blocker_id')
    _identifier(blocked_id, 'blocked_id')
    _integer(now, 'now')
    if blocker_id == blocked_id:
        raise ValueError('a user cannot block themselves')
    db.execute(
        'INSERT OR IGNORE INTO user_blocks(blocker_id, blocked_id, created) VALUES(?,?,?)',
        (blocker_id, blocked_id, now),
    )
    row = db.execute(
        'SELECT * FROM user_blocks WHERE blocker_id=? AND blocked_id=?',
        (blocker_id, blocked_id),
    ).fetchone()
    return _block_view(row)


def unblock(db, blocker_id, blocked_id):
    """Remove one block; return True when a row was actually deleted."""
    _identifier(blocker_id, 'blocker_id')
    _identifier(blocked_id, 'blocked_id')
    cursor = db.execute(
        'DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?',
        (blocker_id, blocked_id),
    )
    return cursor.rowcount > 0


def is_blocked(db, blocker_id, blocked_id):
    """Whether blocker_id currently blocks blocked_id (the relation is directional)."""
    _identifier(blocker_id, 'blocker_id')
    _identifier(blocked_id, 'blocked_id')
    return db.execute(
        'SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?',
        (blocker_id, blocked_id),
    ).fetchone() is not None


def list_blocks(db, blocker_id):
    """Return the blocker's blocked users, most recently added first."""
    _identifier(blocker_id, 'blocker_id')
    rows = db.execute(
        'SELECT * FROM user_blocks WHERE blocker_id=? ORDER BY created DESC, blocked_id ASC',
        (blocker_id,),
    ).fetchall()
    return [_block_view(row) for row in rows]


def _open_report(db, workspace_id, reporter_id, target_type, target_id):
    return db.execute(
        "SELECT * FROM content_reports WHERE workspace_id=? AND reporter_id=? "
        "AND target_type=? AND target_id=? AND status='pending' ORDER BY id LIMIT 1",
        (workspace_id, reporter_id, target_type, target_id),
    ).fetchone()


def report_content(db, workspace_id, reporter_id, target_type, target_id, reason, now,
                   details=None):
    """Create a pending report, or return the reporter's existing pending report.

    The target is stored as an opaque id; the caller must confirm that it exists
    in the workspace and that the reporter may see it. Details are bounded text,
    never interpreted or classified by this module.
    """
    _identifier(workspace_id, 'workspace_id')
    _identifier(reporter_id, 'reporter_id')
    target_type = _target_type(target_type)
    target_id = _text(target_id, 'target_id', TARGET_ID_MAX)
    reason = _reason(reason)
    details = _text(details, 'details', DETAILS_MAX, required=False)
    _integer(now, 'now')
    existing = _open_report(db, workspace_id, reporter_id, target_type, target_id)
    if existing is not None:
        return _report_view(existing)
    report_id = uuid4().hex
    try:
        db.execute(
            'INSERT INTO content_reports '
            '(id, workspace_id, reporter_id, target_type, target_id, reason, details, '
            'status, reviewer_id, resolution, created, updated) '
            "VALUES(?,?,?,?,?,?,?,'pending',NULL,'',?,?)",
            (report_id, workspace_id, reporter_id, target_type, target_id, reason,
             details, now, now),
        )
    except sqlite3.IntegrityError:
        # The partial unique index closes the concurrent-create race; return the
        # winner instead of surfacing a duplicate as an error.
        existing = _open_report(db, workspace_id, reporter_id, target_type, target_id)
        if existing is not None:
            return _report_view(existing)
        raise
    return get_report(db, workspace_id, report_id)


def list_reports(db, workspace_id, status=None, limit=LIMIT, cursor=None):
    """Return one workspace's reports ordered by id, optionally filtered by status."""
    _identifier(workspace_id, 'workspace_id')
    limit = _limit(limit)
    sql = 'SELECT * FROM content_reports WHERE workspace_id=?'
    parameters = [workspace_id]
    if status is not None:
        sql += ' AND status=?'
        parameters.append(_status(status))
    if cursor is not None:
        if not isinstance(cursor, str):
            raise ValueError('cursor must be a report id')
        if cursor:
            sql += ' AND id>?'
            parameters.append(cursor)
    sql += ' ORDER BY id ASC LIMIT ?'
    parameters.append(limit)
    rows = db.execute(sql, parameters).fetchall()
    return [_report_view(row) for row in rows]


def get_report(db, workspace_id, report_id):
    """Return one report in the workspace, or None when absent or cross-workspace."""
    _identifier(workspace_id, 'workspace_id')
    report_id = _text(report_id, 'report_id', IDENTIFIER_MAX)
    row = db.execute(
        'SELECT * FROM content_reports WHERE workspace_id=? AND id=?',
        (workspace_id, report_id),
    ).fetchone()
    return None if row is None else _report_view(row)


def resolve_report(db, workspace_id, report_id, reviewer_id, now, status, resolution,
                   action=None):
    """Move a pending report to a terminal status and record one moderation action.

    Only pending -> reviewed/actioned/dismissed is accepted. Repeating the call
    with the already-recorded terminal status is a no-op that returns the stored
    report; trying to reopen or change a terminal report raises ValueError.
    """
    _identifier(workspace_id, 'workspace_id')
    report_id = _text(report_id, 'report_id', IDENTIFIER_MAX)
    _identifier(reviewer_id, 'reviewer_id')
    _integer(now, 'now')
    status = _status(status)
    if status not in TERMINAL_STATUSES:
        raise ValueError('status must be reviewed, actioned or dismissed')
    resolution = _text(resolution, 'resolution', RESOLUTION_MAX, required=False)
    if action is not None:
        action = _text(action, 'action', ACTION_MAX)
    row = db.execute(
        'SELECT * FROM content_reports WHERE workspace_id=? AND id=?',
        (workspace_id, report_id),
    ).fetchone()
    if row is None:
        raise LookupError('Report not found')
    if row['status'] != 'pending':
        if row['status'] == status:
            return _report_view(row)
        raise ValueError('Report is already resolved')
    cursor = db.execute(
        "UPDATE content_reports SET status=?, reviewer_id=?, resolution=?, updated=? "
        "WHERE workspace_id=? AND id=? AND status='pending'",
        (status, reviewer_id, resolution, now, workspace_id, report_id),
    )
    if cursor.rowcount != 1:
        current = db.execute(
            'SELECT * FROM content_reports WHERE workspace_id=? AND id=?',
            (workspace_id, report_id),
        ).fetchone()
        if current is not None and current['status'] == status:
            return _report_view(current)
        raise ValueError('Report was resolved concurrently')
    db.execute(
        'INSERT INTO moderation_actions(id, report_id, actor_id, action, notes, created) '
        'VALUES(?,?,?,?,?,?)',
        (uuid4().hex, report_id, reviewer_id, action or status, resolution, now),
    )
    return get_report(db, workspace_id, report_id)


def count_pending(db, workspace_id):
    """Return the number of pending reports in one workspace."""
    _identifier(workspace_id, 'workspace_id')
    return db.execute(
        "SELECT COUNT(*) FROM content_reports WHERE workspace_id=? AND status='pending'",
        (workspace_id,),
    ).fetchone()[0]
