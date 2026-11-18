"""Self-service account profile and public handle projection.

Self-written for OpenTeamily; no upstream or Teamily source. The observed 2026-11-18
profile editor fields are the basis (name, Teamily ID handle, bio, tags, gender,
location, website, private life goals, avatar). This slice implements the text
fields and private goals; avatar upload and social posts/follows/likes are not
included. The public projection never returns goals, email, or account ids.
"""
import json
import re
from urllib.parse import urlsplit

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_profiles (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 handle TEXT NOT NULL,
 handle_lower TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 bio TEXT NOT NULL,
 tags TEXT NOT NULL,
 gender TEXT NOT NULL CHECK(gender IN ('','male','female','other')),
 location TEXT NOT NULL,
 website TEXT NOT NULL,
 goals TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_profile_handle ON user_profiles(handle_lower);
'''

NAME_MAX = 40
HANDLE_MIN, HANDLE_MAX = 3, 30
BIO_MAX = 200
TAG_MAX = 8
TAG_LEN = 20
LOCATION_MAX = 80
WEBSITE_MAX = 200
GOAL_MAX = 200
GOALS = ('health', 'finance', 'career', 'hobbies', 'family', 'productivity', 'other')
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HANDLE = re.compile(r'[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]')
RESERVED = {
    'admin', 'api', 'settings', 'team', 'profile', 'chat', 'agents', 'discover',
    'memory', 'space', 'download', 'pricing', 'login', 'logout', 'support',
    'help', 'about', 'me', 'u', 'p', 'v1', 'new', 'edit', 'share', 'install',
    'shell', 'runtimes', 'members', 'automations', 'artifacts', 'guide',
}


def valid_handle(value):
    return (isinstance(value, str) and HANDLE_MIN <= len(value) <= HANDLE_MAX
            and bool(HANDLE.fullmatch(value)) and '..' not in value
            and value not in RESERVED)


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= NAME_MAX and not CONTROL.search(value)


def valid_bio(value):
    return isinstance(value, str) and len(value) <= BIO_MAX and not CONTROL.search(value)


def valid_location(value):
    return isinstance(value, str) and len(value.strip()) <= LOCATION_MAX and not CONTROL.search(value)


def valid_website(value):
    if value == '':
        return True
    if not isinstance(value, str) or len(value) > WEBSITE_MAX or CONTROL.search(value):
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (parsed.scheme in ('http', 'https') and bool(parsed.hostname)
            and not parsed.username and not parsed.password)


def valid_tags(value):
    if not isinstance(value, list) or len(value) > TAG_MAX:
        return False
    seen = set()
    for tag in value:
        if not isinstance(tag, str) or not 1 <= len(tag.strip()) <= TAG_LEN or CONTROL.search(tag):
            return False
        key = tag.strip().casefold()
        if key in seen:
            return False
        seen.add(key)
    return True


def valid_goals(value):
    if not isinstance(value, dict):
        return False
    for key, text in value.items():
        if key not in GOALS or not isinstance(text, str) or len(text.strip()) > GOAL_MAX:
            return False
        if CONTROL.search(text):
            return False
    return True


def valid_gender(value):
    return value in ('', 'male', 'female', 'other')


def sanitize_handle(username):
    text = re.sub(r'[^a-z0-9._]+', '.', (username or '').lower())
    text = re.sub(r'\.{2,}', '.', text).strip('.')
    if len(text) < HANDLE_MIN:
        text = (text + 'user')[:HANDLE_MAX]
    text = text[:HANDLE_MAX].strip('.')
    return text or 'user'


def _tags(raw):
    try:
        value = json.loads(raw) if raw else []
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _goals(raw):
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def view(row):
    return {
        'handle': row['handle'],
        'name': row['name'],
        'bio': row['bio'],
        'tags': _tags(row['tags']),
        'gender': row['gender'],
        'location': row['location'],
        'website': row['website'],
        'goals': _goals(row['goals']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


def public_view(row):
    return {
        'handle': row['handle'],
        'name': row['name'],
        'bio': row['bio'],
        'tags': _tags(row['tags']),
        'gender': row['gender'],
        'location': row['location'],
        'website': row['website'],
        'created': row['created'],
    }


def load(db, user_id):
    return db.execute('SELECT * FROM user_profiles WHERE user_id=?', (user_id,)).fetchone()


def load_handle(db, handle_lower):
    return db.execute('SELECT * FROM user_profiles WHERE handle_lower=?', (handle_lower,)).fetchone()


def default_handle(db, username):
    base = sanitize_handle(username)
    candidate = base
    for index in range(1, 1000):
        if valid_handle(candidate) and load_handle(db, candidate) is None:
            return candidate
        suffix = '-%d' % index
        candidate = (base[:HANDLE_MAX - len(suffix)] + suffix).strip('.')
    return None


def serialize_tags(tags):
    return json.dumps([tag.strip() for tag in tags], ensure_ascii=False, separators=(',', ':'))


def serialize_goals(goals):
    return json.dumps({key: goals[key].strip() for key in GOALS if goals.get(key, '').strip()},
                      ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def normalize_changes(changes):
    if not isinstance(changes, dict) or not changes:
        return None
    out = {}
    if 'handle' in changes:
        handle = changes['handle'].strip().lower() if isinstance(changes['handle'], str) else ''
        if not valid_handle(handle):
            return None
        out['handle'] = handle
    if 'name' in changes:
        if not valid_name(changes['name']):
            return None
        out['name'] = changes['name'].strip()
    if 'bio' in changes:
        if not valid_bio(changes['bio']):
            return None
        out['bio'] = changes['bio'].strip()
    if 'tags' in changes:
        if not valid_tags(changes['tags']):
            return None
        out['tags'] = [tag.strip() for tag in changes['tags']]
    if 'gender' in changes:
        if not valid_gender(changes['gender']):
            return None
        out['gender'] = changes['gender']
    if 'location' in changes:
        if not valid_location(changes['location']):
            return None
        out['location'] = changes['location'].strip()
    if 'website' in changes:
        value = changes['website'].strip() if isinstance(changes['website'], str) else ''
        if not valid_website(value):
            return None
        out['website'] = value
    if 'goals' in changes:
        if not valid_goals(changes['goals']):
            return None
        out['goals'] = {key: value.strip() for key, value in changes['goals'].items()}
    return out
