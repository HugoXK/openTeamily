"""Chat poll persistence and voting.

Self-written for OpenTeamily. This module stores polls, their options, and
votes in the local SQLite database. The caller is responsible for authorizing
the signed-in user against the workspace and conversation before invoking
these functions; this module only enforces workspace isolation and
creator-only close/delete operations on the stored records. Vote results are
read from the database and are not pushed live to other clients, agents, or
runtime containers. Anonymous polls hide voter identities from results, not
from the database or an operator with database access.
"""
from contextlib import contextmanager
import re
from uuid import uuid4


SCHEMA = '''
CREATE TABLE IF NOT EXISTS polls (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 question TEXT NOT NULL,
 multi_select INTEGER NOT NULL DEFAULT 0 CHECK(multi_select IN (0,1)),
 anonymous INTEGER NOT NULL DEFAULT 0 CHECK(anonymous IN (0,1)),
 closes INTEGER,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS poll_workspace_conversation
 ON polls(workspace_id, conversation_id, created, id);
CREATE INDEX IF NOT EXISTS poll_workspace_created
 ON polls(workspace_id, created, id);
CREATE TABLE IF NOT EXISTS poll_options (
 id TEXT PRIMARY KEY,
 poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 text TEXT NOT NULL,
 UNIQUE(poll_id, position));
CREATE INDEX IF NOT EXISTS poll_option_order ON poll_options(poll_id, position, id);
CREATE TABLE IF NOT EXISTS poll_votes (
 poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(poll_id, option_id, user_id));
CREATE INDEX IF NOT EXISTS poll_vote_user ON poll_votes(poll_id, user_id);
'''

QUESTION_MAX = 500
OPTION_MAX = 200
MIN_OPTIONS = 2
MAX_OPTIONS = 20
LIMIT_MAX = 100
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


class PollError(ValueError):
    """Invalid poll input, missing poll, or a vote against a closed poll."""


class PollNotFound(PollError, LookupError):
    pass


class PollClosed(PollError):
    pass


class PollPermission(PermissionError, PollError):
    pass


@contextmanager
def _savepoint(db, name):
    db.execute('SAVEPOINT ' + name)
    try:
        yield
        db.execute('RELEASE SAVEPOINT ' + name)
    except BaseException:
        db.execute('ROLLBACK TO SAVEPOINT ' + name)
        db.execute('RELEASE SAVEPOINT ' + name)
        raise


def ensure_schema(db):
    db.executescript(SCHEMA)


def _text(value, limit):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= limit
            and not CONTROL.search(value))


def _timestamp(value, field):
    if isinstance(value, bool):
        raise PollError(f'{field} must be an integer timestamp')
    try:
        return int(value)
    except (TypeError, ValueError):
        raise PollError(f'{field} must be an integer timestamp') from None


def _optional_timestamp(value, field):
    return None if value is None else _timestamp(value, field)


def _option_texts(options):
    if not isinstance(options, (list, tuple)) or not MIN_OPTIONS <= len(options) <= MAX_OPTIONS:
        raise PollError(f'polls require {MIN_OPTIONS} to {MAX_OPTIONS} options')
    texts = []
    seen = set()
    for option in options:
        if not _text(option, OPTION_MAX):
            raise PollError(f'option text must be 1 to {OPTION_MAX} characters')
        text = option.strip()
        key = text.casefold()
        if key in seen:
            raise PollError('duplicate poll option')
        seen.add(key)
        texts.append(text)
    return texts


def _option_ids(option_ids):
    if not isinstance(option_ids, (list, tuple)) or not option_ids:
        raise PollError('at least one option id is required')
    result = []
    seen = set()
    for option_id in option_ids:
        if not isinstance(option_id, str) or not option_id or option_id in seen:
            raise PollError('invalid option id')
        seen.add(option_id)
        result.append(option_id)
    return result


def _load(db, workspace_id, poll_id):
    return db.execute(
        'SELECT * FROM polls WHERE id=? AND workspace_id=?',
        (poll_id, workspace_id),
    ).fetchone()


