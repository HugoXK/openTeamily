"""Meeting transcript sessions and speaker-labelled segments.

Self-written for OpenTeamily; no upstream or Teamily source. This module persists
transcript sessions and ordered, non-overlapping segments, enforces recorded
consent before accepting speech, supports time-range listing and bounded
substring search, and deletes a session with its segments. It does not capture
audio/video, run an ASR engine, diarize a stream, join calls or use the network.
A session must be started with explicit consent; withdrawing it marks the
session failed and blocks further appends. Search is a bounded LIKE scan, not a
ranking or semantic search, and it only covers sessions whose consent remains.
"""
import re
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS transcription_sessions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 meeting_id TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 language TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending', 'recording', 'transcribed', 'failed')),
 consent INTEGER NOT NULL CHECK(consent IN (0, 1)),
 consent_by TEXT REFERENCES users(id),
 consent_at INTEGER,
 started INTEGER,
 ended INTEGER,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS transcription_session_workspace
 ON transcription_sessions(workspace_id, id);
CREATE INDEX IF NOT EXISTS transcription_session_meeting
 ON transcription_sessions(workspace_id, meeting_id, created);
CREATE TABLE IF NOT EXISTS transcript_segments (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 speaker_id TEXT NOT NULL,
 start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
 end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
 text TEXT NOT NULL,
 confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
 created INTEGER NOT NULL,
 UNIQUE(session_id, start_ms, speaker_id));
CREATE INDEX IF NOT EXISTS transcript_segment_session
 ON transcript_segments(workspace_id, session_id, start_ms, id);
CREATE INDEX IF NOT EXISTS transcript_segment_speaker
 ON transcript_segments(workspace_id, session_id, speaker_id, start_ms);
