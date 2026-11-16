"""Authorized user/agent conversation history (issue #6 conversation slice).

Self-written for OpenTeamily. Management stores history and binds each
conversation to a workspace agent record. Replies are queued as existing
runtime infer tasks on the calling user's online connection; the
management process does not call a model provider. Fake-provider tests
are not a real vendor or a live container run.
"""
import json
import re


SCHEMA = '''
CREATE TABLE IF NOT EXISTS agent_conversations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash));
CREATE INDEX IF NOT EXISTS agent_conversation_list
 ON agent_conversations(workspace_id, user_id, id);
CREATE TABLE IF NOT EXISTS agent_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 body TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 task_id TEXT,
 error_code TEXT,
 agent_revision INTEGER,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT,
 request_hash TEXT,
 seq INTEGER NOT NULL,
 UNIQUE(conversation_id, seq));
CREATE INDEX IF NOT EXISTS agent_message_list ON agent_messages(conversation_id, seq, id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_message_idempotency
 ON agent_messages(conversation_id, key_hash) WHERE key_hash IS NOT NULL;
'''

TITLE_MAX = 80
MESSAGE_MAX = 4000
PROMPT_MAX = 4000
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
STATUSES = ('queued', 'running', 'succeeded', 'failed', 'cancelled')


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not CONTROL.search(value)


def valid_message(value):
    return (isinstance(value, str) and 1 <= len(value) <= MESSAGE_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def default_title(text):
    line = ' '.join((text or '').split())
    if not line:
        return '新对话'
    return line[:TITLE_MAX]


def conversation_view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'agent_id', 'user_id', 'title', 'created', 'updated')}


def message_view(row):
    data = {key: row[key] for key in (
        'id', 'conversation_id', 'workspace_id', 'agent_id', 'user_id', 'role',
        'body', 'status', 'created', 'updated')}
    data['task_id'] = row['task_id']
    data['error_code'] = row['error_code']
    data['agent_revision'] = row['agent_revision']
    return data


def load_conversation(db, workspace_id, conversation_id):
    return db.execute(
        'SELECT * FROM agent_conversations WHERE id=? AND workspace_id=?',
        (conversation_id, workspace_id),
    ).fetchone()


def load_message(db, conversation_id, message_id):
    return db.execute(
        'SELECT * FROM agent_messages WHERE id=? AND conversation_id=?',
        (message_id, conversation_id),
    ).fetchone()


def listing(db, workspace_id, user_id, agent_id, cursor, limit):
    return db.execute(
        'SELECT * FROM agent_conversations WHERE workspace_id=? AND user_id=? AND agent_id=?'
        ' AND id>? ORDER BY id LIMIT ?',
        (workspace_id, user_id, agent_id, cursor, limit),
    ).fetchall()


def messages(db, conversation_id, cursor, limit):
    start = 0
    if cursor:
        current = db.execute(
            'SELECT seq FROM agent_messages WHERE conversation_id=? AND id=?',
            (conversation_id, cursor),
        ).fetchone()
        if current is None:
            return None
        start = current['seq']
    return db.execute(
        'SELECT * FROM agent_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?',
        (conversation_id, start, limit),
    ).fetchall()


def history_for_prompt(db, conversation_id, before_seq=None):
    rows = db.execute(
        'SELECT * FROM agent_messages WHERE conversation_id=? AND status=? ORDER BY seq',
        (conversation_id, 'succeeded'),
    ).fetchall()
    if before_seq is not None:
        rows = [row for row in rows if row['seq'] < before_seq]
    return rows


def compose_prompt(agent, history, user_text):
    name = (agent['name'] or 'FlyBot').strip()
    parts = ['You are %s.' % name]
    summary = (agent['summary'] or '').strip()
    if summary:
        parts.append(summary)
    instructions = (agent['instructions'] or '').strip()
    if instructions:
        parts.append(instructions)
    header = '\n'.join(parts)
    user_text = user_text.strip() if isinstance(user_text, str) else ''
    suffix = '\nUser: ' + user_text
    if len(suffix) > PROMPT_MAX - 32:
        suffix = suffix[:PROMPT_MAX - 32]
    budget = PROMPT_MAX - len(suffix) - 1
    if budget < 1:
        return suffix[:PROMPT_MAX]
    if len(header) > budget:
        header = header[:budget]
    used = header
    lines = []
    for row in history:
        body = (row['body'] or '').strip()
        if not body:
            continue
        label = 'User' if row['role'] == 'user' else 'Assistant'
        lines.append('%s: %s' % (label, body))
    block = ''
    for line in reversed(lines):
        candidate = (block and (line + '\n' + block)) or line
        if used and len(used) + 1 + len(candidate) + len(suffix) > PROMPT_MAX:
            break
        if not used and len(candidate) + len(suffix) > PROMPT_MAX:
            break
        block = candidate
    prompt = used
    if block:
        prompt = (prompt + '\n' + block) if prompt else block
    prompt = (prompt + suffix) if prompt else suffix.lstrip('\n')
    return prompt[:PROMPT_MAX]


def can_read(row, session_user_id):
    return row['user_id'] == session_user_id


def can_send(row, session_user_id):
    return row['user_id'] == session_user_id


def map_task_status(task):
    if task is None:
        return 'queued', None, ''
    status = task['status']
    result = {}
    raw = task['result'] if 'result' in task.keys() else None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                result = parsed
        except (TypeError, ValueError, json.JSONDecodeError):
            result = {}
    text = result.get('text') if isinstance(result.get('text'), str) else ''
    if '\x00' in text:
        text = text.replace('\x00', '')
    if len(text) > MESSAGE_MAX:
        text = text[:MESSAGE_MAX]
    if status == 'queued':
        return 'queued', None, ''
    if status == 'claimed':
        return 'running', None, ''
    if status == 'succeeded':
        return 'succeeded', None, text
    if result.get('cancelled'):
        return 'cancelled', 'cancelled', ''
    if result.get('error') == 'timeout':
        return 'failed', 'timeout', ''
    code = result.get('error')
    if not isinstance(code, str) or not code or len(code) > 64 or CONTROL.search(code):
        code = 'failed'
    return 'failed', code, text


def apply_task(db, message, task, now):
    status, error_code, text = map_task_status(task)
    body = text if status == 'succeeded' else (message['body'] or '')
    if (status == message['status'] and error_code == message['error_code']
            and body == message['body'] and message['task_id'] == (task['id'] if task else message['task_id'])):
        return message
    db.execute(
        'UPDATE agent_messages SET status=?, error_code=?, body=?, updated=? WHERE id=?',
        (status, error_code, body, now, message['id']),
    )
    if status in ('succeeded', 'failed', 'cancelled'):
        db.execute(
            'UPDATE agent_conversations SET updated=? WHERE id=?',
            (now, message['conversation_id']),
        )
    return load_message(db, message['conversation_id'], message['id'])