def _view(db, row, viewer_id=None):
    options = db.execute(
        'SELECT id, poll_id, position, text FROM poll_options WHERE poll_id=? '
        'ORDER BY position, id',
        (row['id'],),
    ).fetchall()
    counts = {
        item['option_id']: item['count']
        for item in db.execute(
            'SELECT option_id, COUNT(*) AS count FROM poll_votes WHERE poll_id=? '
            'GROUP BY option_id',
            (row['id'],),
        )
    }
    voters = {}
    if not row['anonymous']:
        for item in db.execute(
                'SELECT option_id, user_id FROM poll_votes WHERE poll_id=? '
                'ORDER BY created, user_id', (row['id'],)):
            voters.setdefault(item['option_id'], []).append(item['user_id'])
    viewer_votes = []
    if viewer_id is not None:
        viewer_votes = [
            item['option_id'] for item in db.execute(
                'SELECT v.option_id FROM poll_votes v '
                'JOIN poll_options o ON o.id=v.option_id '
                'WHERE v.poll_id=? AND v.user_id=? ORDER BY o.position, o.id',
                (row['id'], viewer_id),
            )
        ]
    total = sum(counts.values())
    voter_count = db.execute(
        'SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE poll_id=?',
        (row['id'],),
    ).fetchone()[0]
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'conversation_id': row['conversation_id'],
        'created_by': row['created_by'],
        'question': row['question'],
        'multi_select': bool(row['multi_select']),
        'anonymous': bool(row['anonymous']),
        'closes': row['closes'],
        'status': row['status'],
        'created': row['created'],
        'options': [
            {
                'id': option['id'],
                'poll_id': option['poll_id'],
                'position': option['position'],
                'text': option['text'],
                'count': counts.get(option['id'], 0),
                'voters': voters.get(option['id'], []),
            }
            for option in options
        ],
        'votes': viewer_votes,
        'viewer_votes': viewer_votes,
        'total': total,
        'voter_count': voter_count,
    }
    return data


def create_poll(db, workspace_id, conversation_id, created_by, question, options, now,
                multi_select=False, anonymous=False, closes=None):
    """Create an open poll and return its stored view."""
    if not isinstance(workspace_id, str) or not workspace_id:
        raise PollError('workspace_id is required')
    if not isinstance(conversation_id, str) or not conversation_id:
        raise PollError('conversation_id is required')
    if not isinstance(created_by, str) or not created_by:
        raise PollError('created_by is required')
    if not _text(question, QUESTION_MAX):
        raise PollError(f'question must be 1 to {QUESTION_MAX} characters')
    texts = _option_texts(options)
    created = _timestamp(now, 'now')
    closes_at = _optional_timestamp(closes, 'closes')
    poll_id = uuid4().hex
    with _savepoint(db, 'create_poll'):
        db.execute(
            'INSERT INTO polls(id, workspace_id, conversation_id, created_by, question, '
            'multi_select, anonymous, closes, status, created) '
            'VALUES(?,?,?,?,?,?,?,?,?,?)',
            (poll_id, workspace_id, conversation_id, created_by, question.strip(),
             1 if multi_select else 0, 1 if anonymous else 0, closes_at, 'open', created),
        )
        for position, text in enumerate(texts):
            db.execute(
                'INSERT INTO poll_options(id, poll_id, position, text) VALUES(?,?,?,?)',
                (uuid4().hex, poll_id, position, text),
            )
    return _view(db, _load(db, workspace_id, poll_id), viewer_id=created_by)


def get_poll(db, workspace_id, poll_id, viewer_id=None):
    """Return a poll with option counts, visible voters, and viewer votes."""
    row = _load(db, workspace_id, poll_id)
    if row is None:
        return None
    return _view(db, row, viewer_id=viewer_id)