'''

MEETING_MAX = 128
LANGUAGE_MAX = 35
SPEAKER_MAX = 80
TEXT_MAX = 8000
QUERY_MAX = 200
LIMIT_MAX = 200
MAX_MS = 7 * 24 * 60 * 60 * 1000
LANGUAGE_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,34}')
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
STATUSES = ('pending', 'recording', 'transcribed', 'failed')


class TranscriptionError(Exception):
    """A rejected transcription operation with a stable machine-readable code."""

    def __init__(self, code, detail=''):
        self.code = code
        self.detail = detail
        super().__init__(detail or code)


def ensure_schema(db):
    db.executescript(SCHEMA)


def _valid_now(value):
    return type(value) is int and value >= 0


def _valid_text(value, maximum):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= maximum
            and not CONTROL.search(value))


def _valid_token(value, maximum):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum \
        and not CONTROL.search(value)


def valid_language(value):
    return isinstance(value, str) and bool(LANGUAGE_RE.fullmatch(value.strip()))


def _valid_confidence(value):
    return value is None or (type(value) in (int, float) and 0.0 <= value <= 1.0)


def _valid_limit(value):
    return type(value) is int and 1 <= value <= LIMIT_MAX


def _valid_ms_filter(value):
    return value is None or (type(value) is int and value >= 0)


def _like_pattern(value):
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def session_view(row):
    if row is None:
        return None
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'meeting_id': row['meeting_id'],
        'created_by': row['created_by'],
        'language': row['language'],
        'status': row['status'],
        'consent': bool(row['consent']),
        'consent_by': row['consent_by'],
        'consent_at': row['consent_at'],
        'started': row['started'],
        'ended': row['ended'],
        'created': row['created'],
        'updated': row['updated'],
    }


def segment_view(row):
    return {
        'id': row['id'],
        'session_id': row['session_id'],
        'workspace_id': row['workspace_id'],
        'speaker_id': row['speaker_id'],
        'start_ms': row['start_ms'],
        'end_ms': row['end_ms'],
        'text': row['text'],
        'confidence': row['confidence'],
        'created': row['created'],
    }


def _load_session(db, workspace_id, session_id):
    return db.execute(
        'SELECT * FROM transcription_sessions WHERE id=? AND workspace_id=?',
        (session_id, workspace_id),
    ).fetchone()


def get_session(db, workspace_id, session_id):
    return session_view(_load_session(db, workspace_id, session_id))


def start_session(db, workspace_id, meeting_id, created_by, now, language='en',
                  consent=False, consent_by=None):
    if type(consent) is not bool:
        raise TranscriptionError('invalid_consent', 'Consent must be a boolean')
    if not consent:
        raise TranscriptionError('consent_required', 'Transcript consent is required')
    if not _valid_now(now):
        raise TranscriptionError('invalid_time', 'Invalid session timestamp')
    if not _valid_token(meeting_id, MEETING_MAX):
        raise TranscriptionError('invalid_meeting', 'Invalid meeting id')
    if not _valid_token(created_by, MEETING_MAX):
        raise TranscriptionError('invalid_user', 'Invalid creator id')
    if not valid_language(language):
        raise TranscriptionError('invalid_language', 'Invalid language tag')
    if consent_by is not None and not _valid_token(consent_by, MEETING_MAX):
        raise TranscriptionError('invalid_user', 'Invalid consenting user id')
    consent_by = consent_by or created_by
    session_id = uuid4().hex
    db.execute(
        'INSERT INTO transcription_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (session_id, workspace_id, meeting_id.strip(), created_by, language.strip(),
         'recording', 1, consent_by, now, now, None, now, now),
    )
    return get_session(db, workspace_id, session_id)


def append_segment(db, workspace_id, session_id, speaker_id, start_ms, end_ms, text,
                   now, confidence=None):
    row = _load_session(db, workspace_id, session_id)
    if row is None:
        raise TranscriptionError('not_found', 'Transcript session not found')
    if not row['consent']:
        raise TranscriptionError('consent_required', 'Transcript consent is required')
    if row['status'] != 'recording':
        raise TranscriptionError('not_recording', 'Transcript session is not recording')
    if not _valid_now(now):
        raise TranscriptionError('invalid_time', 'Invalid segment timestamp')
    if not _valid_token(speaker_id, SPEAKER_MAX):
        raise TranscriptionError('invalid_speaker', 'Invalid speaker id')
    if type(start_ms) is not int or type(end_ms) is not int:
        raise TranscriptionError('invalid_time_range', 'Segment times must be integers')
    if start_ms < 0 or end_ms <= start_ms or end_ms > MAX_MS:
        raise TranscriptionError('invalid_time_range', 'Segment time range is out of bounds')
    if not _valid_text(text, TEXT_MAX):
        raise TranscriptionError('invalid_text', 'Segment text is empty or too long')
    if not _valid_confidence(confidence):
        raise TranscriptionError('invalid_confidence', 'Confidence must be between 0 and 1')
    last = db.execute(
        'SELECT start_ms, end_ms FROM transcript_segments '
        'WHERE workspace_id=? AND session_id=? ORDER BY start_ms DESC, id DESC LIMIT 1',
        (workspace_id, session_id),
    ).fetchone()
    if last is not None and start_ms < last['end_ms']:
        raise TranscriptionError('overlap', 'Segments must be ordered and non-overlapping')
    segment_id = uuid4().hex
    db.execute(
        'INSERT INTO transcript_segments VALUES(?,?,?,?,?,?,?,?,?)',
        (segment_id, session_id, workspace_id, speaker_id.strip(), start_ms, end_ms,
         text, confidence, now),
    )
    return segment_view(db.execute(
        'SELECT * FROM transcript_segments WHERE id=? AND workspace_id=?',
        (segment_id, workspace_id),
    ).fetchone())


def finalize_session(db, workspace_id, session_id, now):
    row = _load_session(db, workspace_id, session_id)
    if row is None:
        raise TranscriptionError('not_found', 'Transcript session not found')
    if not _valid_now(now):
        raise TranscriptionError('invalid_time', 'Invalid session timestamp')
    if row['status'] not in ('pending', 'recording'):
        raise TranscriptionError('not_recording', 'Transcript session cannot be finalized')
    db.execute(
        'UPDATE transcription_sessions SET status=?, ended=?, updated=? '
        'WHERE id=? AND workspace_id=?',
        ('transcribed', now, now, session_id, workspace_id),
    )
    return get_session(db, workspace_id, session_id)


def fail_session(db, workspace_id, session_id, now):
    row = _load_session(db, workspace_id, session_id)
    if row is None:
        raise TranscriptionError('not_found', 'Transcript session not found')
    if not _valid_now(now):
        raise TranscriptionError('invalid_time', 'Invalid session timestamp')
    if row['status'] == 'transcribed':
        raise TranscriptionError('not_recording', 'A finalized session cannot fail')
    db.execute(
        'UPDATE transcription_sessions SET status=?, ended=?, updated=? '
        'WHERE id=? AND workspace_id=?',
        ('failed', now, now, session_id, workspace_id),
    )
    return get_session(db, workspace_id, session_id)


def withdraw_consent(db, workspace_id, session_id, now):
    row = _load_session(db, workspace_id, session_id)
    if row is None:
        raise TranscriptionError('not_found', 'Transcript session not found')
    if not _valid_now(now):
        raise TranscriptionError('invalid_time', 'Invalid session timestamp')
    db.execute(
        'UPDATE transcription_sessions SET consent=0, status=?, ended=COALESCE(ended, ?), '
        'updated=? WHERE id=? AND workspace_id=?',
        ('failed', now, now, session_id, workspace_id),
    )
    return get_session(db, workspace_id, session_id)


def list_segments(db, workspace_id, session_id, start_ms=None, end_ms=None,
                  limit=100, cursor=''):
    if _load_session(db, workspace_id, session_id) is None:
        return []
    if not _valid_limit(limit):
        raise TranscriptionError('invalid_limit', 'Limit is out of bounds')
    if not _valid_ms_filter(start_ms) or not _valid_ms_filter(end_ms):
        raise TranscriptionError('invalid_time_range', 'Invalid filter time range')
    if not isinstance(cursor, str) or len(cursor) > 64:
        raise TranscriptionError('invalid_cursor', 'Invalid cursor')
    tail = ''
    args = [workspace_id, session_id]
    if start_ms is not None:
        tail += ' AND end_ms > ?'
        args.append(start_ms)
    if end_ms is not None:
        tail += ' AND start_ms < ?'
        args.append(end_ms)
    seat = None
    if cursor:
        seat = db.execute(
            'SELECT start_ms FROM transcript_segments '
            'WHERE id=? AND workspace_id=? AND session_id=?',
            (cursor, workspace_id, session_id),
        ).fetchone()
        if seat is None:
            return []
        tail += ' AND (start_ms > ? OR (start_ms = ? AND id > ?))'
        args.extend((seat['start_ms'], seat['start_ms'], cursor))
    rows = db.execute(
        'SELECT * FROM transcript_segments WHERE workspace_id=? AND session_id=?'
        + tail + ' ORDER BY start_ms, id LIMIT ?',
        (*args, limit),
    ).fetchall()
    return [segment_view(row) for row in rows]


def search(db, workspace_id, query, limit=50):
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= QUERY_MAX \
            or CONTROL.search(query):
        raise TranscriptionError('invalid_query', 'Invalid search query')
    if not _valid_limit(limit):
        raise TranscriptionError('invalid_limit', 'Limit is out of bounds')
    rows = db.execute(
        'SELECT g.*, s.meeting_id AS meeting_id FROM transcript_segments g '
        'JOIN transcription_sessions s ON s.id=g.session_id '
        'AND s.workspace_id=g.workspace_id '
        'WHERE g.workspace_id=? AND s.consent=1 '
        "AND g.text LIKE ? ESCAPE '\\' "
        'ORDER BY g.start_ms, g.id LIMIT ?',
        (workspace_id, _like_pattern(query.strip()), limit),
    ).fetchall()
    found = []
    for row in rows:
        item = segment_view(row)
        item['meeting_id'] = row['meeting_id']
        found.append(item)
    return found


def delete_session(db, workspace_id, session_id):
    row = _load_session(db, workspace_id, session_id)
    if row is None:
        return False
    db.execute(
        'DELETE FROM transcript_segments WHERE workspace_id=? AND session_id=?',
        (workspace_id, session_id),
    )
    db.execute(
        'DELETE FROM transcription_sessions WHERE id=? AND workspace_id=?',
        (session_id, workspace_id),
    )
    return True
