"""Workspace agent directory and public homepages (issue #6).

Self-written for OpenTeamily; no upstream or Teamily source. Teamily's
create flow and Auto / Instant / Agentic mode differences were not fully
observed, so this slice does not invent modes or embeddable conversations.
Public homepages are unlisted share links: name and summary only, never
instructions. These records live in the management database only: the
management process does not run agents. Container execution, embed routes,
and Teamily comparison remain later slices and must not be claimed from
these tests.
"""
from html import escape
import re

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_agents (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 summary TEXT NOT NULL,
 instructions TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, name_hash));
CREATE INDEX IF NOT EXISTS workspace_agent_list ON workspace_agents(workspace_id, archived, id);
CREATE TABLE IF NOT EXISTS workspace_agent_homepages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 token_prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS workspace_agent_homepage_agent
 ON workspace_agent_homepages(agent_id, revoked, created, id);
'''

NAME_MAX = 80
SUMMARY_MAX = 500
INSTRUCTIONS_MAX = 16000
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
PREFIX_LEN = 8
HOMEPAGE_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; sandbox; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
)


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= NAME_MAX and not CONTROL.search(value)


def valid_summary(value):
    return isinstance(value, str) and len(value) <= SUMMARY_MAX and not CONTROL.search(value)


def valid_instructions(value):
    return (isinstance(value, str) and len(value) <= INSTRUCTIONS_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def name_hash(name):
    return digest(name.strip().casefold())


def view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'name', 'summary', 'instructions', 'revision',
        'created', 'updated', 'created_by', 'archived')}


def homepage_view(row, include_token=False, token=None):
    if row is None or row['revoked'] == 1:
        return {'visibility': 'restricted'}
    data = {
        'visibility': 'public',
        'prefix': row['token_prefix'],
        'created': row['created'],
    }
    if include_token and token:
        data['token'] = token
        data['path'] = '/a/' + token
    return data


def snapshot(db, row, include_token=False, token=None):
    data = view(row)
    data['homepage'] = homepage_view(load_active_homepage(db, row['id']), include_token, token)
    return data


def can_manage(actor):
    return actor in ('owner', 'admin')


def load(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agents WHERE id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, include_archived):
    clause = 'archived IN (0, 1)' if include_archived else 'archived=0'
    return db.execute(
        'SELECT * FROM workspace_agents WHERE workspace_id=? AND ' + clause +
        ' AND id>? ORDER BY id LIMIT ?',
        (workspace_id, cursor, limit),
    ).fetchall()


def load_active_homepage(db, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agent_homepages WHERE agent_id=? AND revoked=0 '
        'ORDER BY created DESC, id DESC LIMIT 1',
        (agent_id,),
    ).fetchone()


def load_homepage_by_token(db, token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    row = db.execute(
        'SELECT a.*, h.token_hash AS homepage_token_hash, h.revoked AS homepage_revoked '
        'FROM workspace_agent_homepages h '
        'JOIN workspace_agents a ON a.id = h.agent_id AND a.workspace_id = h.workspace_id '
        'WHERE h.token_hash=?',
        (digest('agent-home:' + token),),
    ).fetchone()
    if row is None or row['homepage_revoked'] == 1 or row['archived'] == 1:
        return None
    return row


def revoke_active_homepages(db, agent_id, now):
    db.execute(
        'UPDATE workspace_agent_homepages SET revoked=1, revoked_at=? '
        'WHERE agent_id=? AND revoked=0',
        (now, agent_id),
    )


def render_homepage(row):
    heading = escape(row['name'] or '智能体')
    summary = escape((row['summary'] or '').strip())
    body = ('<p>' + summary + '</p>') if summary else '<p class="empty">还没有简介。</p>'
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">'
        '<title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;'
        'line-height:1.5;color:#1c1917}p{white-space:pre-wrap;word-break:break-word}'
        '.brand{color:#57534e;font-size:.9rem}.empty{color:#57534e}</style>'
        '</head><body><p class="brand">OpenTeamily / FlyBot</p>'
        '<article><h1>' + heading + '</h1>' + body + '</article></body></html>'
    )


def homepage_headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', HOMEPAGE_CSP),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('X-Frame-Options', 'DENY'),
    ]
