"""Workspace membership and roles (issue #7, slice 1).

Self-written for OpenTeamily; no upstream or Teamily source. Roles and
permission defaults below are OpenTeamily choices. Teamily team creation,
invites and role behavior have not been compared yet; do not claim parity.
"""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_members (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','member')),
 created INTEGER NOT NULL,
 added_by TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY (workspace_id, user_id));
CREATE INDEX IF NOT EXISTS workspace_member_user ON workspace_members(user_id, workspace_id);
'''

ROLES = ('owner', 'admin', 'member')
ASSIGNABLE = ('admin', 'member')


def visible(db, user_id, cursor, limit):
    return db.execute(
        'SELECT * FROM workspaces WHERE (owner_id=? OR id IN '
        '(SELECT workspace_id FROM workspace_members WHERE user_id=?)) AND id>? '
        'ORDER BY id LIMIT ?',
        (user_id, user_id, cursor, limit),
    ).fetchall()


def load(db, workspace_id, user_id):
    return db.execute(
        'SELECT * FROM workspaces WHERE id=? AND (owner_id=? OR id IN '
        '(SELECT workspace_id FROM workspace_members WHERE user_id=?))',
        (workspace_id, user_id, user_id),
    ).fetchone()


def role_of(db, workspace, user_id):
    if workspace['owner_id'] == user_id:
        return 'owner'
    row = db.execute(
        'SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?',
        (workspace['id'], user_id),
    ).fetchone()
    return None if row is None else row['role']


def view(row):
    return {key: row[key] for key in ('user_id', 'username', 'role', 'created')}


def listing(db, workspace):
    owner = db.execute(
        'SELECT u.id AS user_id, u.username, ? AS role, w.created AS created '
        'FROM workspaces w JOIN users u ON u.id=w.owner_id WHERE w.id=?',
        ('owner', workspace['id']),
    ).fetchone()
    members = db.execute(
        'SELECT u.id AS user_id, u.username, m.role AS role, m.created AS created '
        'FROM workspace_members m JOIN users u ON u.id=m.user_id '
        'WHERE m.workspace_id=? ORDER BY m.role, u.username, u.id',
        (workspace['id'],),
    ).fetchall()
    return [view(owner), *[view(row) for row in members]]
