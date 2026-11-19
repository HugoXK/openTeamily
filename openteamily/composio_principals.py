"""Explicit per-user Composio principals for group, scheduled, and standalone DSH tasks.

Personal private-conversation grants remain in connected_tools.grant(). These
records never copy a key, never fall back to another member or an administrator
key, and are never created from skill material. Group reply protocol #124 is
unchanged: a mention/request still creates the reply; this only attaches the
requesting user's own tools when their own runtime is used. Every tool call
still requires that user's one-shot approval.
"""
from . import composio, members

SCHEMA = '''
CREATE TABLE IF NOT EXISTS composio_principals (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope TEXT NOT NULL CHECK(scope IN ('group','scheduled','dsh')),
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 revoked INTEGER);
CREATE INDEX IF NOT EXISTS composio_principal_user ON composio_principals(user_id, scope, created);
CREATE TABLE IF NOT EXISTS composio_scheduled_grants (
 automation_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL,
 PRIMARY KEY(automation_id, user_id));
'''

SCOPES = {
    'group': 'conversation',
    'scheduled': 'automation',
    'dsh': 'runtime_task',
}
IDENT = __import__('re').compile(r'[0-9a-f]{32}')


class Fault(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def fail(status, code, message):
    raise Fault(status, code, message)


def load(db, task_id):
    return db.execute('SELECT * FROM composio_principals WHERE task_id=?', (task_id,)).fetchone()


def scheduled_grant(db, automation_id, user_id):
    return db.execute(
        'SELECT * FROM composio_scheduled_grants WHERE automation_id=? AND user_id=?',
        (automation_id, user_id)).fetchone()


def scheduled_view(row, user_id):
    if row is None:
        return {'enabled': False, 'revision': 0, 'user_id': user_id}
    return {'enabled': bool(row['enabled']), 'revision': row['revision'], 'user_id': row['user_id']}


def save_scheduled(db, automation_id, user_id, enabled, revision, now):
    current = scheduled_grant(db, automation_id, user_id)
    expected = 0 if current is None else current['revision']
    if type(revision) is not int or revision != expected:
        fail(409, 'conflict', 'Scheduled tool grant changed; reload first')
    if type(enabled) is not bool:
        fail(400, 'invalid', 'enabled must be a boolean')
    if current is None:
        if not enabled:
            return scheduled_view(None, user_id)
        db.execute('INSERT INTO composio_scheduled_grants VALUES(?,?,1,1,?)',
                   (automation_id, user_id, now))
    else:
        if bool(current['enabled']) == enabled:
            return scheduled_view(current, user_id)
        db.execute(
            'UPDATE composio_scheduled_grants SET enabled=?, revision=?, updated=? WHERE automation_id=? AND user_id=?',
            (1 if enabled else 0, current['revision'] + 1, now, automation_id, user_id))
    return scheduled_view(scheduled_grant(db, automation_id, user_id), user_id)


def live(db, principal):
    """Current membership/session/opt-in checks. Fail closed; no durable event claim."""
    if principal is None or principal['revoked']:
        return False
    user_id, scope, source = principal['user_id'], principal['scope'], principal['source_id']
    if scope == 'group':
        conversation = db.execute('SELECT * FROM social_conversations WHERE id=?', (source,)).fetchone()
        if conversation is None:
            return False
        if members.load(db, conversation['workspace_id'], user_id) is None:
            return False
        return db.execute(
            'SELECT 1 FROM social_members WHERE conversation_id=? AND user_id=?',
            (source, user_id)).fetchone() is not None
    if scope == 'scheduled':
        automation = db.execute('SELECT * FROM automations WHERE id=?', (source,)).fetchone()
        if automation is None or not automation['enabled']:
            return False
        if members.load(db, automation['workspace_id'], user_id) is None:
            return False
        grant = scheduled_grant(db, source, user_id)
        return grant is not None and bool(grant['enabled'])
    if scope == 'dsh':
        task = db.execute('SELECT * FROM runtime_tasks WHERE id=?', (principal['task_id'],)).fetchone()
        if task is None:
            return False
        meta = db.execute('SELECT * FROM runtime_task_meta WHERE task_id=?', (principal['task_id'],)).fetchone()
        if meta and meta['workspace_id'] and members.load(db, meta['workspace_id'], user_id) is None:
            return False
        return source == principal['task_id']
    return False


def attach(db, task_id, user_id, scope, source_id, now, runtime_user_id):
    """Record an explicit same-user principal. Skill material cannot call this."""
    if scope not in SCOPES or not IDENT.fullmatch(task_id or '') or not IDENT.fullmatch(user_id or '') or not IDENT.fullmatch(source_id or ''):
        fail(400, 'invalid', 'Provide a supported principal scope and identifiers')
    if runtime_user_id != user_id:
        fail(403, 'tools_unavailable', 'Connected tools stay on the same user runtime; no cross-member fallback')
    existing = load(db, task_id)
    if existing is not None:
        if existing['user_id'] != user_id or existing['scope'] != scope or existing['source_id'] != source_id:
            fail(409, 'conflict', 'A different tool principal is already attached')
        if existing['revoked']:
            fail(409, 'conflict', 'This tool principal was revoked')
        return existing
    # live() needs the row; insert then re-check so a stale source cannot stick.
    db.execute('INSERT INTO composio_principals VALUES(?,?,?,?,?,?,NULL)',
               (task_id, user_id, scope, SCOPES[scope], source_id, now))
    row = load(db, task_id)
    if not live(db, row):
        db.execute('DELETE FROM composio_principals WHERE task_id=?', (task_id,))
        fail(403, 'tools_unavailable', 'The tool principal is no longer authorized')
    return row


def revoke(db, task_id, user_id, now):
    row = load(db, task_id)
    if row is None or row['user_id'] != user_id:
        fail(404, 'not_found', 'Tool principal not found')
    if row['revoked']:
        return row
    db.execute('UPDATE composio_principals SET revoked=? WHERE task_id=?', (now, task_id))
    return load(db, task_id)


def authorized_user(db, task_id, runtime_user_id):
    """Resolve the only user allowed to use connected tools on this task."""
    owner = db.execute('SELECT user_id FROM connected_tool_owners WHERE task_id=?', (task_id,)).fetchone()
    principal = load(db, task_id)
    users = set()
    if owner is not None:
        users.add(owner['user_id'])
    if principal is not None and not principal['revoked'] and live(db, principal):
        users.add(principal['user_id'])
    if len(users) != 1:
        return None
    user_id = next(iter(users))
    if user_id != runtime_user_id:
        return None
    return user_id


class ScheduledToolBackend:
    """Wrap an automation backend and attach a scheduled principal when opted in.

    Skill bindings never create a Composio grant. If the selected runtime belongs
    to a different member than the opt-in user, tools stay unavailable.
    """

    def __init__(self, inner):
        self.inner = inner

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def dispatch_automation(self, payload, db=None, model_api_key=None):
        result = self.inner.dispatch_automation(payload, db=db, model_api_key=model_api_key)
        if not isinstance(result, dict) or db is None or not result.get('task_id') or not result.get('connection_id'):
            return result
        if not isinstance(payload, dict) or not payload.get('automation_id'):
            return result
        connection = db.execute('SELECT * FROM runtime_connections WHERE id=?', (result['connection_id'],)).fetchone()
        if connection is None:
            return result
        grant = scheduled_grant(db, payload['automation_id'], connection['user_id'])
        if grant is None or not grant['enabled']:
            return result
        try:
            attach(db, result['task_id'], connection['user_id'], 'scheduled',
                   payload['automation_id'], int(payload.get('now') or 0), connection['user_id'])
        except Fault:
            # Leave the automation task itself running; tools stay unavailable.
            return result
        return result
