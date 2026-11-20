"""Proactive/always-on agent persistence core: rules, events, runs and messages.

Scope and honest limits: this module only decides *when* a workspace-scoped rule
should act. It matches persisted events to enabled rules under cooldowns and
daily budgets, and it durably queues, leases and completes deterministic "run"
records. It does not call an LLM, generate prose, execute a container, spawn a
worker thread or send a notification. "Proactive agent" here is scheduling and
matching, not Teamily parity.

Every public function is caller-authorized: the caller must verify workspace
membership/role before invoking it. This module deliberately does not duplicate
the auth code in app.py. Run ids are globally unique; claim/complete/fail take a
run id and therefore assume the caller already authorized that run's workspace.

All text fields are bounded and all SQL is parameterized. Event and rule
idempotency use UNIQUE constraints. Do not store credentials or other secrets in
event payloads, run results, errors or message bodies.
"""
import json
import sqlite3
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS proactive_rules (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 event_kind TEXT NOT NULL,
 source_type TEXT,
 conversation_id TEXT,
 agent_id TEXT,
 cooldown_seconds INTEGER NOT NULL CHECK(cooldown_seconds >= 0),
 daily_budget INTEGER NOT NULL CHECK(daily_budget >= 0),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(workspace_id, id));
CREATE INDEX IF NOT EXISTS proactive_rule_workspace
 ON proactive_rules(workspace_id, enabled, event_kind);
CREATE TABLE IF NOT EXISTS proactive_events (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 dedupe_key TEXT NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, dedupe_key));
CREATE INDEX IF NOT EXISTS proactive_event_inbox
 ON proactive_events(workspace_id, consumed, created, id);
