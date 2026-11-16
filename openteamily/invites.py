"""Workspace invite links (issue #5, slice 1).

Self-written for OpenTeamily; no upstream or Teamily source. Teamily pricing
copy mentioned joining by invite link, and a chat-bar Invite entry was seen,
but no invite was created or accepted and wizard steps 2/3 were not opened.
Credits-center invite codes are a different, unpaid-referral feature and are
not implemented here. These defaults are not Teamily parity.
"""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_invites (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('admin','member')),
 created INTEGER NOT NULL,
 expires INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 max_uses INTEGER NOT NULL CHECK(max_uses >= 1),
 use_count INTEGER NOT NULL CHECK(use_count >= 0),
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS workspace_invite_list ON workspace_invites(workspace_id, id);
'''

TOKEN = __import__('re').compile(r'[A-Za-z0-9_-]{32,128}')


def view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'role', 'created', 'expires', 'created_by',
        'max_uses', 'use_count', 'revoked')}


def usable(row, now):
    return row['revoked'] == 0 and row['expires'] > now and row['use_count'] < row['max_uses']