def list_polls(db, workspace_id, conversation_id, limit, cursor):
    """Return a bounded page ordered by creation time and id, oldest first."""
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIMIT_MAX:
        raise PollError(f'limit must be 1 to {LIMIT_MAX}')
    if not isinstance(conversation_id, str) or not conversation_id:
        raise PollError('conversation_id is required')
    rows = None
    if cursor:
        if not isinstance(cursor, str):
            raise PollError('invalid cursor')
        anchor = db.execute(
            'SELECT created, id FROM polls WHERE workspace_id=? AND conversation_id=? AND id=?',
            (workspace_id, conversation_id, cursor),
        ).fetchone()
        if anchor is None:
            raise PollNotFound('unknown poll cursor')
        rows = db.execute(
            'SELECT * FROM polls WHERE workspace_id=? AND conversation_id=? '
            'AND (created>? OR (created=? AND id>?)) ORDER BY created, id LIMIT ?',
            (workspace_id, conversation_id, anchor['created'], anchor['created'],
             anchor['id'], limit + 1),
        ).fetchall()
    else:
        rows = db.execute(
            'SELECT * FROM polls WHERE workspace_id=? AND conversation_id=? '
            'ORDER BY created, id LIMIT ?',
            (workspace_id, conversation_id, limit + 1),
        ).fetchall()
    next_cursor = rows[limit - 1]['id'] if len(rows) > limit else None
    items = [_view(db, row) for row in rows[:limit]]
    return {'items': items, 'next_cursor': next_cursor, 'cursor': next_cursor}


def vote(db, workspace_id, poll_id, user_id, option_ids, now):
    """Record a vote and return the updated poll.

    Single-choice polls replace the caller's previous option. Multi-choice
    polls add the caller's selections. Repeating the same vote is idempotent.
    """
    row = _load(db, workspace_id, poll_id)
    if row is None:
        raise PollNotFound('poll not found')
    if row['status'] != 'open':
        raise PollClosed('poll is closed')
    created = _timestamp(now, 'now')
    if row['closes'] is not None and created >= row['closes']:
        raise PollClosed('poll has closed')
    ids = _option_ids(option_ids)
    if not row['multi_select'] and len(ids) != 1:
        raise PollError('single-choice polls accept exactly one option')
    placeholders = ','.join('?' * len(ids))
    found = {
        item['id'] for item in db.execute(
            'SELECT id FROM poll_options WHERE poll_id=? AND id IN (' + placeholders + ')',
            (poll_id, *ids),
        )
    }
    if len(found) != len(ids):
        raise PollError('option does not belong to this poll')
    with _savepoint(db, 'poll_vote'):
        if not row['multi_select']:
            db.execute(
                'DELETE FROM poll_votes WHERE poll_id=? AND user_id=? AND option_id<>?',
                (poll_id, user_id, ids[0]),
            )
        for option_id in ids:
            db.execute(
                'INSERT OR IGNORE INTO poll_votes(poll_id, option_id, user_id, created) '
                'VALUES(?,?,?,?)',
                (poll_id, option_id, user_id, created),
            )
    return _view(db, _load(db, workspace_id, poll_id), viewer_id=user_id)


def close_poll(db, workspace_id, poll_id, user_id, now):
    """Close a poll. Only the creator may close it; repeating succeeds."""
    row = _load(db, workspace_id, poll_id)
    if row is None:
        raise PollNotFound('poll not found')
    if row['created_by'] != user_id:
        raise PollPermission('only the poll creator may close it')
    _timestamp(now, 'now')
    if row['status'] != 'closed':
        db.execute("UPDATE polls SET status='closed' WHERE id=? AND workspace_id=?",
                   (poll_id, workspace_id))
    return _view(db, _load(db, workspace_id, poll_id), viewer_id=user_id)


def delete_poll(db, workspace_id, poll_id, user_id):
    """Delete a poll and its options/votes. Only the creator may delete it."""
    row = _load(db, workspace_id, poll_id)
    if row is None:
        raise PollNotFound('poll not found')
    if row['created_by'] != user_id:
        raise PollPermission('only the poll creator may delete it')
    with _savepoint(db, 'delete_poll'):
        db.execute('DELETE FROM poll_votes WHERE poll_id=?', (poll_id,))
        db.execute('DELETE FROM poll_options WHERE poll_id=?', (poll_id,))
        db.execute('DELETE FROM polls WHERE id=? AND workspace_id=?', (poll_id, workspace_id))
    return True
