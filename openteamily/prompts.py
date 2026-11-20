"""Workspace prompt-template library with versions, tags and safe rendering.

This is a local template store only. It does not call a model, execute code,
fetch URLs, render HTML, run tools or apply a prompt anywhere. Rendering is
plain ``{{name}}`` string substitution with a regular expression; it never uses
``eval``, ``exec`` or ``str.format``, so values cannot select attributes or
invoke code. Variables are short ASCII names and curly braces in a body are
reserved for placeholders; malformed or unpaired braces are rejected.

Scope is either ``private`` (readable/editable by the prompt owner) or
``workspace`` (readable by any caller that presents a workspace viewer; the
calling API layer must establish membership). Workspace-scope prompts may be
edited/archived by the prompt owner, the workspace owner or a workspace admin.
Deletion is always restricted to the prompt owner and removes all versions.
Suspension, HTTP authorization, audit logs and UI flows are out of scope here.
"""

from contextlib import contextmanager
import json
import re
from uuid import uuid4

MAX_TITLE = 200
MAX_BODY = 20000
MAX_VARIABLES = 100
MAX_TAGS = 20
MAX_TAG = 40
MAX_QUERY = 200
MAX_PAGE = 100
MAX_PROMPTS_PER_WORKSPACE = 1000
MAX_VERSIONS = 100

SCOPES = ('private', 'workspace')
_SCOPE_SQL = "scope IN ('private','workspace')"

_VAR_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
_PLACEHOLDER = re.compile(r'\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS prompt_templates (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 variables TEXT NOT NULL,
 tags TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('private','workspace')),
 current_version INTEGER NOT NULL CHECK(current_version >= 1),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS prompt_template_workspace
 ON prompt_templates(workspace_id, archived, scope, id);
CREATE INDEX IF NOT EXISTS prompt_template_owner
 ON prompt_templates(workspace_id, owner_id, id);
CREATE TABLE IF NOT EXISTS prompt_versions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 prompt_id TEXT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version >= 1),
 body TEXT NOT NULL,
 variables TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 UNIQUE(prompt_id, version));
CREATE INDEX IF NOT EXISTS prompt_version_prompt
 ON prompt_versions(prompt_id, version);
CREATE INDEX IF NOT EXISTS prompt_version_author
 ON prompt_versions(prompt_id, created_by, version);
