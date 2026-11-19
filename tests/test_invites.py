"""Workspace invite link tests (issue #5). In-process WSGI + temporary SQLite only."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.security import digest
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class InviteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']

    def create(self, client=None, role='member', csrf=True, origin=ORIGIN, **fields):
        return (client or self.alice).call('POST', f'/v1/workspaces/{self.wid}/invites',
                                           {'role': role, **fields}, csrf=csrf, origin=origin)

    def accept(self, client, token, **kw):
        return client.call('POST', '/v1/invites/accept', {'token': token}, **kw)

    def test_owner_creates_a_token_shown_once_and_stored_hashed(self):
        created = self.create()
        self.assertEqual(created['status'], 201)
        token = created['body']['token']
        invite = created['body']['invite']
        self.assertRegex(token, r'^[A-Za-z0-9_-]{32,128}$')
        self.assertEqual(invite['role'], 'member')
        self.assertEqual(invite['use_count'], 0)
        self.assertEqual(invite['revoked'], 0)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/invites')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertNotIn('token', listed['body']['items'][0])
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute('SELECT token_hash FROM workspace_invites').fetchone()
            self.assertEqual(row[0], digest(token))
            dumped = db.execute('SELECT * FROM workspace_invites').fetchone()
            self.assertNotIn(token, ''.join(str(part) for part in dumped))

    def test_accept_adds_the_caller_and_is_idempotent_for_the_same_role(self):
        token = self.create()['body']['token']
        first = self.accept(self.bob, token)
        self.assertEqual(first['status'], 201)
        self.assertEqual(first['body']['member']['username'], 'bob')
        self.assertEqual(first['body']['member']['role'], 'member')
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}')['status'], 200)
        again = self.accept(self.bob, token)
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['member']['user_id'], first['body']['member']['user_id'])
        # Single-use token cannot add a second person after the first accept.
        self.assertEqual(self.accept(self.carol, token)['status'], 404)
        names = [row['username'] for row in self.alice.call('GET', f'/v1/workspaces/{self.wid}/members')['body']['items']]
        self.assertEqual(names, ['alice', 'bob'])

    def test_multi_use_and_expiry_and_revoke(self):
        token = self.create(max_uses=2, expires_in=60)['body']['token']
        self.assertEqual(self.accept(self.bob, token)['status'], 201)
        self.assertEqual(self.accept(self.carol, token)['status'], 201)
        expired_app = App(Store(self.path), self.app.config, clock=lambda: self.now + 61)
        late = Client(expired_app, peer='127.0.0.4')
        late.cookies = dict(self.bob.cookies)
        # New account after expiry of a fresh invite
        invite = self.create(expires_in=60)
        later = App(Store(self.path), self.app.config, clock=lambda: self.now + 61)
        dave = Client(later, peer='127.0.0.5')
        dave.register('dave')
        self.assertEqual(self.accept(dave, invite['body']['token'])['status'], 404)
        revoked = self.create()
        rid = revoked['body']['invite']['id']
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/invites/{rid}/revoke', {})['status'], 200)
        evan = Client(self.app, peer='127.0.0.6')
        evan.register('evan')
        self.assertEqual(self.accept(evan, revoked['body']['token'])['status'], 404)

    def test_admin_cannot_mint_admin_invites_and_members_cannot_list(self):
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'admin'})
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'carol', 'role': 'member'})
        self.assertEqual(self.create(self.bob, role='admin')['status'], 403)
        token = self.create(self.bob, role='member')['body']['token']
        self.assertRegex(token, r'^[A-Za-z0-9_-]{32,}')
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/invites')['status'], 404)
        self.assertEqual(self.create(self.carol)['status'], 404)

    def test_invalid_or_foreign_tokens_use_the_same_public_error(self):
        token = self.create()['body']['token']
        other = self.alice.workspace('second', 'request_example_0002')['body']['workspace']['id']
        for raw in ('short', 'a' * 32, token[:-1] + ('A' if token[-1] != 'A' else 'B')):
            status = self.accept(self.bob, raw)['status']
            self.assertIn(status, (400, 404), raw)
        unknown = self.accept(self.bob, 'A' * 43)
        self.assertEqual(unknown['status'], 404)
        self.assertEqual(unknown['body']['error']['message'], 'Invite not found')
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other}/invites')['status'], 404)
        self.assertEqual(self.accept(self.alice, token)['status'], 409)

    def test_requires_session_csrf_and_origin(self):
        self.assertEqual(self.create(Client(self.app))['status'], 401)
        self.assertEqual(self.create(csrf=False)['status'], 403)
        self.assertEqual(self.create(origin='https://evil.test')['status'], 403)
        token = self.create()['body']['token']
        self.assertEqual(self.accept(self.bob, token, csrf=False)['status'], 403)
        self.assertEqual(self.accept(self.bob, token, origin='https://evil.test')['status'], 403)

    def test_add_member_does_not_distinguish_unknown_usernames(self):
        missing = self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                                  {'username': 'missing-user', 'role': 'member'})
        self.assertEqual(missing['status'], 404)
        self.assertEqual(missing['body']['error']['message'], 'Member could not be added')
        self.assertNotEqual(missing['body']['error']['message'], 'User not found')

    def test_existing_v1_database_gains_table_without_version_bump(self):
        self.create()
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_invites')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='workspace_invites'").fetchone())


if __name__ == '__main__':
    unittest.main()
