"""Opt-in public agent catalog (issue #87).

Self-written for OpenTeamily; no upstream or Teamily source. Only workspace
owners/admins can list an agent. The public listing exposes a whitelisted
name/summary/slug projection and never instructions, workspace ids or tokens.
This is not Teamily Discover parity: there is no recommendation, feed,
follow, like or federation support.
"""
import re

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{1,28}[a-z0-9]')
RESERVED = {
    'settings', 'team', 'members', 'v1', 'discover', 'agents', 'chat',
    'messenger', 'space', 'artifacts', 'memory', 'automations', 'runtimes',
    'profile', 'download', 'install', 'shell', 'share', 'a', 'd', 'api',
    'login', 'logout', 'search',
}

SCHEMA = '''
CREATE TABLE IF NOT EXISTS agent_discover (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE,
 listed INTEGER NOT NULL CHECK(listed IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_discover_list ON agent_discover(listed, slug);
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
