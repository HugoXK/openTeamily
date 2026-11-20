"""Owner-private personal contacts, groups and search.

Self-written for OpenTeamily; no upstream or Teamily source. This is an
address book that belongs to one account: every read and write is scoped by
``owner_id`` and the caller is responsible for authenticating that owner before
calling this module. There is no external address-book sync, import/export,
sharing, invitation or workspace visibility here, and the module is not wired
into the HTTP router yet. Error semantics are deliberate: a missing record
raises ``LookupError``, while an existing record owned by a different account
raises ``PermissionError``. The latter reveals that an opaque id exists but
never returns another owner's fields. Do not describe this as Teamily contact
parity; the surface has not been compared.
"""
import base64
import binascii
import json
import re
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS contacts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL,
 email TEXT,
 phone TEXT,
 company TEXT,
 notes TEXT,
 tags TEXT NOT NULL DEFAULT '[]',
 linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(owner_id, email));
CREATE INDEX IF NOT EXISTS contact_owner_name ON contacts(owner_id, display_name, id);
CREATE INDEX IF NOT EXISTS contact_owner_email ON contacts(owner_id, email);
CREATE INDEX IF NOT EXISTS contact_linked_user ON contacts(linked_user_id);
CREATE TABLE IF NOT EXISTS contact_groups (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(owner_id, name));
CREATE INDEX IF NOT EXISTS contact_group_owner ON contact_groups(owner_id, name);
CREATE TABLE IF NOT EXISTS contact_group_members (
 group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
 contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id, contact_id));
CREATE INDEX IF NOT EXISTS contact_group_member_contact
 ON contact_group_members(contact_id, group_id);
