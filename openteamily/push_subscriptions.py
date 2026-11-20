"""Local Web Push device subscription registry and bounded payload builder.

Self-written for OpenTeamily; no upstream or Teamily source. This module owns
per-user, per-device push endpoints, their public key material and topic
selection. It does not sign VAPID requests, encrypt payloads or send HTTP; the
outbox/delivery worker must do that later with the stored key material. The
``p256dh`` and ``auth`` values are browser subscription key material, not
account secrets, and this module never logs them or any request field.

Preferences from the notification-prefs work and follower notifications are a
different concern: they decide *whether* a notice exists, while this registry
only records *where* a user asked to receive it. Subscription rows are scoped by
``user_id`` so one account can never read or mutate another account's devices.
"""

import json
from urllib.parse import urlsplit
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL,
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 user_agent TEXT,
 topics TEXT NOT NULL DEFAULT '[]',
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 last_seen INTEGER NOT NULL,
 UNIQUE(user_id, endpoint));
CREATE INDEX IF NOT EXISTS push_subscription_user
 ON push_subscriptions(user_id, enabled, updated);
CREATE INDEX IF NOT EXISTS push_subscription_seen
 ON push_subscriptions(enabled, last_seen);
'''

# Topics mirror the notification kinds this tree can already produce.
TOPICS = frozenset(('mention', 'agent_reply', 'artifact', 'automation_reminder', 'follow_work'))

MAX_ENDPOINT = 2048
MAX_KEY_MATERIAL = 1024
MAX_USER_AGENT = 512
MAX_TOPIC_INPUT = 32
MAX_TOPICS = len(TOPICS)

MAX_TITLE = 200
MAX_BODY = 2000
MAX_TAG = 64
MAX_URL = 2048
MAX_ICON = 2048
MAX_DATA = 4096
MAX_PAYLOAD = 8192


def ensure_schema(db):
    """Create the registry table and indexes; safe to call on every startup."""
    db.executescript(SCHEMA)


def _now(value):
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError('now must be an integer timestamp') from exc


def _control_free(value):
    return not any(ord(char) < 0x20 or ord(char) == 0x7f for char in value)


def _endpoint(value):
    if not isinstance(value, str) or not value:
        raise ValueError('endpoint must be a non-empty string')
    if len(value) > MAX_ENDPOINT:
        raise ValueError('endpoint is too long')
    if not _control_free(value) or any(char.isspace() for char in value):
        raise ValueError('endpoint contains whitespace or control characters')
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port
    except ValueError as exc:
        raise ValueError('endpoint is not a valid URL') from exc
    if parts.scheme.lower() != 'https' or not host:
        raise ValueError('endpoint must be an absolute https URL')
    if parts.username is not None or parts.password is not None:
        raise ValueError('endpoint must not contain user information')
    return value


def _key_material(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError(name + ' must be a non-empty string')
    if len(value) > MAX_KEY_MATERIAL:
        raise ValueError(name + ' is too long')
    if not _control_free(value):
        raise ValueError(name + ' contains control characters')
    return value


def _user_agent(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('user_agent must be a string')
    if len(value) > MAX_USER_AGENT:
        raise ValueError('user_agent is too long')
    if not _control_free(value):
        raise ValueError('user_agent contains control characters')
    return value


def _topics(value, none_means_empty):
    if value is None:
        return [] if none_means_empty else None
    if not isinstance(value, (list, tuple)):
        raise ValueError('topics must be a list of strings')
    if len(value) > MAX_TOPIC_INPUT:
        raise ValueError('too many topics')
    result = []
    for topic in value:
        if not isinstance(topic, str) or topic not in TOPICS:
            raise ValueError('unknown push topic')
        if topic not in result:
            result.append(topic)
    if len(result) > MAX_TOPICS:
        raise ValueError('too many topics')
    return result


def _serialize_topics(topics):
    return json.dumps(topics, separators=(',', ':'), ensure_ascii=False)


def _load_topics(raw):
    try:
        stored = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(stored, list):
        return []
    return [topic for topic in stored if isinstance(topic, str) and topic in TOPICS]


def view(row):
    return {'id': row['id'], 'user_id': row['user_id'], 'endpoint': row['endpoint'],
            'p256dh': row['p256dh'], 'auth': row['auth'], 'user_agent': row['user_agent'],
            'topics': _load_topics(row['topics']), 'enabled': row['enabled'] == 1,
            'created': row['created'], 'updated': row['updated'], 'last_seen': row['last_seen']}


def register(db, user_id, endpoint, p256dh, auth, now, user_agent=None, topics=None):
    """Insert or update one device endpoint for a user and re-enable it.

    ``topics=None`` means an empty topic list. Returns the stored subscription
    view. The endpoint is the unique key together with ``user_id``.
    """
    endpoint = _endpoint(endpoint)
    p256dh = _key_material(p256dh, 'p256dh')
    auth = _key_material(auth, 'auth')
    user_agent = _user_agent(user_agent)
    topic_list = _topics(topics, none_means_empty=True)
    stamp = _now(now)
    db.execute(
        'INSERT INTO push_subscriptions '
        '(id,user_id,endpoint,p256dh,auth,user_agent,topics,enabled,created,updated,last_seen) '
        'VALUES(?,?,?,?,?,?,?,1,?,?,?) '
        'ON CONFLICT(user_id,endpoint) DO UPDATE SET '
        'p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, '
        'topics=excluded.topics, enabled=1, updated=excluded.updated, '
        'last_seen=excluded.last_seen',
        (uuid4().hex, user_id, endpoint, p256dh, auth, user_agent,
         _serialize_topics(topic_list), stamp, stamp, stamp))
    row = db.execute('SELECT * FROM push_subscriptions WHERE user_id=? AND endpoint=?',
                     (user_id, endpoint)).fetchone()
    return view(row)


def update_topics(db, user_id, subscription_id, topics, now):
    """Replace one own subscription's topics; return its view or None when not owned."""
    topic_list = _topics(topics, none_means_empty=True)
    cursor = db.execute(
        'UPDATE push_subscriptions SET topics=?, updated=? WHERE id=? AND user_id=?',
        (_serialize_topics(topic_list), _now(now), subscription_id, user_id))
    if cursor.rowcount != 1:
        return None
    row = db.execute('SELECT * FROM push_subscriptions WHERE id=? AND user_id=?',
                     (subscription_id, user_id)).fetchone()
    return view(row)


def remove(db, user_id, subscription_id):
    """Delete one own subscription; return whether a row was removed."""
    cursor = db.execute('DELETE FROM push_subscriptions WHERE id=? AND user_id=?',
                        (subscription_id, user_id))
    return cursor.rowcount == 1


def list_for_user(db, user_id):
    """Return every stored device for one user, oldest first, including disabled rows."""
    rows = db.execute(
        'SELECT * FROM push_subscriptions WHERE user_id=? ORDER BY created, id',
        (user_id,)).fetchall()
    return [view(row) for row in rows]


def deactivate(db, user_id, subscription_id, now):
    """Disable one own subscription without deleting its registry row."""
    cursor = db.execute(
        'UPDATE push_subscriptions SET enabled=0, updated=? WHERE id=? AND user_id=?',
        (_now(now), subscription_id, user_id))
    return cursor.rowcount == 1


def deactivate_expired(db, now, max_age_seconds):
    """Disable enabled subscriptions whose last_seen is older than the cutoff.

    Global by design: this is the periodic stale-device sweep. Returns the
    number of rows newly disabled.
    """
    if (not isinstance(max_age_seconds, int) or isinstance(max_age_seconds, bool)
            or max_age_seconds < 0):
        raise ValueError('max_age_seconds must be a non-negative integer')
    cutoff = _now(now) - max_age_seconds
    cursor = db.execute(
        'UPDATE push_subscriptions SET enabled=0, updated=? WHERE enabled=1 AND last_seen<?',
        (_now(now), cutoff))
    return cursor.rowcount


def _text(value, name, maximum, required=True):
    if not isinstance(value, str):
        raise ValueError(name + ' must be a string')
    if required and not value:
        raise ValueError(name + ' must not be empty')
    if len(value) > maximum:
        raise ValueError(name + ' is too long')
    if not _control_free(value):
        raise ValueError(name + ' contains control characters')
    return value


def _link(value, name, maximum):
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(name + ' must be a non-empty string')
    if len(value) > maximum:
        raise ValueError(name + ' is too long')
    if not _control_free(value) or any(char.isspace() for char in value):
        raise ValueError(name + ' contains whitespace or control characters')
    if value.startswith('/') and not value.startswith('//'):
        return value
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port
    except ValueError as exc:
        raise ValueError(name + ' is not a valid URL') from exc
    if parts.scheme.lower() != 'https' or not host:
        raise ValueError(name + ' must be a relative path or an https URL')
    if parts.username is not None or parts.password is not None:
        raise ValueError(name + ' must not contain user information')
    return value


def build_payload(title, body, url=None, tag=None, data=None, icon=None):
    """Build a bounded, plain notification document.

    This only validates and shapes the content. The caller still has to encrypt
    and VAPID-sign it before HTTP delivery. Optional fields are omitted when
    ``None`` so an absent ``url`` stays absent instead of becoming null.
    """
    payload = {
        'title': _text(title, 'title', MAX_TITLE),
        'body': _text(body, 'body', MAX_BODY, required=False),
    }
    checked_url = _link(url, 'url', MAX_URL)
    if checked_url is not None:
        payload['url'] = checked_url
    checked_tag = _text(tag, 'tag', MAX_TAG) if tag is not None else None
    if checked_tag is not None:
        payload['tag'] = checked_tag
    if data is not None:
        if not isinstance(data, dict):
            raise ValueError('data must be a JSON object')
        try:
            encoded = json.dumps(data, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError('data must be JSON serializable') from exc
        if len(encoded) > MAX_DATA:
            raise ValueError('data is too large')
        payload['data'] = data
    checked_icon = _link(icon, 'icon', MAX_ICON)
    if checked_icon is not None:
        payload['icon'] = checked_icon
    try:
        encoded = json.dumps(payload, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError('payload must be JSON serializable') from exc
    if len(encoded) > MAX_PAYLOAD:
        raise ValueError('payload is too large')
    return payload
