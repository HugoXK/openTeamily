"""Own-machine FlyBot connection, heartbeat and task transport.

Self-written for OpenTeamily. A daemon authenticates with a runtime key,
registers a connection, heartbeats, claims allowlisted tasks, and returns
results. Task payloads are never executed as commands. This is not Teamily
parity and does not implement cloud agents or a hosted computer.
"""
import re

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS runtime_connections (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key_id TEXT NOT NULL REFERENCES runtime_keys(id) ON DELETE CASCADE,
 hostname TEXT NOT NULL,
 created INTEGER NOT NULL,
 last_seen INTEGER NOT NULL,
 UNIQUE(key_id));
CREATE INDEX IF NOT EXISTS runtime_connection_user ON runtime_connections(user_id, last_seen, id);
CREATE TABLE IF NOT EXISTS runtime_tasks (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES runtime_connections(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 prompt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed')),
 result TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runtime_task_connection ON runtime_tasks(connection_id, status, created, id);
CREATE INDEX IF NOT EXISTS runtime_task_user ON runtime_tasks(user_id, created, id);
CREATE TABLE IF NOT EXISTS runtime_task_meta (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 workspace_id TEXT,
 deadline INTEGER NOT NULL,
 access_issued INTEGER NOT NULL CHECK(access_issued IN (0,1)));
'''

HOST = re.compile(r'[A-Za-z0-9._-]{1,80}')
PROMPT = re.compile(r'[^\x00]{1,4000}')
KINDS = ('echo', 'infer')
STATUSES = ('queued', 'claimed', 'succeeded', 'failed')
MAX_TASKS = 20
KEY_AUTH = 'Runtime key not accepted'
TOKEN = re.compile(r'[A-Za-z0-9_-]{32,128}')


def valid_hostname(value):
    return isinstance(value, str) and HOST.fullmatch(value)


def valid_prompt(value):
    return isinstance(value, str) and PROMPT.fullmatch(value)


def connection_view(row, now, stale):
    online = row['last_seen'] + stale > now
    return {
        'id': row['id'],
        'hostname': row['hostname'],
        'key_id': row['key_id'],
        'created': row['created'],
        'last_seen': row['last_seen'],
        'status': 'online' if online else 'offline',
    }


def _result(row):
    if not row['result']:
        return None
    import json
    try:
        value = json.loads(row['result'])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def load_meta(db, task_id):
    return db.execute('SELECT * FROM runtime_task_meta WHERE task_id=?', (task_id,)).fetchone()


def task_view(row, meta=None):
    data = {key: row[key] for key in (
        'id', 'connection_id', 'kind', 'prompt', 'status', 'created', 'updated')}
    result = _result(row)
    data['result'] = result
    if result and result.get('cancelled'):
        data['status'] = 'cancelled'
    elif result and result.get('error') == 'timeout':
        data['status'] = 'timeout'
    if meta is not None:
        data['workspace_id'] = meta['workspace_id']
        data['deadline'] = meta['deadline']
    return data


def lookup_key(db, token, now):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    row = db.execute(
        'SELECT * FROM runtime_keys WHERE token_hash=?', (digest(token),)
    ).fetchone()
    if row is None or row['revoked'] or (row['expires'] is not None and row['expires'] <= now):
        return None
    return row


def offline_for_key(db, key_id, now):
    db.execute(
        'UPDATE runtime_connections SET last_seen=? WHERE key_id=?',
        (now - 10 ** 9, key_id),
    )


def connect(db, key, now, hostname):
    from uuid import uuid4
    existing = db.execute(
        'SELECT * FROM runtime_connections WHERE key_id=?', (key['id'],)
    ).fetchone()
    if existing is None:
        connection_id = uuid4().hex
        db.execute(
            'INSERT INTO runtime_connections VALUES(?,?,?,?,?,?)',
            (connection_id, key['user_id'], key['id'], hostname, now, now),
        )
        created = True
    else:
        connection_id = existing['id']
        db.execute(
            'UPDATE runtime_connections SET hostname=?, last_seen=? WHERE id=?',
            (hostname, now, connection_id),
        )
        created = False
    row = db.execute('SELECT * FROM runtime_connections WHERE id=?', (connection_id,)).fetchone()
    return row, created


def load_connection(db, key_id):
    return db.execute(
        'SELECT * FROM runtime_connections WHERE key_id=?', (key_id,)
    ).fetchone()


def heartbeat(db, connection, now):
    db.execute(
        'UPDATE runtime_connections SET last_seen=? WHERE id=?',
        (now, connection['id']),
    )
    return db.execute(
        'SELECT * FROM runtime_connections WHERE id=?', (connection['id'],)
    ).fetchone()


def list_connections(db, user_id):
    return db.execute(
        'SELECT * FROM runtime_connections WHERE user_id=? ORDER BY last_seen DESC, id',
        (user_id,),
    ).fetchall()


def online_connection(db, user_id, now, stale, connection_id=None, personal=False):
    if connection_id is not None:
        row = db.execute(
            'SELECT * FROM runtime_connections WHERE id=? AND user_id=?',
            (connection_id, user_id),
        ).fetchone()
        if row is None:
            return None
        if personal and instance_key_owned(db, row['key_id']):
            return None
        return row if row['last_seen'] + stale > now else False
    if personal:
        row = db.execute(
            'SELECT c.* FROM runtime_connections c '
            'WHERE c.user_id=? AND c.last_seen>? '
            'AND c.key_id NOT IN (SELECT key_id FROM instance_runtime_keys) '
            'ORDER BY c.last_seen DESC, c.id LIMIT 1',
            (user_id, now - stale),
        ).fetchone()
        return row
    row = db.execute(
        'SELECT * FROM runtime_connections WHERE user_id=? AND last_seen>? '
        'ORDER BY last_seen DESC, id LIMIT 1',
        (user_id, now - stale),
    ).fetchone()
    return row


def instance_key_owned(db, key_id):
    return db.execute(
        'SELECT instance_id FROM instance_runtime_keys WHERE key_id=?', (key_id,)
    ).fetchone() is not None


def queued_for(db, connection_id):
    return db.execute(
        'SELECT * FROM runtime_tasks WHERE connection_id=? AND status=? ORDER BY created, id',
        (connection_id, 'queued'),
    ).fetchall()


def user_tasks(db, user_id, limit=50):
    return db.execute(
        'SELECT * FROM runtime_tasks WHERE user_id=? ORDER BY created DESC, id LIMIT ?',
        (user_id, limit),
    ).fetchall()


def create_task(db, user_id, connection_id, now, kind, prompt, timeout, workspace_id=None):
    from uuid import uuid4
    count = db.execute(
        'SELECT COUNT(*) FROM runtime_tasks WHERE user_id=? AND status IN (?,?)',
        (user_id, 'queued', 'claimed'),
    ).fetchone()[0]
    if count >= MAX_TASKS:
        raise ValueError('quota')
    task_id = uuid4().hex
    db.execute(
        'INSERT INTO runtime_tasks VALUES(?,?,?,?,?,?,NULL,?,?)',
        (task_id, user_id, connection_id, kind, prompt, 'queued', now, now),
    )
    db.execute(
        'INSERT INTO runtime_task_meta VALUES(?,?,?,0)',
        (task_id, workspace_id, now + timeout),
    )
    return db.execute('SELECT * FROM runtime_tasks WHERE id=?', (task_id,)).fetchone()


def load_task(db, task_id, connection_id=None, user_id=None):
    if connection_id is not None:
        return db.execute(
            'SELECT * FROM runtime_tasks WHERE id=? AND connection_id=?',
            (task_id, connection_id),
        ).fetchone()
    if user_id is not None:
        return db.execute(
            'SELECT * FROM runtime_tasks WHERE id=? AND user_id=?',
            (task_id, user_id),
        ).fetchone()
    return db.execute('SELECT * FROM runtime_tasks WHERE id=?', (task_id,)).fetchone()


def claim_task(db, task, now):
    if task['status'] == 'claimed':
        return task
    if task['status'] != 'queued':
        return None
    db.execute(
        'UPDATE runtime_tasks SET status=?, updated=? WHERE id=? AND status=?',
        ('claimed', now, task['id'], 'queued'),
    )
    return db.execute('SELECT * FROM runtime_tasks WHERE id=?', (task['id'],)).fetchone()


def complete_task(db, task, now, status, result):
    import json
    current = _result(task)
    if current and (current.get('cancelled') or current.get('error') == 'timeout'):
        return None
    if task['status'] not in ('queued', 'claimed'):
        return None
    document = json.dumps(result, sort_keys=True, separators=(',', ':'))
    if len(document.encode('utf-8')) > 16384:
        raise ValueError('too_large')
    db.execute(
        'UPDATE runtime_tasks SET status=?, result=?, updated=? WHERE id=?',
        (status, document, now, task['id']),
    )
    return db.execute('SELECT * FROM runtime_tasks WHERE id=?', (task['id'],)).fetchone()


def echo_result(prompt):
    return {'echo': prompt}


def view_with_meta(db, row):
    return task_view(row, load_meta(db, row['id']))


def expire_task(db, task, now):
    meta = load_meta(db, task['id'])
    if meta is None or meta['deadline'] > now:
        return task
    if task['status'] not in ('queued', 'claimed'):
        return task
    current = _result(task)
    if current and (current.get('cancelled') or current.get('error') == 'timeout'):
        return task
    return complete_task(db, task, now, 'failed', {'error': 'timeout'}) or task


def cancel_task(db, task, now):
    task = expire_task(db, task, now)
    if task['status'] not in ('queued', 'claimed'):
        return None
    current = _result(task)
    if current and (current.get('cancelled') or current.get('error') == 'timeout'):
        return None
    return complete_task(db, task, now, 'failed', {'cancelled': True})


def mark_access_issued(db, task_id):
    db.execute('UPDATE runtime_task_meta SET access_issued=1 WHERE task_id=?', (task_id,))


def access_issued(db, task_id):
    meta = load_meta(db, task_id)
    return bool(meta and meta['access_issued'])