'''

DISPLAY_MAX = 80
EMAIL_MAX = 254
PHONE_MAX = 40
COMPANY_MAX = 120
NOTES_MAX = 2000
TAG_MAX = 12
TAG_LEN = 30
QUERY_MAX = 100
LIMIT_DEFAULT = 50
LIMIT_MAX = 100
CURSOR_MAX = 512
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
EMAIL = re.compile(r'[^@\s]+@[^@\s]+\.[^@\s]+')
CHANGE_FIELDS = ('display_name', 'email', 'phone', 'company', 'notes', 'tags', 'linked_user_id')
GROUP_SELECT = (
    'SELECT g.*, '
    '(SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id=g.id) AS contact_count '
    'FROM contact_groups g '
)


def ensure_schema(db):
    """Create this module's tables and indexes; safe to call repeatedly.

    Call outside a caller-managed transaction. The base store keeps schema
    version 1 and does not know about these tables, so tests and integrations
    must invoke this after opening the store.
    """
    for statement in SCHEMA.split(';'):
        statement = statement.strip()
        if statement:
            db.execute(statement)


def _display_name(value):
    if not isinstance(value, str):
        raise ValueError('display name must be text')
    text = value.strip()
    if not 1 <= len(text) <= DISPLAY_MAX or CONTROL.search(text):
        raise ValueError('display name is invalid')
    return text


def _optional_text(value, label, maximum):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or CONTROL.search(value):
        raise ValueError(label + ' is invalid')
    text = value.strip()
    return text or None


def _email(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('email must be text')
    text = value.strip().lower()
    if not text:
        return None
    if len(text) > EMAIL_MAX or CONTROL.search(text) or not EMAIL.fullmatch(text):
        raise ValueError('email is invalid')
    return text


def _tags(value):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError('tags must be a list')
    if len(value) > TAG_MAX:
        raise ValueError('too many tags')
    result = []
    seen = set()
    for tag in value:
        if not isinstance(tag, str):
            raise ValueError('tags must be text')
        text = tag.strip()
        if not 1 <= len(text) <= TAG_LEN or CONTROL.search(text):
            raise ValueError('tag is invalid')
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _tag_list(raw):
    try:
        value = json.loads(raw) if raw else []
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def _linked_user(db, value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('linked_user_id must be text')
    text = value.strip()
    if not text:
        return None
    if db.execute('SELECT 1 FROM users WHERE id=?', (text,)).fetchone() is None:
        raise LookupError('linked user not found')
    return text


def _group_name(value):
    if not isinstance(value, str):
        raise ValueError('group name must be text')
    text = value.strip()
    if not 1 <= len(text) <= DISPLAY_MAX or CONTROL.search(text):
        raise ValueError('group name is invalid')
    return text


def _like_escape(text):
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def _encode_cursor(name, contact_id):
    value = json.dumps({'name': name, 'id': contact_id}, ensure_ascii=False,
                       separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')


def _decode_cursor(token):
    if not isinstance(token, str) or not token or len(token) > CURSOR_MAX:
        raise ValueError('invalid cursor')
    try:
        padded = token + '=' * (-len(token) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))
    except (ValueError, UnicodeError, binascii.Error):
        raise ValueError('invalid cursor') from None
    if (not isinstance(value, dict) or set(value) != {'name', 'id'}
            or not isinstance(value['name'], str) or not isinstance(value['id'], str)
            or not value['id']):
        raise ValueError('invalid cursor')
    return value['name'], value['id']


def _load_contact(db, owner_id, contact_id):
    owner = db.execute('SELECT owner_id FROM contacts WHERE id=?', (contact_id,)).fetchone()
    if owner is None:
        raise LookupError('contact not found')
    if owner['owner_id'] != owner_id:
        raise PermissionError('contact belongs to another owner')
    return db.execute('SELECT * FROM contacts WHERE id=? AND owner_id=?',
                      (contact_id, owner_id)).fetchone()


def _load_group(db, owner_id, group_id):
    owner = db.execute('SELECT owner_id FROM contact_groups WHERE id=?', (group_id,)).fetchone()
    if owner is None:
        raise LookupError('group not found')
    if owner['owner_id'] != owner_id:
        raise PermissionError('group belongs to another owner')
    return db.execute(GROUP_SELECT + 'WHERE g.id=? AND g.owner_id=?',
                      (group_id, owner_id)).fetchone()


def view(row):
    return {
        'id': row['id'],
        'owner_id': row['owner_id'],
        'display_name': row['display_name'],
        'email': row['email'],
        'phone': row['phone'],
        'company': row['company'],
        'notes': row['notes'],
        'tags': _tag_list(row['tags']),
        'linked_user_id': row['linked_user_id'],
        'created': row['created'],
        'updated': row['updated'],
    }


def _group_view(row):
    return {
        'id': row['id'],
        'owner_id': row['owner_id'],
        'name': row['name'],
        'created': row['created'],
        'contact_count': row['contact_count'],
    }


def create_contact(db, owner_id, display_name, now, email=None, phone=None, company=None,
                   notes=None, tags=None, linked_user_id=None):
    """Insert one owner-private contact and return its view."""
    contact_id = uuid4().hex
    values = (
        contact_id, owner_id, _display_name(display_name), _email(email),
        _optional_text(phone, 'phone', PHONE_MAX),
        _optional_text(company, 'company', COMPANY_MAX),
        _optional_text(notes, 'notes', NOTES_MAX),
        json.dumps(_tags(tags), ensure_ascii=False, separators=(',', ':')),
        _linked_user(db, linked_user_id), now, now,
    )
    try:
        db.execute(
            'INSERT INTO contacts '
            '(id,owner_id,display_name,email,phone,company,notes,tags,linked_user_id,created,updated) '
            'VALUES(?,?,?,?,?,?,?,?,?,?,?)', values)
    except Exception as exc:
        if 'UNIQUE constraint failed' in str(exc):
            raise ValueError('duplicate email for owner') from exc
        raise
    return get_contact(db, owner_id, contact_id)


def get_contact(db, owner_id, contact_id):
    return view(_load_contact(db, owner_id, contact_id))


def update_contact(db, owner_id, contact_id, changes, now):
    """Validate and apply a partial update, returning the new view."""
    row = _load_contact(db, owner_id, contact_id)
    if not isinstance(changes, dict) or not changes:
        raise ValueError('changes must be a non-empty object')
    unknown = set(changes) - set(CHANGE_FIELDS)
    if unknown:
        raise ValueError('unsupported contact field')
    data = {
        'display_name': row['display_name'],
        'email': row['email'],
        'phone': row['phone'],
        'company': row['company'],
        'notes': row['notes'],
        'tags': _tag_list(row['tags']),
        'linked_user_id': row['linked_user_id'],
    }
    if 'display_name' in changes:
        data['display_name'] = _display_name(changes['display_name'])
    if 'email' in changes:
        data['email'] = _email(changes['email'])
    if 'phone' in changes:
        data['phone'] = _optional_text(changes['phone'], 'phone', PHONE_MAX)
    if 'company' in changes:
        data['company'] = _optional_text(changes['company'], 'company', COMPANY_MAX)
    if 'notes' in changes:
        data['notes'] = _optional_text(changes['notes'], 'notes', NOTES_MAX)
    if 'tags' in changes:
        data['tags'] = _tags(changes['tags'])
    if 'linked_user_id' in changes:
        data['linked_user_id'] = _linked_user(db, changes['linked_user_id'])
    try:
        db.execute(
            'UPDATE contacts SET display_name=?, email=?, phone=?, company=?, notes=?, '
            'tags=?, linked_user_id=?, updated=? WHERE id=? AND owner_id=?',
            (data['display_name'], data['email'], data['phone'], data['company'],
             data['notes'], json.dumps(data['tags'], ensure_ascii=False, separators=(',', ':')),
             data['linked_user_id'], now, contact_id, owner_id))
    except Exception as exc:
        if 'UNIQUE constraint failed' in str(exc):
            raise ValueError('duplicate email for owner') from exc
        raise
    return get_contact(db, owner_id, contact_id)


def delete_contact(db, owner_id, contact_id):
    """Delete a contact and its memberships; return True when a row was removed."""
    _load_contact(db, owner_id, contact_id)
    db.execute('DELETE FROM contact_group_members WHERE contact_id=?', (contact_id,))
    return db.execute('DELETE FROM contacts WHERE id=? AND owner_id=?',
                      (contact_id, owner_id)).rowcount > 0


def list_contacts(db, owner_id, query=None, tag=None, group_id=None,
                  limit=LIMIT_DEFAULT, cursor=None):
    """Return ``(items, next_cursor)`` for one owner's address book.

    ``query`` matches display name, email or company case-insensitively;
    ``tag`` matches one whole tag; ``group_id`` restricts to a group. The
    opaque cursor is keyset based on display name and id, so pages stay stable
    under concurrent inserts and do not depend on a frozen snapshot.
    """
    if type(limit) is not int or not 1 <= limit <= LIMIT_MAX:
        raise ValueError('limit must be an integer from 1 to %d' % LIMIT_MAX)
    where = ['c.owner_id=?']
    params = [owner_id]
    if query is not None:
        if not isinstance(query, str):
            raise ValueError('query must be text')
        text = query.strip()
        if len(text) > QUERY_MAX:
            raise ValueError('query is too long')
        if text:
            pattern = '%' + _like_escape(text.lower()) + '%'
            where.append("(lower(c.display_name) LIKE ? ESCAPE '\\' "
                         "OR lower(c.email) LIKE ? ESCAPE '\\' "
                         "OR lower(c.company) LIKE ? ESCAPE '\\')")
            params.extend((pattern, pattern, pattern))
    if tag is not None:
        if not isinstance(tag, str):
            raise ValueError('tag must be text')
        text = tag.strip()
        if not text or len(text) > TAG_LEN or CONTROL.search(text):
            raise ValueError('tag is invalid')
        where.append('EXISTS (SELECT 1 FROM json_each(c.tags) j WHERE lower(j.value)=lower(?))')
        params.append(text)
    if group_id is not None:
        _load_group(db, owner_id, group_id)
        where.append('EXISTS (SELECT 1 FROM contact_group_members m '
                     'WHERE m.contact_id=c.id AND m.group_id=?)')
        params.append(group_id)
    if cursor is not None:
        name, contact_id = _decode_cursor(cursor)
        where.append('(lower(c.display_name)>? '
                     'OR (lower(c.display_name)=? AND c.id>?))')
        params.extend((name, name, contact_id))
    sql = ('SELECT c.*, lower(c.display_name) AS sort_name FROM contacts c WHERE '
           + ' AND '.join(where) + ' ORDER BY lower(c.display_name), c.id LIMIT ?')
    params.append(limit + 1)
    rows = db.execute(sql, params).fetchall()
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = _encode_cursor(last['sort_name'], last['id'])
    return [view(row) for row in rows], next_cursor


def create_group(db, owner_id, name, now):
    group_id = uuid4().hex
    try:
        db.execute('INSERT INTO contact_groups VALUES(?,?,?,?)',
                   (group_id, owner_id, _group_name(name), now))
    except Exception as exc:
        if 'UNIQUE constraint failed' in str(exc):
            raise ValueError('duplicate group name for owner') from exc
        raise
    return _group_view(_load_group(db, owner_id, group_id))


def rename_group(db, owner_id, group_id, name):
    _load_group(db, owner_id, group_id)
    try:
        db.execute('UPDATE contact_groups SET name=? WHERE id=? AND owner_id=?',
                   (_group_name(name), group_id, owner_id))
    except Exception as exc:
        if 'UNIQUE constraint failed' in str(exc):
            raise ValueError('duplicate group name for owner') from exc
        raise
    return _group_view(_load_group(db, owner_id, group_id))


def delete_group(db, owner_id, group_id):
    _load_group(db, owner_id, group_id)
    db.execute('DELETE FROM contact_group_members WHERE group_id=?', (group_id,))
    return db.execute('DELETE FROM contact_groups WHERE id=? AND owner_id=?',
                      (group_id, owner_id)).rowcount > 0


def add_to_group(db, owner_id, group_id, contact_id):
    """Add an owned contact to an owned group; return False when already a member."""
    _load_group(db, owner_id, group_id)
    _load_contact(db, owner_id, contact_id)
    cursor = db.execute('INSERT OR IGNORE INTO contact_group_members VALUES(?,?)',
                        (group_id, contact_id))
    return cursor.rowcount > 0


def remove_from_group(db, owner_id, group_id, contact_id):
    """Remove a membership; return False when the contact was not in the group."""
    _load_group(db, owner_id, group_id)
    _load_contact(db, owner_id, contact_id)
    return db.execute('DELETE FROM contact_group_members WHERE group_id=? AND contact_id=?',
                      (group_id, contact_id)).rowcount > 0


def list_groups(db, owner_id):
    rows = db.execute(GROUP_SELECT + 'WHERE g.owner_id=? ORDER BY lower(g.name), g.id',
                      (owner_id,)).fetchall()
    return [_group_view(row) for row in rows]
