"""Bind a workspace agent to a FlyBot container instance.

Self-written for OpenTeamily. Conversations reuse the existing /v1/agent
infer task path. A lease-gated manager endpoint issues an instance runtime
key that the container loop uses to connect; the management process does
not call a model provider and does not invent a second chat engine. The
caller's own-machine connection remains an optional fallback.
"""
import hashlib
import hmac
import os
import re
import secrets
import stat


SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_agent_bindings (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 bound_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_agent_binding_instance
 ON workspace_agent_bindings(workspace_id, instance_id);
CREATE TABLE IF NOT EXISTS instance_runtime_keys (
 instance_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 key_id TEXT NOT NULL UNIQUE REFERENCES runtime_keys(id),
 token_blob TEXT NOT NULL,
 issued_job_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_message_dispatch (
 message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('instance','connection')),
 instance_id TEXT,
 connection_id TEXT);
'''

WRAP_NAME = 'instance-runtime.wrap'
def wrapping_key(store):
    directory = store.path.parent
    path = directory / WRAP_NAME
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Instance runtime wrapping key must be a private regular file')
        key = os.read(fd, 64)
        if len(key) == 0:
            key = secrets.token_bytes(32)
            os.write(fd, key)
        elif len(key) != 32:
            raise ValueError('Instance runtime wrapping key is the wrong size')
        return key
    finally:
        os.close(fd)


def _keystream(key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(8, 'big'), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def wrap(key, plaintext):
    data = plaintext.encode('utf-8')
    nonce = secrets.token_bytes(16)
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    return (nonce + cipher + tag).hex()


def unwrap(key, blob):
    try:
        raw = bytes.fromhex(blob)
    except (TypeError, ValueError):
        raise ValueError('corrupt instance runtime key') from None
    if len(raw) < 48:
        raise ValueError('corrupt instance runtime key')
    nonce, cipher, tag = raw[:16], raw[16:-32], raw[-32:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise ValueError('corrupt instance runtime key')
    return bytes(a ^ b for a, b in zip(cipher, _keystream(key, nonce, len(cipher)))).decode('utf-8')


def hostname_for(instance_id):
    return 'flybot-' + instance_id[:12]


def binding_view(row, status=None):
    data = {key: row[key] for key in (
        'agent_id', 'workspace_id', 'instance_id', 'revision', 'bound_by', 'created', 'updated')}
    if status is not None:
        data['status'] = status
    return data


def load_binding(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agent_bindings WHERE agent_id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()


def load_instance_key(db, instance_id):
    return db.execute(
        'SELECT * FROM instance_runtime_keys WHERE instance_id=?', (instance_id,)
    ).fetchone()


def instance_key_ids(db):
    return {row['key_id'] for row in db.execute('SELECT key_id FROM instance_runtime_keys')}


def online_instance_connection(db, instance_id, now, stale):
    row = db.execute(
        'SELECT c.* FROM runtime_connections c '
        'JOIN instance_runtime_keys k ON k.key_id=c.key_id '
        'WHERE k.instance_id=? AND c.last_seen>?',
        (instance_id, now - stale),
    ).fetchone()
    return row


def attach_dispatch(db, message_id, source, instance_id, connection_id):
    db.execute(
        'INSERT INTO agent_message_dispatch VALUES(?,?,?,?)',
        (message_id, source, instance_id, connection_id),
    )


def load_dispatch(db, message_id):
    return db.execute(
        'SELECT * FROM agent_message_dispatch WHERE message_id=?', (message_id,)
    ).fetchone()


def message_dispatch_view(row):
    if row is None:
        return None
    data = {'source': row['source'], 'connection_id': row['connection_id']}
    if row['instance_id']:
        data['instance_id'] = row['instance_id']
    return data


def instance_usable(snapshot):
    if snapshot is None or snapshot.get('blocked'):
        return False
    if snapshot.get('desired') != 'running':
        return False
    if snapshot.get('error') is not None:
        return False
    return True