'''


class PromptError(ValueError):
    """Base class for bounded prompt validation and conflict failures."""


class PromptNotFound(PromptError):
    pass


class PromptVersionConflict(PromptError):
    pass


class PromptPermissionError(PromptError):
    pass


def ensure_schema(db):
    """Create the prompt tables and indexes. Safe to call repeatedly."""
    db.executescript(SCHEMA)


@contextmanager
def _atomic(db):
    name = 'prompt_' + uuid4().hex
    db.execute('SAVEPOINT ' + name)
    try:
        yield
    except BaseException:
        db.execute('ROLLBACK TO ' + name)
        db.execute('RELEASE ' + name)
        raise
    else:
        db.execute('RELEASE ' + name)


def _valid_text(value, maximum, allow_newlines=False):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        return False
    allowed = '\n\r\t' if allow_newlines else ''
    for character in value:
        code = ord(character)
        if code < 32 and character not in allowed:
            return False
        if code == 127 or 0x80 <= code <= 0x9f:
            return False
        if 0xd800 <= code <= 0xdfff:
            return False
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def _normalize_title(value):
    if not _valid_text(value, MAX_TITLE):
        raise PromptError('Title must be bounded printable text')
    title = value.strip()
    if not title:
        raise PromptError('Title must not be blank')
    return title


def _normalize_body(value):
    if not _valid_text(value, MAX_BODY, allow_newlines=True):
        raise PromptError('Body must be bounded text')
    return value


def _extract_variables(body):
    names = []
    seen = set()
    last = 0
    remainder = []
    for match in _PLACEHOLDER.finditer(body):
        remainder.append(body[last:match.start()])
        last = match.end()
        name = match.group(1)
        if name not in seen:
            seen.add(name)
            names.append(name)
    remainder.append(body[last:])
    if '{' in ''.join(remainder) or '}' in ''.join(remainder):
        raise PromptError('Malformed placeholder; use {{name}} with short variable names')
    if len(names) > MAX_VARIABLES:
        raise PromptError('Too many variables')
    return names


def _normalize_variables(value, body):
    extracted = _extract_variables(body)
    if value is None:
        return extracted
    if not isinstance(value, list) or len(value) > MAX_VARIABLES:
        raise PromptError('Variables must be a bounded list of short names')
    names = []
    seen = set()
    for name in value:
        if not isinstance(name, str) or not _VAR_NAME.fullmatch(name) or name in seen:
            raise PromptError('Variables must be unique short names')
        seen.add(name)
        names.append(name)
    if set(names) != set(extracted):
        raise PromptError('Declared variables must match the body placeholders')
    return names


def _normalize_tags(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        raise PromptError('Tags must be a bounded list')
    tags = []
    seen = set()
    for tag in value:
        if not isinstance(tag, str):
            raise PromptError('Tags must be text')
        tag = tag.strip()
        if not _valid_text(tag, MAX_TAG):
            raise PromptError('Tag must be bounded printable text')
        folded = tag.casefold()
        if folded not in seen:
            seen.add(folded)
            tags.append(tag)
    return tags


def _normalize_scope(value):
    if value not in SCOPES:
        raise PromptError('Scope must be private or workspace')
    return value


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _loads(value):
    return json.loads(value)


def _view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'owner_id': row['owner_id'],
        'title': row['title'],
        'body': row['body'],
        'variables': _loads(row['variables']),
        'tags': _loads(row['tags']),
        'scope': row['scope'],
        'current_version': row['current_version'],
        'version': row['current_version'],
        'archived': bool(row['archived']),
        'created': row['created'],
        'updated': row['updated'],
    }


def _version_view(row):
    return {
        'id': row['id'],
        'prompt_id': row['prompt_id'],
        'version': row['version'],
        'body': row['body'],
        'variables': _loads(row['variables']),
        'created_by': row['created_by'],
        'created': row['created'],
    }


def _row(db, workspace_id, prompt_id):
    return db.execute(
        'SELECT * FROM prompt_templates WHERE workspace_id=? AND id=?',
        (workspace_id, prompt_id),
    ).fetchone()


def _can_edit(db, row, actor_id):
    if row['owner_id'] == actor_id:
        return True
    if row['scope'] != 'workspace':
        return False
    workspace = db.execute('SELECT owner_id FROM workspaces WHERE id=?',
                           (row['workspace_id'],)).fetchone()
    if workspace is not None and workspace['owner_id'] == actor_id:
        return True
    membership = db.execute(
        'SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?',
        (row['workspace_id'], actor_id),
    ).fetchone()
    return bool(membership and membership['role'] == 'admin')


def _insert_version(db, prompt_id, version, body, variables, actor_id, now):
    db.execute(
        'INSERT INTO prompt_versions(prompt_id,version,body,variables,created_by,created) '
        'VALUES(?,?,?,?,?,?)',
        (prompt_id, version, body, _dumps(variables), actor_id, now),
    )


def create_prompt(db, workspace_id, owner_id, title, body, now, variables=None,
                  tags=None, scope='private'):
    """Create a prompt and its version 1. The caller must authorize membership."""
    title = _normalize_title(title)
    body = _normalize_body(body)
    variables = _normalize_variables(variables, body)
    tags = _normalize_tags(tags)
    scope = _normalize_scope(scope)
    with _atomic(db):
        count = db.execute('SELECT COUNT(*) FROM prompt_templates WHERE workspace_id=?',
                           (workspace_id,)).fetchone()[0]
        if count >= MAX_PROMPTS_PER_WORKSPACE:
            raise PromptError('Workspace prompt limit reached')
        prompt_id = uuid4().hex
        db.execute(
            'INSERT INTO prompt_templates('
            'id,workspace_id,owner_id,title,body,variables,tags,scope,'
            'current_version,archived,created,updated) '
            'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            (prompt_id, workspace_id, owner_id, title, body, _dumps(variables),
             _dumps(tags), scope, 1, 0, now, now),
        )
        _insert_version(db, prompt_id, 1, body, variables, owner_id, now)
        row = _row(db, workspace_id, prompt_id)
    return _view(row)


def get_prompt(db, workspace_id, prompt_id, viewer_id):
    """Return one prompt, or None. Private prompts are visible only to their owner."""
    row = _row(db, workspace_id, prompt_id)
    if row is None:
        return None
    if row['scope'] == 'private' and row['owner_id'] != viewer_id:
        return None
    return _view(row)


def list_prompts(db, workspace_id, viewer_id, scope=None, tag=None, query=None,
                 limit=50, cursor=None):
    """List non-archived visible prompts in keyset order by ID.

    Workspace prompts are returned to every viewer; the caller authorizes real
    workspace membership. Private prompts are restricted to their owner.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE:
        raise PromptError('Limit must be between 1 and %d' % MAX_PAGE)
    if scope is not None:
        _normalize_scope(scope)
    if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 64):
        raise PromptError('Invalid cursor')
    if tag is not None and (not isinstance(tag, str) or not 1 <= len(tag) <= MAX_TAG):
        raise PromptError('Invalid tag filter')
    if query is not None and (not isinstance(query, str) or len(query) > MAX_QUERY):
        raise PromptError('Invalid query')

    rows = db.execute(
        "SELECT * FROM prompt_templates WHERE workspace_id=? AND archived=0 "
        "AND (scope='workspace' OR owner_id=?) ORDER BY id",
        (workspace_id, viewer_id),
    ).fetchall()
    tag_key = tag.casefold() if tag is not None else None
    query_key = query.casefold() if query else None
    result = []
    for row in rows:
        if cursor is not None and row['id'] <= cursor:
            continue
        if scope is not None and row['scope'] != scope:
            continue
        tags = _loads(row['tags'])
        if tag_key is not None and tag_key not in {item.casefold() for item in tags}:
            continue
        if query_key is not None:
            haystack = (row['title'] + '\n' + row['body'] + '\n' + ' '.join(tags)).casefold()
            if query_key not in haystack:
                continue
        result.append(_view(row))
        if len(result) >= limit:
            break
    return result


def update_prompt(db, workspace_id, prompt_id, actor_id, changes, now,
                  expected_version):
    """Create a new version after a compare-and-swap on current_version.

    Allowed changes are title, body, variables, tags and scope. The prompt
    owner may edit; a workspace owner/admin may edit a workspace-scope prompt.
    A stale expected_version raises PromptVersionConflict.
    """
    if not isinstance(changes, dict):
        raise PromptError('Changes must be an object')
    if type(expected_version) is not int or expected_version < 1:
        raise PromptError('Expected version must be a positive integer')
    allowed = {'title', 'body', 'variables', 'tags', 'scope'}
    unknown = set(changes) - allowed
    if unknown:
        raise PromptError('Unknown prompt fields')
    if not changes:
        raise PromptError('No changes supplied')

    with _atomic(db):
        row = _row(db, workspace_id, prompt_id)
        if row is None:
            raise PromptNotFound('Prompt not found')
        if not _can_edit(db, row, actor_id):
            raise PromptPermissionError('Prompt is not editable by this actor')
        current = row['current_version']
        if current != expected_version:
            raise PromptVersionConflict('Prompt changed; reload before updating')
        if current >= MAX_VERSIONS:
            raise PromptError('Prompt version limit reached')

        title = _normalize_title(changes['title']) if 'title' in changes else row['title']
        body = _normalize_body(changes['body']) if 'body' in changes else row['body']
        if 'variables' in changes:
            variables = _normalize_variables(changes['variables'], body)
        elif 'body' in changes:
            variables = _normalize_variables(None, body)
        else:
            variables = _loads(row['variables'])
        tags = _normalize_tags(changes['tags']) if 'tags' in changes else _loads(row['tags'])
        scope = _normalize_scope(changes['scope']) if 'scope' in changes else row['scope']
        version = current + 1

        changed = db.execute(
            'UPDATE prompt_templates SET title=?,body=?,variables=?,tags=?,scope=?,'
            'current_version=?,updated=? WHERE workspace_id=? AND id=? AND current_version=?',
            (title, body, _dumps(variables), _dumps(tags), scope, version, now,
             workspace_id, prompt_id, current),
        )
        if changed.rowcount != 1:
            raise PromptVersionConflict('Prompt changed; reload before updating')
        _insert_version(db, prompt_id, version, body, variables, actor_id, now)
        row = _row(db, workspace_id, prompt_id)
    return _view(row)


def list_versions(db, workspace_id, prompt_id, viewer_id):
    """Return accessible versions oldest-first, or [] when not visible."""
    prompt = get_prompt(db, workspace_id, prompt_id, viewer_id)
    if prompt is None:
        return []
    rows = db.execute(
        'SELECT * FROM prompt_versions WHERE prompt_id=? ORDER BY version',
        (prompt_id,),
    ).fetchall()
    return [_version_view(row) for row in rows]


def render(db, workspace_id, prompt_id, values, viewer_id, version=None):
    """Safely substitute ``{{name}}`` placeholders without evaluation.

    Missing required variables are reported in ``missing`` and their
    placeholders remain in ``text``; extra supplied values are ignored. A
    missing prompt/version or non-string values raise PromptError. The returned
    text is not automatically sent to a model or executed.
    """
    row = _row(db, workspace_id, prompt_id)
    if row is None:
        raise PromptNotFound('Prompt not found')
    if row['scope'] == 'private' and row['owner_id'] != viewer_id:
        raise PromptNotFound('Prompt not found')

    if version is not None:
        if type(version) is not int or version < 1:
            raise PromptError('Version must be a positive integer')
        version_row = db.execute(
            'SELECT * FROM prompt_versions WHERE prompt_id=? AND version=?',
            (prompt_id, version),
        ).fetchone()
        if version_row is None:
            raise PromptNotFound('Prompt version not found')
        body = version_row['body']
        variables = _loads(version_row['variables'])
    else:
        body = row['body']
        variables = _loads(row['variables'])

    if not isinstance(values, dict):
        raise PromptError('Values must be an object')
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise PromptError('Variable names and values must be text')

    missing = [name for name in variables if name not in values]
    text = _PLACEHOLDER.sub(
        lambda match: values.get(match.group(1), match.group(0)),
        body,
    )
    return {'text': text, 'missing': missing}


def archive_prompt(db, workspace_id, prompt_id, actor_id, now, archived=True):
    """Archive or restore a prompt. Archived prompts stay readable but leave lists."""
    if not isinstance(archived, bool):
        raise PromptError('Archived must be a boolean')
    with _atomic(db):
        row = _row(db, workspace_id, prompt_id)
        if row is None:
            raise PromptNotFound('Prompt not found')
        if not _can_edit(db, row, actor_id):
            raise PromptPermissionError('Prompt is not editable by this actor')
        db.execute(
            'UPDATE prompt_templates SET archived=?, updated=? WHERE workspace_id=? AND id=?',
            (1 if archived else 0, now, workspace_id, prompt_id),
        )
        row = _row(db, workspace_id, prompt_id)
    return _view(row)


def delete_prompt(db, workspace_id, prompt_id, actor_id):
    """Delete a prompt and cascade its versions. Only the prompt owner may delete."""
    with _atomic(db):
        row = _row(db, workspace_id, prompt_id)
        if row is None or row['owner_id'] != actor_id:
            return False
        db.execute('DELETE FROM prompt_versions WHERE prompt_id=?', (prompt_id,))
        db.execute('DELETE FROM prompt_templates WHERE workspace_id=? AND id=?',
                   (workspace_id, prompt_id))
    return True
