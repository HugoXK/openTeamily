"""Per-user notification preferences (issue #275).

Self-written for OpenTeamily; no upstream or Teamily source. One row per user
holds a JSON document with one boolean per category, and the server enforces it:
@mentions are dropped at the write point in :mod:`openteamily.notifications`,
while the derived task-completion and artifact items are filtered out of the
server-side queries. Hiding them in the settings page would not be enough.
"""
import json

CATEGORIES = (
    ('mentions', '@提及', '别人在会话里 @ 你'),
    ('task_completion', '任务完成', '你发起的智能体任务结束'),
    ('artifacts', '作品通知', '同会话的其他人保存了作品'),
)
DEFAULT = {key: True for key, _, _ in CATEGORIES}
KEYS = tuple(DEFAULT)

SCHEMA = '''
CREATE TABLE IF NOT EXISTS notification_prefs (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 document TEXT NOT NULL,
 updated INTEGER NOT NULL);
'''


def categories_view():
    return [{'key': key, 'label': label, 'about': about} for key, label, about in CATEGORIES]


def load(db, user_id):
    row = db.execute('SELECT document FROM notification_prefs WHERE user_id=?', (user_id,)).fetchone()
    values = dict(DEFAULT)
    if row is not None:
        try:
            stored = json.loads(row['document'])
        except ValueError:
            stored = {}
        if isinstance(stored, dict):
            for key in KEYS:
                if stored.get(key) is True or stored.get(key) is False:
                    values[key] = stored[key]
    return values


def enabled(db, user_id, category):
    return load(db, user_id).get(category, True)


def payload(db, user_id):
    return {'prefs': load(db, user_id), 'categories': categories_view()}


def update(db, user_id, changes, now):
    """Apply one validated change set and return the same payload GET returns."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError('Provide a non-empty changes object')
    for key, value in changes.items():
        if key not in KEYS:
            raise ValueError('Unknown notification category')
        if value is not True and value is not False:
            raise ValueError('Notification categories are on or off')
    values = dict(load(db, user_id), **changes)
    document = json.dumps(values, sort_keys=True, separators=(',', ':'))
    db.execute('INSERT INTO notification_prefs VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET '
               'document=excluded.document, updated=excluded.updated', (user_id, document, now))
    return payload(db, user_id)
