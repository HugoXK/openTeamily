"""Workspace artifacts (issue 9, second slice).

Self-written for OpenTeamily; no upstream or Teamily source, fonts or
marketing copy. This slice adds document provenance from automation and
agent results, explicit revocable read-only share links, and static
website pages rendered under a CSP sandbox. It is not a works-library
parity claim and not browser E2E acceptance.
"""
import re
from html import escape, unescape
from html.parser import HTMLParser

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('document')),
 body TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS artifact_workspace ON artifacts(workspace_id, id);
CREATE TABLE IF NOT EXISTS artifact_meta (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 render TEXT NOT NULL CHECK(render IN ('website')));
CREATE TABLE IF NOT EXISTS artifact_sources (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('automation_run','agent_task')),
 source_id TEXT NOT NULL,
 automation_id TEXT,
 automation_title TEXT,
 task_kind TEXT,
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, source_kind, source_id));
CREATE TABLE IF NOT EXISTS artifact_shares (
 id TEXT PRIMARY KEY,
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 token_prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 expires INTEGER,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS artifact_share_item ON artifact_shares(artifact_id, id);
'''

KINDS = ('document', 'website')
TITLE_MAX = 80
BODY_MAX = 8000
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
PREFIX_LEN = 8
SHARE_CSP = (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'"
)
ALLOWED_TAGS = {
    'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'em', 'strong', 'b', 'i', 'u',
    's', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tfoot',
    'tr', 'th', 'td', 'img',
}
VOID_TAGS = {'br', 'hr', 'img'}
FORBIDDEN_TAGS = {
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math',
    'frame', 'frameset', 'applet', 'video', 'audio', 'source', 'track',
    'template', 'noscript', 'canvas',
}
DATA_IMAGE = re.compile(
    r'^data:image/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$', re.IGNORECASE
)
SAFE_FRAGMENT = re.compile(r'#[A-Za-z0-9_-]{1,64}')
ROW_SELECT = (
    'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username, '
    'm.render AS render, s.source_kind AS source_kind, s.source_id AS source_id, '
    's.automation_id AS automation_id, s.automation_title AS automation_title, '
    's.task_kind AS task_kind, su.username AS source_share_unused '
    'FROM artifacts a '
    'JOIN users cu ON cu.id=a.created_by '
    'JOIN users uu ON uu.id=a.updated_by '
    'LEFT JOIN artifact_meta m ON m.artifact_id=a.id '
    'LEFT JOIN artifact_sources s ON s.artifact_id=a.id '
    'LEFT JOIN users su ON su.id=a.created_by AND su.id=a.updated_by AND 0 '
)


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def valid_body(value):
    return isinstance(value, str) and len(value) <= BODY_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def title_hash(title):
    return digest(title.strip().casefold())


def public_kind(row):
    return 'website' if row['render'] == 'website' else 'document'


def source_view(row):
    if not row['source_kind']:
        return None
    data = {'kind': row['source_kind'], 'id': row['source_id']}
    if row['automation_id']:
        data['automation_id'] = row['automation_id']
    if row['automation_title']:
        data['automation_title'] = row['automation_title']
    if row['task_kind']:
        data['task_kind'] = row['task_kind']
    return data


def view(row, include_body=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'kind': public_kind(row),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    source = source_view(row)
    if source:
        data['source'] = source
    if include_body:
        data['body'] = row['body']
    return data


def can_edit(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def load(db, workspace_id, artifact_id):
    return db.execute(
        ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?',
        (artifact_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]


def set_render(db, artifact_id, kind):
    db.execute('DELETE FROM artifact_meta WHERE artifact_id=?', (artifact_id,))
    if kind == 'website':
        db.execute('INSERT INTO artifact_meta VALUES(?,?)', (artifact_id, 'website'))


def attach_source(db, artifact_id, workspace_id, now, source_kind, source_id, automation_id=None, automation_title=None, task_kind=None):
    db.execute(
        'INSERT INTO artifact_sources VALUES(?,?,?,?,?,?,?,?)',
        (artifact_id, workspace_id, source_kind, source_id, automation_id, automation_title, task_kind, now),
    )


def load_source_artifact(db, workspace_id, source_kind, source_id):
    row = db.execute(
        'SELECT artifact_id FROM artifact_sources WHERE workspace_id=? AND source_kind=? AND source_id=?',
        (workspace_id, source_kind, source_id),
    ).fetchone()
    if row is None:
        return None
    return load(db, workspace_id, row['artifact_id'])


def unique_title(db, workspace_id, title, suffix):
    candidate = title
    if not valid_title(candidate):
        candidate = (title[: TITLE_MAX - 9] + '-' + suffix[:8]).strip('-')
    digest_value = title_hash(candidate)
    if db.execute(
        'SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', (workspace_id, digest_value)
    ).fetchone() is None:
        return candidate
    fallback = (title[: TITLE_MAX - 9] + '-' + suffix[:8]).strip()
    if not valid_title(fallback):
        fallback = suffix[:TITLE_MAX]
    return fallback


def share_view(row, include_token=False, token=None):
    data = {
        'id': row['id'],
        'artifact_id': row['artifact_id'],
        'workspace_id': row['workspace_id'],
        'prefix': row['token_prefix'],
        'created': row['created'],
        'created_by': row['created_by_username'] if 'created_by_username' in row.keys() else None,
        'expires': row['expires'],
        'revoked': bool(row['revoked']),
        'scope': 'read',
    }
    if include_token and token:
        data['token'] = token
        data['path'] = '/share/' + token
    return data


def load_share(db, share_id, artifact_id=None):
    sql = (
        'SELECT s.*, u.username AS created_by_username FROM artifact_shares s '
        'JOIN users u ON u.id=s.created_by WHERE s.id=?'
    )
    args = [share_id]
    if artifact_id:
        sql += ' AND s.artifact_id=?'
        args.append(artifact_id)
    return db.execute(sql, args).fetchone()


def list_shares(db, artifact_id):
    return db.execute(
        'SELECT s.*, u.username AS created_by_username FROM artifact_shares s '
        'JOIN users u ON u.id=s.created_by WHERE s.artifact_id=? ORDER BY s.id',
        (artifact_id,),
    ).fetchall()


def active_share_count(db, artifact_id, now):
    return db.execute(
        'SELECT COUNT(*) FROM artifact_shares WHERE artifact_id=? AND revoked=0 '
        'AND (expires IS NULL OR expires>?)',
        (artifact_id, now),
    ).fetchone()[0]


def load_share_by_token(db, token, now):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    row = db.execute(
        'SELECT s.*, a.title AS title, a.body AS body, m.render AS render '
        'FROM artifact_shares s '
        'JOIN artifacts a ON a.id=s.artifact_id '
        'LEFT JOIN artifact_meta m ON m.artifact_id=a.id '
        'WHERE s.token_hash=?',
        (digest('share:' + token),),
    ).fetchone()
    if row is None or row['revoked'] == 1 or (row['expires'] is not None and row['expires'] <= now):
        return None
    return row


def safe_href(value):
    text = unescape(value or '').strip()
    if not text or re.search(r'[\x00-\x1f\x7f]', text) or len(text) > 2000:
        return None
    if SAFE_FRAGMENT.fullmatch(text):
        return text
    lowered = text.casefold().lstrip()
    if lowered.startswith(('javascript:', 'vbscript:', 'data:')):
        return None
    for scheme in ('https://', 'http://', 'mailto:'):
        if lowered.startswith(scheme) and len(text) > len(scheme):
            return text
    return None


def safe_img_src(value):
    text = unescape(value or '').strip().replace(' ', '')
    if DATA_IMAGE.fullmatch(text) and len(text) <= BODY_MAX:
        return text
    return None


def _ok_attr(tag, name, value):
    name = name.casefold()
    if name.startswith('on') or name in {'style', 'srcset', 'srcdoc', 'xlink:href', 'formaction'}:
        return None
    if tag == 'a' and name in {'href', 'title'}:
        if name == 'title':
            return value[:200] if isinstance(value, str) and not re.search(r'[\x00-\x1f]', value) else None
        return safe_href(value)
    if tag == 'img' and name in {'src', 'alt', 'width', 'height'}:
        if name == 'src':
            return safe_img_src(value)
        if name == 'alt':
            return value[:200] if isinstance(value, str) and not re.search(r'[\x00-\x1f]', value) else ''
        if name in {'width', 'height'} and isinstance(value, str) and re.fullmatch(r'[0-9]{1,4}', value):
            return value
        return None
    if tag in {'td', 'th'} and name in {'colspan', 'rowspan'} and isinstance(value, str) and re.fullmatch(r'[0-9]{1,2}', value):
        return value
    return None


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        if tag in FORBIDDEN_TAGS:
            if tag not in VOID_TAGS:
                self.skip += 1
            return
        if self.skip or tag not in ALLOWED_TAGS:
            return
        pieces = [tag]
        for name, value in attrs:
            allowed = _ok_attr(tag, name, value if value is not None else '')
            if allowed is not None:
                pieces.append(name.casefold() + '="' + escape(allowed, quote=True) + '"')
        if tag == 'a' and not any(part.startswith('href=') for part in pieces[1:]):
            return
        if tag == 'img' and not any(part.startswith('src=') for part in pieces[1:]):
            return
        text = '<' + ' '.join(pieces) + (' />' if tag in VOID_TAGS else '>')
        self.parts.append(text)
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if tag in FORBIDDEN_TAGS:
            if tag not in VOID_TAGS and self.skip:
                self.skip -= 1
            return
        if self.skip or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                current = self.stack.pop()
                self.parts.append('</' + current + '>')
                if current == tag:
                    break

    def handle_data(self, data):
        if not self.skip and data:
            self.parts.append(escape(data, quote=False))

    def handle_comment(self, data):
        return

    def handle_pi(self, data):
        return

    def handle_decl(self, decl):
        return

    def unknown_decl(self, data):
        return

    def close_open(self):
        while self.stack:
            self.parts.append('</' + self.stack.pop() + '>')
        return ''.join(self.parts)


def sanitize_html(source):
    parser = _Sanitizer()
    try:
        parser.feed(source or '')
        parser.close()
    except Exception:
        return escape(source or '')
    return parser.close_open()


def render_document_page(title, body):
    heading = escape(title or '文档')
    content = escape(body or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;'
        'line-height:1.5}pre{white-space:pre-wrap;word-break:break-word}</style>'
        '</head><body><article><h1>' + heading + '</h1><pre>' + content + '</pre>'
        '</article></body></html>'
    )


def render_website_page(title, body):
    heading = escape(title or '网站')
    content = sanitize_html(body or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;line-height:1.5}</style>'
        '</head><body>' + content + '</body></html>'
    )


def render_page(row):
    title, body = row['title'], row['body']
    if row['render'] == 'website':
        return render_website_page(title, body)
    return render_document_page(title, body)


def share_headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', SHARE_CSP),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('X-Frame-Options', 'SAMEORIGIN'),
    ]
