"""Agent replies in workspace social conversations (issue #89, speaking slice).

Self-written for OpenTeamily; no upstream or Teamily source. An existing agent
member of a group can be asked to answer a message. Replies reuse the runtime
`infer` task contract and are reconciled on read. There is no autonomous
delegation, team goal, or agent-to-agent orchestration; those remain the rest of
#89. A no-agent result stays queued with `error_code=no_agent` and is not
auto-retried by this slice.
"""
import json

from . import conversations
from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS social_agent_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 task_id TEXT,
 error_code TEXT,
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT,
 request_hash TEXT,
 UNIQUE(conversation_id, seq));
CREATE INDEX IF NOT EXISTS social_agent_message_list
 ON social_agent_messages(conversation_id, seq, id);
CREATE UNIQUE INDEX IF NOT EXISTS social_agent_message_idem
 ON social_agent_messages(conversation_id, key_hash) WHERE key_hash IS NOT NULL;
'''

MAX_MENTIONS = 5


def valid_mentions(value):
    from .social import valid_member_ids
    return isinstance(value, list) and 1 <= len(value) <= MAX_MENTIONS and valid_member_ids(value)


def is_agent_member(db, conversation_id, agent_id):
    return db.execute(
        'SELECT 1 FROM social_agent_members WHERE conversation_id=? AND agent_id=?',
        (conversation_id, agent_id),
    ).fetchone() is not None


def next_seq(db, conversation_id):
    human = db.execute(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM social_messages WHERE conversation_id=?',
        (conversation_id,),
    ).fetchone()['seq']
    agent = db.execute(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM social_agent_messages WHERE conversation_id=?',
        (conversation_id,),
    ).fetchone()['seq']
    return max(human, agent) + 1


def load_message(db, conversation_id, message_id):
    return db.execute(
        'SELECT m.*, a.name AS agent_name FROM social_agent_messages m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        'WHERE m.conversation_id=? AND m.id=?',
        (conversation_id, message_id),
    ).fetchone()


def load_message_by_key(db, conversation_id, key_hash):
    return db.execute(
        'SELECT m.*, a.name AS agent_name FROM social_agent_messages m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        'WHERE m.conversation_id=? AND m.key_hash=?',
        (conversation_id, key_hash),
    ).fetchone()


def message_view(row):
    return {
        'id': row['id'],
        'conversation_id': row['conversation_id'],
        'workspace_id': row['workspace_id'],
        'author_type': 'agent',
        'agent_id': row['agent_id'],
        'agent_name': row['agent_name'],
        'body': row['body'],
        'status': row['status'],
        'error_code': row['error_code'],
        'created': row['created'],
        'updated': row['updated'],
        'seq': row['seq'],
    }


def human_view(row):
    return {
        'id': row['id'],
        'conversation_id': row['conversation_id'],
        'workspace_id': row['workspace_id'],
        'author_type': 'user',
        'user_id': row['user_id'],
        'body': row['body'],
        'created': row['created'],
        'seq': row['seq'],
    }


def _cursor_seq(db, conversation_id, cursor):
    for table in ('social_messages', 'social_agent_messages'):
        row = db.execute(
            'SELECT seq FROM %s WHERE conversation_id=? AND id=?' % table,
            (conversation_id, cursor),
        ).fetchone()
        if row is not None:
            return row['seq']
    return None


def combined(db, conversation_id, cursor, limit):
    start = 0
    if cursor:
        found = _cursor_seq(db, conversation_id, cursor)
        if found is None:
            return None
        start = found
    human = db.execute(
        'SELECT * FROM social_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?',
        (conversation_id, start, limit),
    ).fetchall()
    agent = db.execute(
        'SELECT m.*, a.name AS agent_name FROM social_agent_messages m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        'WHERE m.conversation_id=? AND m.seq>? ORDER BY m.seq LIMIT ?',
        (conversation_id, start, limit),
    ).fetchall()
    merged = [human_view(row) for row in human] + [message_view(row) for row in agent]
    merged.sort(key=lambda item: item['seq'])
    return merged[:limit]


def history_for_prompt(db, conversation_id):
    human = db.execute(
        'SELECT body, seq FROM social_messages WHERE conversation_id=? ORDER BY seq',
        (conversation_id,),
    ).fetchall()
    agent = db.execute(
        'SELECT body, seq FROM social_agent_messages WHERE conversation_id=? AND status=? ORDER BY seq',
        (conversation_id, 'succeeded'),
    ).fetchall()
    merged = ([{'role': 'user', 'body': row['body'], 'seq': row['seq']} for row in human]
              + [{'role': 'assistant', 'body': row['body'], 'seq': row['seq']} for row in agent])
    merged.sort(key=lambda item: item['seq'])
    return merged


def apply_task(db, message, task, now):
    status, error_code, text = conversations.map_task_status(task)
    body = text if status == 'succeeded' else (message['body'] or '')
    if (status == message['status'] and error_code == message['error_code']
            and body == message['body']):
        return message
    db.execute(
        'UPDATE social_agent_messages SET status=?, error_code=?, body=?, updated=? WHERE id=?',
        (status, error_code, body, now, message['id']),
    )
    return load_message(db, message['conversation_id'], message['id'])


def pending(db, conversation_id):
    return db.execute(
        'SELECT m.*, a.name AS agent_name FROM social_agent_messages m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        "WHERE m.conversation_id=? AND m.status IN ('queued','running')",
        (conversation_id,),
    ).fetchall()


def mention_key(key, agent_id):
    return digest('social-agent-message:' + key + ':' + agent_id)


def mention_request(body, agent_id):
    return digest(json.dumps({'body': body, 'agent_id': agent_id},
                             sort_keys=True, separators=(',', ':'), ensure_ascii=False))
