"""Workspace membership tests (issue #7). In-process WSGI + temporary SQLite only."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemberTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']

    def members(self, client, wid=None):
        return client.call('GET', f'/v1/workspaces/{wid or self.wid}/members')

    def add(self, client, username, role='member', wid=None, **kw):
        return client.call('POST', f'/v1/workspaces/{wid or self.wid}/members',
                           {'username': username, 'role': role}, **kw)

    def change(self, client, user_id, role, wid=None, **kw):
        return client.call('POST', f'/v1/workspaces/{wid or self.wid}/members/{user_id}',
                           {'role': role}, **kw)

    def remove(self, client, user_id, wid=None, **kw):
        return client.call('POST', f'/v1/workspaces/{wid or self.wid}/members/{user_id}/remove',
                           {}, **kw)

    def test_owner_lists_self_and_added_members_persist(self):
        listed = self.members(self.alice)
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['username'] for row in listed['body']['items']], ['alice'])
        self.assertEqual(listed['body']['items'][0]['role'], 'owner')
        added = self.add(self.alice, 'Bob', 'admin')
        self.assertEqual(added['status'], 201)
        self.assertEqual(added['body']['member']['username'], 'bob')
        self.assertEqual(added['body']['member']['role'], 'admin')
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        alice = Client(restarted)
        alice.cookies = dict(self.alice.cookies)
        names = [(row['username'], row['role']) for row in self.members(alice)['body']['items']]
        self.assertEqual(names, [('alice', 'owner'), ('bob', 'admin')])

    def test_members_see_workspace_and_strangers_get_404(self):
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}')['status'], 404)
        self.assertEqual(self.members(self.bob)['status'], 404)
        self.assertEqual(self.add(self.bob, 'carol')['status'], 404)
        self.add(self.alice, 'bob')
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}')['status'], 200)
        self.assertEqual(self.members(self.bob)['status'], 200)
        self.assertIn(self.wid, [row['id'] for row in self.bob.call('GET', '/v1/workspaces')['body']['items']])
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}')['status'], 404)
        self.assertEqual(self.carol.call('GET', '/v1/workspaces')['body']['items'], [])

    def test_membership_does_not_leak_other_workspaces_or_accounts(self):
        other = self.alice.workspace('second', 'request_example_0002')['body']['workspace']['id']
        self.add(self.alice, 'bob')
        ids = {row['id'] for row in self.bob.call('GET', '/v1/workspaces')['body']['items']}
        self.assertEqual(ids, {self.wid})
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other}')['status'], 404)
        self.assertEqual(self.members(self.bob, other)['status'], 404)

    def test_admin_can_add_and_remove_members_but_not_admins(self):
        bob_id = self.add(self.alice, 'bob', 'admin')['body']['member']['user_id']
        added = self.add(self.bob, 'carol', 'member')
        self.assertEqual(added['status'], 201)
        self.assertEqual(self.add(self.bob, 'carol', 'admin')['status'], 409)
        dave = Client(self.app, peer='127.0.0.4')
        dave.register('dave')
        self.assertEqual(self.add(self.bob, 'dave', 'admin')['status'], 403)
        self.assertEqual(self.change(self.bob, added['body']['member']['user_id'], 'admin')['status'], 403)
        dave_id = self.add(self.alice, 'dave', 'admin')['body']['member']['user_id']
        self.assertEqual(self.remove(self.bob, dave_id)['status'], 403)
        self.assertEqual(self.remove(self.bob, added['body']['member']['user_id'])['status'], 200)
        self.assertEqual(self.members(self.carol)['status'], 404)

    def test_member_is_read_only_but_may_leave(self):
        bob_id = self.add(self.alice, 'bob', 'member')['body']['member']['user_id']
        self.assertEqual(self.add(self.bob, 'carol')['status'], 403)
        self.assertEqual(self.change(self.alice, bob_id, 'admin')['status'], 200)
        self.assertEqual(self.change(self.alice, bob_id, 'member')['body']['member']['role'], 'member')
        left = self.remove(self.bob, bob_id)
        self.assertEqual(left['status'], 200)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}')['status'], 404)

    def test_cannot_add_owner_unknown_user_or_change_owner(self):
        owner_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.assertEqual(self.add(self.alice, 'alice')['status'], 409)
        self.assertEqual(self.add(self.alice, 'missing-user')['status'], 404)
        self.assertEqual(self.change(self.alice, owner_id, 'admin')['status'], 404)
        self.assertEqual(self.remove(self.alice, owner_id)['status'], 404)
        self.assertEqual(self.members(self.alice)['body']['items'][0]['role'], 'owner')

    def test_idempotent_same_role_and_conflict_on_role_mismatch(self):
        first = self.add(self.alice, 'bob', 'member')
        again = self.add(self.alice, 'bob', 'member')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['member'], first['body']['member'])
        self.assertEqual(self.add(self.alice, 'bob', 'admin')['status'], 409)

    def test_requires_session_csrf_and_origin(self):
        anonymous = Client(self.app)
        self.assertEqual(self.members(anonymous)['status'], 401)
        self.assertEqual(self.add(anonymous, 'bob')['status'], 401)
        self.assertEqual(self.add(self.alice, 'bob', csrf=False)['status'], 403)
        self.assertEqual(self.add(self.alice, 'bob', origin='https://evil.test')['status'], 403)
        self.assertEqual(len(self.members(self.alice)['body']['items']), 1)

    def test_rejects_unknown_fields_and_invalid_roles(self):
        for body in ({'username': 'bob'}, {'role': 'member'}, {'username': 'bob', 'role': 'owner'},
                     {'username': 'bob', 'role': 'member', 'owner_id': 'x'}, {'username': 'x', 'role': 'member'}):
            status = self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', body)['status']
            self.assertEqual(status, 400, body)
        bob_id = self.add(self.alice, 'bob')['body']['member']['user_id']
        self.assertEqual(self.change(self.alice, bob_id, 'owner')['status'], 400)
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{bob_id}/remove',
                                         {'confirm': True})['status'], 400)

    def test_member_quota_and_existing_v1_database(self):
        self.app.config = replace(self.app.config, max_members_per_workspace=2)
        self.assertEqual(self.add(self.alice, 'bob')['status'], 201)
        self.assertEqual(self.add(self.alice, 'carol')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_members')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='workspace_members'").fetchone())


if __name__ == '__main__':
    unittest.main()
