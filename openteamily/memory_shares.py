"""Read-only, revocable share links for one memory page (issue 288).

A link is created by someone who can edit the page, opens without a session
at `/s/<token>`, and shows only that page: title, topics, timestamps and the
stored Markdown body as plain text. Only `sha256('share:' + token)` is stored,
so the token is shown exactly once and never appears in the listing or state
response. Revoking or rotating a link takes effect on the next request. This is
not a public index, not a website export and not Teamily share parity.
"""
import re
from datetime import datetime, timezone
from html import escape
from uuid import uuid4

from . import memory
from .security import digest, opaque

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_shares (
 id TEXT PRIMARY KEY,
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 token_prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 expires INTEGER CHECK(expires IS NULL OR expires >= 0),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1)),
 revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS memory_share_page ON memory_shares(page_id, created);
"""

PREFIX_LEN = 8
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
SELECT = ('SELECT s.*, u.username AS created_by_username FROM memory_shares s '
          'JOIN users u ON u.id=s.created_by ')

CSP = ("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'")


def latest(db, page_id):
    return db.execute(
        SELECT + 'WHERE s.page_id=? ORDER BY s.revoked ASC, s.created DESC, s.id DESC LIMIT 1', (page_id,)
    ).fetchone()


def load(db, share_id):
    return db.execute(SELECT + 'WHERE s.id=?', (share_id,)).fetchone()


def active(row, now):
    return bool(row is not None
                and row['revoked'] == 0
                and (row['expires'] is None or row['expires'] > now))


def view(row, now, token=None):
    if row is None:
        return None
    data = {
        'id': row['id'],
        'page_id': row['page_id'],
        'workspace_id': row['workspace_id'],
        'prefix': row['token_prefix'],
        'created': row['created'],
        'created_by': row['created_by_username'] if 'created_by_username' in row.keys() else None,
        'expires': row['expires'],
        'revoked': bool(row['revoked']),
        'active': active(row, now),
        'scope': 'read',
    }
    if token:
        data['token'] = token
        data['path'] = '/s/' + token
    return data


def create(db, page, user_id, now):
    """Mint a link for one page, revoking the previous active one first."""
    previous = latest(db, page['id'])
    if active(previous, now):
        db.execute('UPDATE memory_shares SET revoked=1, revoked_at=? WHERE id=?', (now, previous['id']))
    token, share_id = opaque(), uuid4().hex
    db.execute(
        'INSERT INTO memory_shares VALUES(?,?,?,?,?,?,?,?,0,NULL)',
        (share_id, page['id'], page['workspace_id'], digest('share:' + token), token[:PREFIX_LEN],
         now, user_id, None),
    )
    return load(db, share_id), token


def revoke(db, row, now):
    db.execute('UPDATE memory_shares SET revoked=1, revoked_at=? WHERE id=?', (now, row['id']))
    return load(db, row['id'])


def load_page(db, token, now):
    """The one page a valid token points at; None when revoked, expired or unknown."""
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    share = db.execute(SELECT + 'WHERE s.token_hash=?', (digest('share:' + token),)).fetchone()
    if not active(share, now):
        return None
    row = memory.load(db, share['workspace_id'], share['page_id'])
    if row is None:
        return None
    return memory.decorate(db, row)


def headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', CSP),
        ('X-Robots-Tag', 'noindex, nofollow'),
        ('Referrer-Policy', 'no-referrer'),
        ('X-Content-Type-Options', 'nosniff'),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('Cache-Control', 'no-store'),
    ]


def day(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%d')


def render_page(page):
    heading = escape(page['title'])
    topics = ''.join('<li>' + escape(name) + '</li>' for name in page.get('topics') or [])
    body = escape(page.get('body') or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + ' · 只读分享 · OpenTeamily</title>'
        '<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;'
        'margin:2rem auto;padding:0 1.2rem;line-height:1.65;color:#1d2621;background:#f6f8f4}'
        'main{background:#fff;border:1px solid #dbe3da;border-radius:14px;padding:1.4rem 1.6rem}'
        '.badge{display:inline-block;margin:0 0 1rem;padding:.15rem .55rem;border-radius:999px;'
        'font-size:.75rem;letter-spacing:.06em;color:#2c5c41;background:#e5f2e8}'
        'h1{font-size:1.5rem;margin:.2rem 0 .6rem;word-break:break-word}'
        '.meta{font-size:.8rem;color:#5b6472;margin:0 0 .8rem}'
        '.topics{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0;margin:0 0 1.2rem}'
        '.topics li{font-size:.75rem;padding:.1rem .5rem;border-radius:999px;background:#eef2ef}'
        'pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0}'
        'footer{margin-top:1.4rem;font-size:.75rem;color:#5b6472}</style></head><body><main>'
        '<p class="badge">只读分享 · 不能编辑</p>'
        '<h1>' + heading + '</h1>'
        '<p class="meta">最近更新 ' + day(page['updated']) + ' · 这份链接只显示这一页</p>'
        '<ul class="topics">' + topics + '</ul>'
        '<pre>' + body + '</pre>'
        '<footer>由 OpenTeamily 记忆页生成；链接被撤销或替换后，这里会变成 404。</footer>'
        '</main></body></html>'
    )