CREATE TABLE IF NOT EXISTS proactive_runs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 rule_id TEXT NOT NULL REFERENCES proactive_rules(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES proactive_events(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed')),
 payload TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 lease_until INTEGER,
 claim_token TEXT,
 result TEXT,
 error TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 finished INTEGER,
 UNIQUE(rule_id, event_id));
CREATE INDEX IF NOT EXISTS proactive_run_claim
 ON proactive_runs(status, lease_until, created, id);
CREATE INDEX IF NOT EXISTS proactive_run_workspace
 ON proactive_runs(workspace_id, created, id);
CREATE TABLE IF NOT EXISTS proactive_messages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES proactive_runs(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 body TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(run_id));
CREATE INDEX IF NOT EXISTS proactive_message_workspace
 ON proactive_messages(workspace_id, created, id);
'''

MAX_ID = 128
MAX_KIND = 64
MAX_NAME = 80
MAX_DEDUPE = 200
MAX_EVENT_PAYLOAD = 6000
MAX_RUN_PAYLOAD = 8000
MAX_RESULT = 8000
MAX_ERROR = 500
MAX_BODY = 4000
MAX_LIMIT = 100
MAX_COOLDOWN = 2592000
MAX_DAILY_BUDGET = 10000
MAX_LEASE = 604800
DAY = 86400
TERMINAL = ('succeeded', 'failed')


def ensure_schema(db):
    """Create the proactive tables/indexes if absent. Safe to call repeatedly."""
    db.executescript(SCHEMA)


def _now(value):
    if type(value) is not int or value < 0:
        raise ValueError('now must be a non-negative integer')
    return value


def _text(value, field, limit, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError(f'{field} must be a string')
    if not allow_empty and not value.strip():
        raise ValueError(f'{field} must not be empty')
    if len(value) > limit:
        raise ValueError(f'{field} exceeds {limit} characters')
    if '\x00' in value:
        raise ValueError(f'{field} must not contain NUL')
    try:
        value.encode('utf-8')
    except UnicodeError as exc:
        raise ValueError(f'{field} is not valid Unicode') from exc
    return value


def _optional(value, field, limit):
    if value is None or value == '':
        return None
    return _text(value, field, limit)


def _payload(value, limit):
    if not isinstance(value, dict):
        raise ValueError('payload must be a JSON object')
    try:
        text = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise ValueError('payload is not JSON serializable') from exc
    if len(text) > limit:
        raise ValueError(f'payload exceeds {limit} characters')
    return text


def _json(text, fallback):
    if not text:
        return fallback
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return fallback
    return value if isinstance(value, dict) else fallback


def rule_view(row):
    return {
        'id': row['id'], 'workspace_id': row['workspace_id'], 'name': row['name'],
        'enabled': bool(row['enabled']), 'event_kind': row['event_kind'],
        'source_type': row['source_type'], 'conversation_id': row['conversation_id'],
        'agent_id': row['agent_id'], 'cooldown_seconds': row['cooldown_seconds'],
        'daily_budget': row['daily_budget'], 'created': row['created'],
        'updated': row['updated'],
    }


def run_view(row):
    return {
        'id': row['id'], 'workspace_id': row['workspace_id'], 'rule_id': row['rule_id'],
        'event_id': row['event_id'], 'status': row['status'],
        'payload': _json(row['payload'], {}), 'attempts': row['attempts'],
        'lease_until': row['lease_until'],
        'result': _json(row['result'], None) if row['result'] is not None else None,
        'error': row['error'], 'created': row['created'], 'updated': row['updated'],
        'finished': row['finished'],
    }


def message_view(row):
    return {
        'id': row['id'], 'workspace_id': row['workspace_id'], 'run_id': row['run_id'],
        'conversation_id': row['conversation_id'], 'body': row['body'],
        'created': row['created'],
    }


def _normalize_rule(rule):
    if not isinstance(rule, dict):
        raise ValueError('rule must be an object')
    rule_id = rule.get('id')
    rule_id = uuid4().hex if rule_id is None else _text(rule_id, 'id', 64)
    name = rule.get('name', 'rule')
    name = 'rule' if name is None else _text(name, 'name', MAX_NAME)
    event_kind = _text(rule.get('event_kind'), 'event_kind', MAX_KIND)
    source_type = _optional(rule.get('source_type'), 'source_type', MAX_KIND)
    conversation_id = _optional(rule.get('conversation_id'), 'conversation_id', MAX_ID)
    agent_id = _optional(rule.get('agent_id'), 'agent_id', MAX_ID)
    enabled = rule.get('enabled', True)
    if enabled not in (True, False, 0, 1):
        raise ValueError('enabled must be a boolean')
    cooldown = rule.get('cooldown_seconds', 0)
    if type(cooldown) is not int or not 0 <= cooldown <= MAX_COOLDOWN:
        raise ValueError('cooldown_seconds must be a bounded non-negative integer')
    budget = rule.get('daily_budget', 100)
    if type(budget) is not int or not 0 <= budget <= MAX_DAILY_BUDGET:
        raise ValueError('daily_budget must be a bounded non-negative integer')
    return {
        'id': rule_id, 'name': name, 'enabled': 1 if enabled else 0,
        'event_kind': event_kind, 'source_type': source_type,
        'conversation_id': conversation_id, 'agent_id': agent_id,
        'cooldown_seconds': cooldown, 'daily_budget': budget,
    }


def upsert_rule(db, workspace_id, rule, now):
    """Insert or replace one rule. Pass rule['id'] to update an existing rule."""
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    now = _now(now)
    item = _normalize_rule(rule)
    existing = db.execute('SELECT workspace_id, created FROM proactive_rules WHERE id=?',
                          (item['id'],)).fetchone()
    if existing is not None and existing['workspace_id'] != workspace_id:
        raise ValueError('rule id belongs to another workspace')
    created = existing['created'] if existing is not None else now
    db.execute(
        'INSERT INTO proactive_rules '
        '(id, workspace_id, name, enabled, event_kind, source_type, conversation_id, '
        'agent_id, cooldown_seconds, daily_budget, created, updated) '
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) '
        'ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, '
        'event_kind=excluded.event_kind, source_type=excluded.source_type, '
        'conversation_id=excluded.conversation_id, agent_id=excluded.agent_id, '
        'cooldown_seconds=excluded.cooldown_seconds, daily_budget=excluded.daily_budget, '
        'updated=excluded.updated',
        (item['id'], workspace_id, item['name'], item['enabled'], item['event_kind'],
         item['source_type'], item['conversation_id'], item['agent_id'],
         item['cooldown_seconds'], item['daily_budget'], created, now),
    )
    return rule_view(db.execute('SELECT * FROM proactive_rules WHERE id=?',
                                (item['id'],)).fetchone())


def list_rules(db, workspace_id):
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    rows = db.execute('SELECT * FROM proactive_rules WHERE workspace_id=? '
                      'ORDER BY created, id', (workspace_id,)).fetchall()
    return [rule_view(row) for row in rows]


def remove_rule(db, workspace_id, rule_id):
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    rule_id = _text(rule_id, 'rule_id', MAX_ID)
    return db.execute('DELETE FROM proactive_rules WHERE workspace_id=? AND id=?',
                      (workspace_id, rule_id)).rowcount > 0


def record_event(db, workspace_id, kind, source_type, source_id, payload, dedupe_key, now):
    """Persist one event; (workspace_id, dedupe_key) makes replay harmless."""
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    kind = _text(kind, 'kind', MAX_KIND)
    source_type = _text(source_type, 'source_type', MAX_KIND)
    source_id = _text(source_id, 'source_id', MAX_ID)
    dedupe_key = _text(dedupe_key, 'dedupe_key', MAX_DEDUPE)
    now = _now(now)
    body = _payload(payload, MAX_EVENT_PAYLOAD)
    existing = db.execute('SELECT id FROM proactive_events WHERE workspace_id=? AND dedupe_key=?',
                          (workspace_id, dedupe_key)).fetchone()
    if existing is not None:
        return existing['id']
    event_id = uuid4().hex
    try:
        db.execute('INSERT INTO proactive_events '
                   '(id, workspace_id, kind, source_type, source_id, payload, dedupe_key, '
                   'consumed, created) VALUES (?,?,?,?,?,?,?,0,?)',
                   (event_id, workspace_id, kind, source_type, source_id, body,
                    dedupe_key, now))
    except sqlite3.IntegrityError:
        existing = db.execute(
            'SELECT id FROM proactive_events WHERE workspace_id=? AND dedupe_key=?',
            (workspace_id, dedupe_key)).fetchone()
        if existing is None:
            raise
        return existing['id']
    return event_id


def _event_doc(event):
    return _json(event['payload'], {})


def _matches(rule, event, doc):
    if rule['event_kind'] != event['kind']:
        return False
    if rule['source_type'] and rule['source_type'] != event['source_type']:
        return False
    if rule['conversation_id']:
        value = doc.get('conversation_id')
        if value is None and event['source_type'] == 'conversation':
            value = event['source_id']
        if value != rule['conversation_id']:
            return False
    if rule['agent_id']:
        value = doc.get('agent_id')
        if value is None and event['source_type'] == 'agent':
            value = event['source_id']
        if value != rule['agent_id']:
            return False
    return True


def evaluate(db, workspace_id, now, budget=100):
    """Match unconsumed events to enabled rules and queue at most ``budget`` runs.

    An event is consumed once at least one run is created for it. A rule respects
    its cooldown (based on its newest run) and its daily budget (UTC-day bucket).
    Events blocked only by cooldown/budget stay unconsumed for a later evaluation.
    """
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    now = _now(now)
    if type(budget) is not int or not 0 <= budget <= 1000:
        raise ValueError('budget must be an integer between 0 and 1000')
    rules = db.execute('SELECT * FROM proactive_rules WHERE workspace_id=? AND enabled=1 '
                       'ORDER BY created, id', (workspace_id,)).fetchall()
    events = db.execute('SELECT * FROM proactive_events WHERE workspace_id=? AND consumed=0 '
                        'ORDER BY created, id', (workspace_id,)).fetchall()
    if not rules or not events or budget == 0:
        return []
    day_start = (now // DAY) * DAY
    last, counts = {}, {}
    for rule in rules:
        newest = db.execute('SELECT MAX(created) FROM proactive_runs WHERE rule_id=?',
                            (rule['id'],)).fetchone()[0]
        last[rule['id']] = newest
        counts[rule['id']] = db.execute(
            'SELECT COUNT(*) FROM proactive_runs WHERE rule_id=? AND created>=? AND created<?',
            (rule['id'], day_start, day_start + DAY)).fetchone()[0]
    created, consumed, made = [], [], 0
    for event in events:
        if made >= budget:
            break
        doc = _event_doc(event)
        matched = truncated = False
        for rule in rules:
            if made >= budget:
                truncated = True
                break
            if not _matches(rule, event, doc):
                continue
            if rule['cooldown_seconds'] and last[rule['id']] is not None:
                if now - last[rule['id']] < rule['cooldown_seconds']:
                    continue
            if counts[rule['id']] >= rule['daily_budget']:
                continue
            existing = db.execute(
                'SELECT id FROM proactive_runs WHERE rule_id=? AND event_id=?',
                (rule['id'], event['id'])).fetchone()
            if existing is not None:
                matched = True
                continue
            payload = {
                'workspace_id': workspace_id,
                'rule': {'id': rule['id'], 'name': rule['name']},
                'event': {
                    'id': event['id'], 'kind': event['kind'],
                    'source_type': event['source_type'], 'source_id': event['source_id'],
                    'created': event['created'], 'payload': doc,
                },
                'matched_at': now,
            }
            created.append(enqueue_run(
                db, workspace_id, rule['id'], event['id'], payload, now))
            made += 1
            last[rule['id']] = now
            counts[rule['id']] += 1
            matched = True
        if matched and not truncated:
            consumed.append(event['id'])
    if consumed:
        marks = ','.join('?' * len(consumed))
        db.execute(f'UPDATE proactive_events SET consumed=1 WHERE workspace_id=? '
                   f'AND id IN ({marks})', (workspace_id, *consumed))
    return created


def enqueue_run(db, workspace_id, rule_id, event_id, payload, now, status='queued'):
    """Insert one run for a (rule_id, event_id) pair; a replay returns the existing row."""
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    rule_id = _text(rule_id, 'rule_id', MAX_ID)
    event_id = _text(event_id, 'event_id', MAX_ID)
    now = _now(now)
    if status not in ('queued', 'claimed'):
        raise ValueError('status must be queued or claimed')
    body = _payload(payload, MAX_RUN_PAYLOAD)
    rule = db.execute('SELECT id FROM proactive_rules WHERE workspace_id=? AND id=?',
                      (workspace_id, rule_id)).fetchone()
    if rule is None:
        raise ValueError('unknown rule for this workspace')
    event = db.execute('SELECT id FROM proactive_events WHERE workspace_id=? AND id=?',
                       (workspace_id, event_id)).fetchone()
    if event is None:
        raise ValueError('unknown event for this workspace')
    existing = db.execute('SELECT * FROM proactive_runs WHERE rule_id=? AND event_id=?',
                          (rule_id, event_id)).fetchone()
    if existing is not None:
        return run_view(existing)
    run_id = uuid4().hex
    try:
        db.execute('INSERT INTO proactive_runs '
                   '(id, workspace_id, rule_id, event_id, status, payload, attempts, '
                   'lease_until, claim_token, result, error, created, updated, finished) '
                   'VALUES (?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,?,?,NULL)',
                   (run_id, workspace_id, rule_id, event_id, status, body, now, now))
    except sqlite3.IntegrityError:
        existing = db.execute('SELECT * FROM proactive_runs WHERE rule_id=? AND event_id=?',
                              (rule_id, event_id)).fetchone()
        if existing is None:
            raise
        return run_view(existing)
    return run_view(db.execute('SELECT * FROM proactive_runs WHERE id=?',
                               (run_id,)).fetchone())


def claim_runs(db, now, limit, lease_seconds, workspace_id=None):
    """Atomically lease up to ``limit`` queued or expired-claimed runs.

    ``workspace_id`` is an optional scope for a per-workspace worker; omitting it
    lets a single worker claim across all workspaces.
    """
    now = _now(now)
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError('limit must be an integer between 1 and 1000')
    if type(lease_seconds) is not int or not 1 <= lease_seconds <= MAX_LEASE:
        raise ValueError('lease_seconds must be a bounded positive integer')
    condition = ("(status='queued' OR (status='claimed' AND lease_until IS NOT NULL "
                 'AND lease_until<=?))')
    scope = []
    if workspace_id is not None:
        workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
        condition += ' AND workspace_id=?'
        scope.append(workspace_id)
    token = uuid4().hex
    expires = now + lease_seconds
    db.execute(
        "UPDATE proactive_runs SET status='claimed', claim_token=?, lease_until=?, "
        'attempts=attempts+1, updated=? WHERE id IN (SELECT id FROM proactive_runs '
        f'WHERE {condition} ORDER BY created, id LIMIT ?)',
        (token, expires, now, now, *scope, limit))
    rows = db.execute('SELECT * FROM proactive_runs WHERE claim_token=? '
                      'ORDER BY created, id', (token,)).fetchall()
    return [run_view(row) for row in rows]


def complete_run(db, run_id, status, result, now):
    """Finish a run successfully (or with an explicit failed status). Idempotent."""
    run_id = _text(run_id, 'run_id', MAX_ID)
    now = _now(now)
    if status not in TERMINAL:
        raise ValueError('status must be succeeded or failed')
    body = _payload(result if result is not None else {}, MAX_RESULT)
    row = db.execute('SELECT * FROM proactive_runs WHERE id=?', (run_id,)).fetchone()
    if row is None:
        return None
    if row['status'] in TERMINAL:
        return run_view(row)
    db.execute('UPDATE proactive_runs SET status=?, result=?, error=NULL, '
               'lease_until=NULL, claim_token=NULL, updated=?, finished=? WHERE id=?',
               (status, body, now, now, run_id))
    return run_view(db.execute('SELECT * FROM proactive_runs WHERE id=?',
                               (run_id,)).fetchone())


def fail_run(db, run_id, error, now, retryable=True):
    """Record a failure; a retryable failure returns the run to the queued state."""
    run_id = _text(run_id, 'run_id', MAX_ID)
    now = _now(now)
    error = _text(error, 'error', MAX_ERROR)
    if type(retryable) is not bool:
        raise ValueError('retryable must be a boolean')
    row = db.execute('SELECT * FROM proactive_runs WHERE id=?', (run_id,)).fetchone()
    if row is None:
        return None
    if row['status'] in TERMINAL:
        return run_view(row)
    if retryable:
        db.execute("UPDATE proactive_runs SET status='queued', error=?, "
                   'lease_until=NULL, claim_token=NULL, updated=?, finished=NULL WHERE id=?',
                   (error, now, run_id))
    else:
        db.execute("UPDATE proactive_runs SET status='failed', error=?, "
                   'lease_until=NULL, claim_token=NULL, updated=?, finished=? WHERE id=?',
                   (error, now, now, run_id))
    return run_view(db.execute('SELECT * FROM proactive_runs WHERE id=?',
                               (run_id,)).fetchone())


def record_message(db, workspace_id, run_id, conversation_id, body, now):
    """Store one bounded message per run. Replaying the same run returns the first."""
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    run_id = _text(run_id, 'run_id', MAX_ID)
    conversation_id = _text(conversation_id, 'conversation_id', MAX_ID)
    body = _text(body, 'body', MAX_BODY)
    now = _now(now)
    run = db.execute('SELECT workspace_id FROM proactive_runs WHERE id=?',
                     (run_id,)).fetchone()
    if run is None:
        raise ValueError('unknown run')
    if run['workspace_id'] != workspace_id:
        raise ValueError('run belongs to another workspace')
    existing = db.execute('SELECT * FROM proactive_messages WHERE run_id=?',
                          (run_id,)).fetchone()
    if existing is not None:
        return message_view(existing)
    message_id = uuid4().hex
    try:
        db.execute('INSERT INTO proactive_messages '
                   '(id, workspace_id, run_id, conversation_id, body, created) '
                   'VALUES (?,?,?,?,?,?)',
                   (message_id, workspace_id, run_id, conversation_id, body, now))
    except sqlite3.IntegrityError:
        existing = db.execute('SELECT * FROM proactive_messages WHERE run_id=?',
                              (run_id,)).fetchone()
        if existing is None:
            raise
        return message_view(existing)
    return message_view(db.execute('SELECT * FROM proactive_messages WHERE id=?',
                                   (message_id,)).fetchone())


def list_messages(db, workspace_id, limit=100, cursor=None):
    """List workspace messages in (created, id) order; ``cursor`` is the last id."""
    workspace_id = _text(workspace_id, 'workspace_id', MAX_ID)
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise ValueError('limit must be an integer between 1 and 100')
    if cursor:
        cursor = _text(cursor, 'cursor', MAX_ID)
        row = db.execute('SELECT created, id FROM proactive_messages '
                         'WHERE workspace_id=? AND id=?',
                         (workspace_id, cursor)).fetchone()
        if row is None:
            raise ValueError('unknown cursor')
        rows = db.execute('SELECT * FROM proactive_messages WHERE workspace_id=? '
                          'AND (created>? OR (created=? AND id>?)) '
                          'ORDER BY created, id LIMIT ?',
                          (workspace_id, row['created'], row['created'],
                           row['id'], limit)).fetchall()
    else:
        rows = db.execute('SELECT * FROM proactive_messages WHERE workspace_id=? '
                          'ORDER BY created, id LIMIT ?',
                          (workspace_id, limit)).fetchall()
    return [message_view(row) for row in rows]
