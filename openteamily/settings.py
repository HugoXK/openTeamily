"""Per-account interface preferences (issue #4, domain 10).

Self-written for OpenTeamily; no upstream or Teamily source. Option semantics
follow the 2026-11-16 round-1 Teamily settings contrast. The 18 language codes
were not listed in that report, so this is a documented candidate list, not a
claim that Teamily's exact locale set has been recaptured.
"""
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), updated INTEGER NOT NULL);
'''

LANGUAGES = (
    'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt-BR', 'ru',
    'it', 'vi', 'th', 'id', 'ar', 'hi', 'tr', 'ms',
)
TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')

# name -> (allowed values or kind, default). Booleans use (True, False).
FIELDS = {
    'appearance': (('system', 'light', 'dark', 'auto'), 'system'),
    'appearance_schedule': (('sunset_sunrise', 'custom'), 'sunset_sunrise'),
    'appearance_start': ('time', '18:00'),
    'appearance_end': ('time', '07:00'),
    'language': (LANGUAGES, 'zh-CN'),
    'chat_language': (('auto',) + LANGUAGES, 'auto'),
    'auto_translate': ((True, False), False),
    'send_shortcut': (('enter', 'mod_enter'), 'enter'),
    'message_folding': (('compact', 'standard', 'none'), 'standard'),
    'document_cards': ((True, False), False),
    'link_previews': ((True, False), True),
    'task_completion_reminders': ((True, False), True),
    'likes_visibility': (('everyone', 'private'), 'everyone'),
    'favorites_visibility': (('everyone', 'private'), 'everyone'),
}


def defaults():
    return {name: default for name, (_, default) in FIELDS.items()}


def valid_value(name, value):
    allowed, _ = FIELDS[name]
    if allowed == 'time':
        return type(value) is str and TIME.fullmatch(value)
    if isinstance(allowed[0], bool):
        return type(value) is bool
    return type(value) is str and value in allowed


def migrate(stored):
    """Map a previously stored document onto current keys. Unknown keys stay dropped."""
    result = {}
    if not isinstance(stored, dict):
        return result
    if 'message_folding' not in stored and 'fold_long_messages' in stored:
        flag = stored['fold_long_messages']
        if flag is True:
            stored = dict(stored, message_folding='standard')
        elif flag is False:
            stored = dict(stored, message_folding='none')
    for name, value in stored.items():
        if name in FIELDS and valid_value(name, value):
            result[name] = value
    return result


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
        result.update(migrate(stored))
    return {'values': result, 'revision': revision}


def normalize_changes(changes):
    """Validate a write payload. Accepts the retired fold_long_messages boolean as an alias."""
    if not isinstance(changes, dict) or not changes:
        return None
    if 'fold_long_messages' in changes and 'message_folding' in changes:
        return None
    result = {}
    for name, value in changes.items():
        if name == 'fold_long_messages':
            if type(value) is not bool:
                return None
            result['message_folding'] = 'standard' if value else 'none'
            continue
        if name not in FIELDS or not valid_value(name, value):
            return None
        result[name] = value
    return result
