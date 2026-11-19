"""Opt-in public agent catalog (issue #87).

Self-written for OpenTeamily; no upstream or Teamily source. Only workspace
owners/admins can list an agent. The public listing exposes a whitelisted
name/summary/slug projection and never instructions, workspace ids or tokens.
This is not Teamily Discover parity: there is no recommendation, ranking,
follow, like or federation support. An opt-in public works feed can list
voluntarily published artifacts without inventing engagement counts.
"""
import re

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{1,28}[a-z0-9]')
RESERVED = {
    'settings', 'team', 'members', 'v1', 'discover', 'agents', 'chat',
    'messenger', 'space', 'artifacts', 'memory', 'automations', 'runtimes',
    'profile', 'download', 'install', 'shell', 'share', 'a', 'd', 'api',
    'login', 'logout', 'search', 'w', 'works', 'feed',
}

AGENT_CATEGORIES = (
    ('content-creation', 'Content Creation'),
    ('customer-support', 'Customer Support'),
    ('data-analysis', 'Data Analysis'),
    ('design', 'Design'),
    ('education', 'Education'),
    ('engineering', 'Engineering'),
    ('finance', 'Finance'),
    ('it-security', 'IT & Security'),
    ('investment', 'Investment'),
    ('legal', 'Legal'),
    ('life', 'Life'),
    ('marketing', 'Marketing'),
    ('operations', 'Operations'),
    ('product', 'Product'),
    ('recruiting', 'Recruiting'),
    ('research', 'Research'),
    ('sales', 'Sales'),
)
AGENT_CATEGORY_SLUGS = frozenset(slug for slug, _label in AGENT_CATEGORIES)

SCHEMA = '''
CREATE TABLE IF NOT EXISTS agent_discover (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE,
 listed INTEGER NOT NULL CHECK(listed IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_discover_list ON agent_discover(listed, slug);
CREATE TABLE IF NOT EXISTS artifact_discover (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE,
 listed INTEGER NOT NULL CHECK(listed IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS artifact_discover_list ON artifact_discover(listed, updated, slug);
'''


def valid_slug(value):
    return (isinstance(value, str) and bool(SLUG.fullmatch(value))
            and value not in RESERVED)


def load(db, agent_id):
    return db.execute('SELECT * FROM agent_discover WHERE agent_id=?', (agent_id,)).fetchone()


def load_by_slug(db, slug):
    return db.execute('SELECT * FROM agent_discover WHERE slug=?', (slug,)).fetchone()


def metadata_view(row):
    if row is None:
        return {'listed': False}
    return {'listed': bool(row['listed']), 'slug': row['slug'], 'updated': row['updated']}


def listing(db, query, cursor, limit):
    sql = ('SELECT d.slug, d.updated, a.name, a.summary FROM agent_discover d '
           'JOIN workspace_agents a ON a.id=d.agent_id '
           "WHERE d.listed=1 AND a.archived=0 AND d.slug>?")
    params = [cursor]
    text = (query or '').strip()
    if text:
        sql += ' AND (instr(lower(a.name), lower(?))>0 OR instr(lower(a.summary), lower(?))>0)'
        params.extend([text, text])
    sql += ' ORDER BY d.slug LIMIT ?'
    params.append(limit)
    return db.execute(sql, tuple(params)).fetchall()


def public_view(row):
    summary = row['summary'] or ''
    if len(summary) > 500:
        summary = summary[:500]
    return {'slug': row['slug'], 'name': row['name'], 'summary': summary,
            'updated': row['updated']}


WORK_KIND_LABELS = {
    'document': '文档',
    'website': '网页',
    'whiteboard': '白板',
    'media': '媒体',
    'slides': '幻灯片',
    'dashboard': '看板',
}


def load_work(db, artifact_id):
    return db.execute('SELECT * FROM artifact_discover WHERE artifact_id=?', (artifact_id,)).fetchone()


def load_work_by_slug(db, slug):
    return db.execute('SELECT * FROM artifact_discover WHERE slug=?', (slug,)).fetchone()


def work_metadata_view(row):
    if row is None:
        return {'listed': False}
    return {'listed': bool(row['listed']), 'slug': row['slug'], 'updated': row['updated']}


def valid_work_cursor(value):
    if not isinstance(value, str) or not value:
        return None
    updated, sep, slug = value.partition('.')
    if not sep or not updated.isdigit() or not valid_slug(slug):
        return None
    return int(updated), slug


def work_cursor(row):
    return '%s.%s' % (row['listed_updated'], row['slug'])


def work_listing(db, query, cursor, limit):
    sql = (
        'SELECT d.slug, d.updated AS listed_updated, a.title, '
        'cu.username AS created_by_username, m.render AS render, '
        'md.mime AS media_mime, b.board AS board_json, sl.deck AS slides_json, '
        'dbd.dashboard AS dashboard_json '
        'FROM artifact_discover d '
        'JOIN artifacts a ON a.id=d.artifact_id '
        'JOIN users cu ON cu.id=a.created_by '
        'LEFT JOIN artifact_meta m ON m.artifact_id=a.id '
        'LEFT JOIN artifact_media md ON md.artifact_id=a.id '
        'LEFT JOIN artifact_boards b ON b.artifact_id=a.id '
        'LEFT JOIN artifact_slides sl ON sl.artifact_id=a.id '
        'LEFT JOIN artifact_dashboards dbd ON dbd.artifact_id=a.id '
        'WHERE d.listed=1'
    )
    params = []
    parsed = valid_work_cursor(cursor) if cursor else None
    if cursor:
        if parsed is None:
            raise ValueError('invalid cursor')
        sql += ' AND (d.updated<? OR (d.updated=? AND d.slug<?))'
        params.extend([parsed[0], parsed[0], parsed[1]])
    text = (query or '').strip()
    if text:
        sql += ' AND (instr(lower(a.title), lower(?))>0 OR instr(lower(cu.username), lower(?))>0)'
        params.extend([text, text])
    sql += ' ORDER BY d.updated DESC, d.slug DESC LIMIT ?'
    params.append(limit)
    return db.execute(sql, tuple(params)).fetchall()


def work_public_view(row):
    from . import artifacts
    title = row['title'] or ''
    if len(title) > 80:
        title = title[:80]
    kind = artifacts.public_kind(row)
    return {
        'slug': row['slug'],
        'title': title,
        'kind': kind,
        'kind_label': WORK_KIND_LABELS.get(kind, kind),
        'author': row['created_by_username'],
        'updated': row['listed_updated'],
        'path': '/w/' + row['slug'],
    }


def load_listed_work(db, slug):
    from . import artifacts
    row = db.execute(
        'SELECT d.slug, d.listed, d.workspace_id, d.artifact_id FROM artifact_discover d '
        'WHERE d.slug=?',
        (slug,),
    ).fetchone()
    if row is None or row['listed'] != 1:
        return None
    return artifacts.load(db, row['workspace_id'], row['artifact_id'])
