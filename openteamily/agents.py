"""Workspace agent directory and public homepages (issue #6).

Self-written for OpenTeamily; no upstream or Teamily source. Teamily's
create flow and Auto / Instant / Agentic mode differences were not fully
observed, so this slice does not invent modes or embeddable conversations.
Public homepages are unlisted share links: name and summary only, never
instructions. The public HTML follows the recorded profile typography
(identity, talk-via, a web-conversation panel, and a create footer) but
does not copy Teamily marks, a verified badge, LIVE state, or invented
quick starts. Conversation and create controls stay disabled. These
records live in the management database only: the management process
does not run agents. Container execution, embed routes, and Teamily
comparison remain later slices and must not be claimed from these tests.
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
CREATE TABLE IF NOT EXISTS workspace_agent_categories (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 category TEXT NOT NULL,
 updated INTEGER NOT NULL);
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
# The 17 directory categories recorded on the target agents page, as slugs.
# Kept in step with AGENT_CATEGORIES in openteamily/static/agents/app.mjs.
CATEGORIES = (
    'content-creation', 'customer-support', 'data-analysis', 'design',
    'education', 'engineering', 'finance', 'it-security', 'investment',
    'legal', 'life', 'marketing', 'operations', 'product', 'recruiting',
    'research', 'sales',
)
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


def valid_category(value):
    return value is None or (isinstance(value, str) and value in CATEGORIES)


def load_category(db, agent_id):
    found = db.execute(
        'SELECT category FROM workspace_agent_categories WHERE agent_id=?', (agent_id,)
    ).fetchone()
    return found['category'] if found else None


def store_category(db, agent_id, category, now):
    if category is None:
        db.execute('DELETE FROM workspace_agent_categories WHERE agent_id=?', (agent_id,))
    else:
        db.execute(
            'INSERT INTO workspace_agent_categories VALUES(?,?,?) '
            'ON CONFLICT(agent_id) DO UPDATE SET category=excluded.category, updated=excluded.updated',
            (agent_id, category, now),
        )


def snapshot(db, row, include_token=False, token=None):
    data = view(row)
    data['category'] = load_category(db, row['id'])
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


def public_initial(name):
    for char in name or '':
        if char.isalnum():
            return char.upper()
    return '?'


HOMEPAGE_STYLE = """
:root{color-scheme:light;--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--bg:#f5f5f4;--card:#ffffff;--accent:#292524}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
.topbar{display:flex;align-items:baseline;gap:.5rem;padding:1rem 1.5rem;border-bottom:1px solid var(--line);background:var(--card)}
.topbar .brand{font-weight:600}
.topbar .crumb{color:var(--muted);font-size:.9rem}
.page{max-width:72rem;margin:0 auto;padding:2rem 1.5rem 3rem;display:grid;gap:2rem}
@media(min-width:880px){.page{grid-template-columns:minmax(16rem,1fr) minmax(20rem,26rem);align-items:start}}
.status{display:inline-block;margin:0 0 .75rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.identity{display:flex;gap:1rem;align-items:flex-start}
.avatar{flex:0 0 4rem;width:4rem;height:4rem;border-radius:1rem;background:var(--accent);color:#fafaf9;display:flex;align-items:center;justify-content:center;font-size:1.6rem;font-weight:600}
.identity h1{margin:0;font-size:2rem;line-height:1.15;overflow-wrap:anywhere}
.summary{margin:.75rem 0 1.25rem;white-space:pre-wrap;word-break:break-word}
.summary.empty,.note{color:var(--muted)}
.section h2{margin:1.25rem 0 .5rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.talk-list,.start-list{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0;list-style:none}
.talk-chip,.start-list li,.create-agent{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:.35rem .8rem;font:inherit;color:var(--ink)}
.talk-chip[disabled],.create-agent[disabled],.composer button[disabled],.composer textarea[disabled]{opacity:.65;cursor:not-allowed}
.panel{background:var(--card);border:1px solid var(--line);border-radius:1.25rem;padding:1.25rem;min-height:28rem;display:flex;flex-direction:column;gap:1rem}
.panel h2{margin:0;font-size:1rem}
.panel .lead{margin:0;color:var(--muted);font-size:.9rem}
.panel-body{flex:1;display:flex;align-items:center}
.composer{display:flex;gap:.5rem;align-items:flex-end}
.composer textarea{flex:1;min-height:3.5rem;resize:none;border:1px solid var(--line);border-radius:.9rem;padding:.75rem .9rem;font:inherit;background:var(--bg)}
.composer button{flex:0 0 auto;border:1px solid var(--line);border-radius:999px;padding:.55rem .9rem;font:inherit;background:var(--card)}
.footer{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;justify-content:center;color:var(--muted);font-size:.9rem;padding-top:.5rem}
"""


def render_homepage(row):
    heading = escape(row['name'] or '智能体')
    raw_summary = (row['summary'] or '').strip()
    summary = escape(raw_summary)
    initial = escape(public_initial(row['name'] or '智能体'))
    body = (
        ('<p class="summary">' + summary + '</p>') if raw_summary
        else '<p class="summary empty">还没有简介。</p>'
    )
    placeholder = escape('Message ' + (row['name'] or '智能体') + ' on the web…')
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">'
        '<title>' + heading + '</title>'
        '<style>' + HOMEPAGE_STYLE + '</style>'
        '</head><body>'
        '<header class="topbar"><span class="brand">OpenTeamily / FlyBot</span>'
        '<span class="crumb">Agent profile</span></header>'
        '<main class="page">'
        '<section class="profile">'
        '<p class="status">Public page</p>'
        '<div class="identity"><div class="avatar" aria-hidden="true">' + initial + '</div>'
        '<div><h1>' + heading + '</h1>' + body + '</div></div>'
        '<div class="section"><h2>Talk via</h2>'
        '<ul class="talk-list">'
        '<li><span class="talk-chip">Web</span></li>'
        '<li><button type="button" class="talk-chip" disabled title="未接通：公开主页还不能连接即时通讯渠道。">Channels</button></li>'
        '</ul></div>'
        '<div class="section"><h2>Start a conversation</h2>'
        '<p class="note">快捷开场未接通。OpenTeamily 的公开主页没有可展示的开场提示，也没有对照里的三条官方示例。</p>'
        '</div></section>'
        '<section class="panel" aria-labelledby="web-conversation-title">'
        '<div><h2 id="web-conversation-title">Web conversation</h2>'
        '<p class="lead">Talk directly with ' + heading + '.</p></div>'
        '<div class="panel-body"><p class="note">This panel is typography only. The public page still does not run a conversation or call a model.</p></div>'
        '<div class="composer">'
        '<label class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)" for="public-composer">Message</label>'
        '<textarea id="public-composer" disabled placeholder="' + placeholder + '"></textarea>'
        '<button type="button" disabled title="未接通：公开主页不会发送消息。">Send</button>'
        '</div></section>'
        '<footer class="footer"><span>Built with FlyBot</span>'
        '<button type="button" class="create-agent" disabled title="未接通：公开主页不会创建智能体。">Create your own Agent</button>'
        '</footer></main></body></html>'
    )


def homepage_headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', HOMEPAGE_CSP),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('X-Frame-Options', 'DENY'),
    ]
