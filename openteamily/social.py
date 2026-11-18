"""Workspace human-to-human social messenger (issue #86).

Self-written for OpenTeamily; no upstream or Teamily source. This slice adds
direct messages and named group conversations between members of the same
workspace. Groups may persist agent members (not speakers). It does not add unread
counts, notifications, attachments or cross-workspace delivery. Those remain
separate issues; do not describe this as Teamily messenger parity.
"""
import re

from .security import digest
from . import search

SCHEMA = '''
CREATE TABLE IF NOT EXISTS social_conversations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
 title TEXT NOT NULL,
 dm_key TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, dm_key));
CREATE INDEX IF NOT EXISTS social_conversation_ws
 ON social_conversations(workspace_id, id);
CREATE TABLE IF NOT EXISTS social_members (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, user_id));
CREATE INDEX IF NOT EXISTS social_member_user
 ON social_members(workspace_id, user_id, conversation_id);
CREATE TABLE IF NOT EXISTS social_agent_members (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, agent_id));
CREATE TABLE IF NOT EXISTS social_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(conversation_id, seq),
 UNIQUE(conversation_id, key_hash));
CREATE INDEX IF NOT EXISTS social_message_list
 ON social_messages(conversation_id, seq, id);
'''

KINDS = ('dm', 'group')
TITLE_MAX = 80
BODY_MAX = 4000
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HEX32 = re.compile(r'[0-9a-f]{32}')


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not CONTROL.search(value)


def valid_body(value):
    return (isinstance(value, str) and 1 <= len(value) <= BODY_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def valid_member_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 49:
        return False
    if any(not isinstance(item, str) or not HEX32.fullmatch(item) for item in value):
        return False
    return len(set(value)) == len(value)


def valid_agent_ids(value):
    return isinstance(value, list) and len(value) <= 49 and (
        not value or valid_member_ids(value))


def agent_member_rows(db, conversation_id):
    rows = db.execute(
        'SELECT m.agent_id, a.name, a.archived, m.created FROM social_agent_members m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        'JOIN social_conversations c ON c.id=m.conversation_id AND c.workspace_id=a.workspace_id '
        'WHERE m.conversation_id=? ORDER BY a.name, m.agent_id', (conversation_id,))
    return [dict(row) for row in rows]


def dm_key(first, second):
    return digest('social-dm:' + ':'.join(sorted((first, second))))


def conversation_view(row, members=None, preview='', agent_members=None):
    data = {key: row[key] for key in (
        'id', 'workspace_id', 'kind', 'title', 'created', 'updated')}
    data['preview'] = preview or ''
    data['agent_members'] = agent_members or []
    if members is not None:
        data['members'] = members
    return data


def message_view(row):
    return {key: row[key] for key in (
        'id', 'conversation_id', 'workspace_id', 'user_id', 'body', 'created')}


def member_view(row):
    return {key: row[key] for key in ('user_id', 'username', 'created')}


def load(db, workspace_id, conversation_id):
    return db.execute(
        'SELECT * FROM social_conversations WHERE id=? AND workspace_id=?',
        (conversation_id, workspace_id),
    ).fetchone()


def load_by_key(db, workspace_id, key_hash):
    return db.execute(
        'SELECT * FROM social_conversations WHERE workspace_id=? AND key_hash=?',
        (workspace_id, key_hash),
    ).fetchone()


def load_dm(db, workspace_id, key):
    return db.execute(
        'SELECT * FROM social_conversations WHERE workspace_id=? AND dm_key=?',
        (workspace_id, key),
    ).fetchone()


def is_member(db, conversation_id, workspace_id, user_id):
    return db.execute(
        'SELECT 1 FROM social_members WHERE conversation_id=? AND workspace_id=? AND user_id=?',
        (conversation_id, workspace_id, user_id),
    ).fetchone() is not None


def member_rows(db, conversation_id):
    rows = db.execute(
        'SELECT m.user_id, u.username, m.created FROM social_members m '
        'JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? '
        'ORDER BY u.username, m.user_id',
        (conversation_id,),
    ).fetchall()
    return [member_view(row) for row in rows]

def last_previews(db, workspace_id, conversation_ids):
    ids = [item for item in conversation_ids if item]
    if not ids:
        return {}
    placeholders = ','.join('?' * len(ids))
    rows = db.execute(
        'SELECT conversation_id, body FROM ('
        ' SELECT conversation_id, body,'
        ' ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY seq DESC, id DESC) AS rn'
        f' FROM social_messages WHERE workspace_id=? AND conversation_id IN ({placeholders})'
        " AND trim(body) != '') ranked WHERE rn=1",
        (workspace_id, *ids),
    ).fetchall()
    return {row['conversation_id']: search.snippet(row['body']) for row in rows}


def conversation_item(db, row, members=None):
    preview = last_previews(db, row['workspace_id'], [row['id']]).get(row['id'], '')
    if members is None:
        members = member_rows(db, row['id'])
    return conversation_view(row, members, preview, agent_member_rows(db, row['id']))


def conversation_items(db, rows):
    if not rows:
        return []
    previews = last_previews(db, rows[0]['workspace_id'], [row['id'] for row in rows])
    return [conversation_view(row, member_rows(db, row['id']), previews.get(row['id'], ''),
                              agent_member_rows(db, row['id']))
            for row in rows]


def listing(db, workspace_id, user_id, cursor, limit):
    return db.execute(
        'SELECT c.* FROM social_conversations c JOIN social_members m '
        'ON m.conversation_id=c.id WHERE c.workspace_id=? AND m.user_id=? AND c.id>? '
        'ORDER BY c.id LIMIT ?',
        (workspace_id, user_id, cursor, limit),
    ).fetchall()


def messages(db, conversation_id, cursor, limit):
    start = 0
    if cursor:
        current = db.execute(
            'SELECT seq FROM social_messages WHERE conversation_id=? AND id=?',
            (conversation_id, cursor),
        ).fetchone()
        if current is None:
            return None
        start = current['seq']
    return db.execute(
        'SELECT * FROM social_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?',
        (conversation_id, start, limit),
    ).fetchall()


def load_message_by_key(db, conversation_id, key_hash):
    return db.execute(
        'SELECT * FROM social_messages WHERE conversation_id=? AND key_hash=?',
        (conversation_id, key_hash),
    ).fetchone()


def next_seq(db, conversation_id):
    row = db.execute(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM social_messages WHERE conversation_id=?',
        (conversation_id,),
    ).fetchone()
    return row['seq']


def workspace_member_ids(db, workspace):
    ids = {workspace['owner_id']}
    for row in db.execute(
            'SELECT user_id FROM workspace_members WHERE workspace_id=?', (workspace['id'],)):
        ids.add(row['user_id'])
    return ids


def username(db, user_id):
    row = db.execute('SELECT username FROM users WHERE id=?', (user_id,)).fetchone()
    return None if row is None else row['username']
