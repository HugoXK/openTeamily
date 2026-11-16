"""Team create/convert tests. In-process WSGI + temporary SQLite only."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class TeamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')

    def create(self, client, name='Desk team', slug='desk-team', mode='new', key='team-create-0001', **fields):
        body = {'name': name, 'slug': slug, 'mode': mode, **fields}
        return client.call('POST', '/v1/teams', body, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_plain_workspace_lists_as_workspace_kind(self):
        created = self.alice.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'workspace-plain-0001'})
        self.assertEqual(created['status'], 201, created)
        item = created['body']['workspace']
        self.assertEqual(item['kind'], 'workspace')
        self.assertIsNone(item['slug'])
        self.assertFalse(item['converted'])

    def test_new_team_creates_independent_workspace(self):
        created = self.create(self.alice)
        self.assertEqual(created['status'], 201, created)
        item = created['body']['workspace']
        self.assertEqual(item['kind'], 'team')
        self.assertEqual(item['slug'], 'desk-team')
        self.assertEqual(item['team_name'], 'Desk team')
        self.assertEqual(item['name'], 'Desk team')
        self.assertFalse(item['converted'])
        again = self.create(self.alice, key='team-create-0001')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['workspace']['id'], item['id'])
        listed = self.alice.call('GET', '/v1/workspaces')
        self.assertEqual(listed['body']['items'][0]['slug'], 'desk-team')

    def test_convert_current_workspace_keeps_id_and_members(self):
        space = self.alice.call('POST', '/v1/workspaces', {'name': 'Lab'},
                                {'HTTP_IDEMPOTENCY_KEY': 'workspace-plain-0002'})
        wid = space['body']['workspace']['id']
        bob = Client(self.app, peer='127.0.0.2')
        bob.register('bob')
        added = self.alice.call('POST', f'/v1/workspaces/{wid}/members',
                                {'username': 'bob', 'role': 'member'})
        self.assertEqual(added['status'], 201, added)
        converted = self.create(self.alice, name='Lab team', slug='lab-team', mode='convert',
                                workspace_id=wid, key='team-convert-0001')
        self.assertEqual(converted['status'], 201, converted)
        item = converted['body']['workspace']
        self.assertEqual(item['id'], wid)
        self.assertEqual(item['kind'], 'team')
        self.assertTrue(item['converted'])
        self.assertEqual(item['name'], 'Lab team')
        members = bob.call('GET', f'/v1/workspaces/{wid}/members')
        self.assertEqual(members['status'], 200)
        self.assertEqual({row['username'] for row in members['body']['items']}, {'alice', 'bob'})
        replay = self.create(self.alice, name='Lab team', slug='lab-team', mode='convert',
                             workspace_id=wid, key='team-convert-0001')
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['workspace']['id'], wid)

    def test_rejects_invalid_slugs_and_foreign_workspaces(self):
        self.assertEqual(self.create(self.alice, slug='AB')['status'], 400)
        self.assertEqual(self.create(self.alice, slug='-desk')['status'], 400)
        self.assertEqual(self.create(self.alice, slug='settings', key='team-create-0003')['status'], 400)
        self.assertEqual(self.create(self.alice, name='x' * 61, slug='ok-name', key='team-create-0004')['status'], 400)
        self.assertEqual(self.create(self.alice, mode='convert', slug='need-space',
                                     key='team-create-0005')['status'], 400)
        other = Client(self.app, peer='127.0.0.3')
        other.register('carol')
        space = other.call('POST', '/v1/workspaces', {'name': 'Other'},
                           {'HTTP_IDEMPOTENCY_KEY': 'workspace-plain-0003'})
        self.assertEqual(self.create(self.alice, mode='convert', slug='take-it',
                                     workspace_id=space['body']['workspace']['id'],
                                     key='team-create-0006')['status'], 404)
        first = self.create(self.alice, slug='unique-id', key='team-create-0007')
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(self.create(self.alice, slug='unique-id', key='team-create-0008')['status'], 409)

    def test_existing_v1_database_gains_team_tables_without_version_bump(self):
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_teams')
            db.execute('DROP TABLE team_requests')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='workspace_teams'").fetchone())


if __name__ == '__main__':
    unittest.main()
