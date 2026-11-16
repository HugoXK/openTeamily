"""Per-account interface preferences (issue #4, domain 10).

Self-written for OpenTeamily; no upstream or Teamily source. The option values
below are OpenTeamily defaults. They have NOT been compared with Teamily's real
settings page yet; see docs/SETTINGS.md before claiming parity.
"""
import json

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), updated INTEGER NOT NULL);
'''

# name -> (allowed values, default). Booleans use (True, False).
FIELDS = {
    'appearance': (('system', 'light', 'dark'), 'system'),
    'language': (('zh-CN', 'en'), 'zh-CN'),
    'send_shortcut': (('enter', 'mod_enter'), 'enter'),
    'fold_long_messages': ((True, False), True),
    'document_cards': ((True, False), True),
}


def defaults():
    return {name: default for name, (_, default) in FIELDS.items()}


def valid_value(name, value):
    allowed, _ = FIELDS[name]
    if isinstance(allowed[0], bool):
        return type(value) is bool
    return type(value) is str and value in allowed


def view(row):
    """Return the stored document merged over defaults; unknown/invalid stored keys are ignored."""
    result = defaults()
    revision = 0
    if row is not None:
        revision = row['revision']
        try:
            stored = json.loads(row['document'])
        except ValueError:
            stored = {}
        if isinstance(stored, dict):
            for name, value in stored.items():
                if name in FIELDS and valid_value(name, value):
                    result[name] = value
    return {'values': result, 'revision': revision}
