"""Connection runtime-key API tests. In-process WSGI only."""
import sqlite3
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.security import digest
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class RuntimeKeyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app)
        self.bob.register('bob')

    def create(self, client=None, name='laptop', **body):
        payload = {'name': name}
        payload.update(body)
        return (client or self.alice).call('POST', '/v1/runtime-keys', payload)

    def test_token_is_shown_once_and_list_is_prefix_only(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        token = created['body']['token']
        key = created['body']['key']
        self.assertRegex(token, r'^[A-Za-z0-9_-]{32,128}$')
        self.assertEqual(key['prefix'], token[:8])
        self.assertIsNone(key['expires'])
        self.assertFalse(key['revoked'])
        self.assertNotIn('token', key)
        listed = self.alice.call('GET', '/v1/runtime-keys')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(listed['body']['items'][0]['prefix'], key['prefix'])
        self.assertNotIn('token', listed['body'])
        self.assertNotIn('token', listed['body']['items'][0])
        self.assertRegex(listed['body']['device_id'], r'^fbdev_[0-9a-f]{32}$')
        again = self.alice.call('GET', '/v1/runtime-keys')
        self.assertEqual(again['body']['device_id'], listed['body']['device_id'])
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute('SELECT token_hash, prefix FROM runtime_keys').fetchone()
            self.assertEqual(row[0], digest(token))
            self.assertEqual(row[1], token[:8])
            dumped = db.execute("SELECT * FROM runtime_keys").fetchall()
            self.assertNotIn(token, ''.join(str(part) for part in dumped))

    def test_expiry_revoke_and_foreign_keys_are_hidden(self):
        created = self.create(expires_in=120)
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['key']['expires'], self.now + 120)
        key_id = created['body']['key']['id']
        self.assertEqual(self.bob.call('GET', '/v1/runtime-keys')['body']['items'], [])
        self.assertEqual(self.bob.call('POST', f'/v1/runtime-keys/{key_id}/revoke', {})['status'], 404)
        revoked = self.alice.call('POST', f'/v1/runtime-keys/{key_id}/revoke', {})
        self.assertEqual(revoked['status'], 200)
        self.assertTrue(revoked['body']['key']['revoked'])
        self.assertNotIn('token', revoked['body']['key'])
        listed = self.alice.call('GET', '/v1/runtime-keys')
        self.assertTrue(listed['body']['items'][0]['revoked'])

    def test_rejects_invalid_names_and_expiry_and_requires_csrf(self):
        self.assertEqual(self.create(name='')['status'], 400)
        self.assertEqual(self.create(name='x' * 81)['status'], 400)
        self.assertEqual(self.create(expires_in=10)['status'], 400)
        self.assertEqual(self.create(expires_in=0)['status'], 400)
        self.assertEqual(self.create(name='ok', extra='no')['status'], 400)
        self.assertEqual(self.alice.call('POST', '/v1/runtime-keys', {'name': 'x'}, csrf=False)['status'], 403)
        self.assertEqual(self.alice.call('POST', '/v1/runtime-keys', {'name': 'x'},
                                         origin='https://evil.test')['status'], 403)

    def test_quota_and_existing_v1_database(self):
        for index in range(20):
            self.assertEqual(self.create(name=f'key-{index}')['status'], 201)
        self.assertEqual(self.create(name='overflow')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE runtime_keys')
            db.execute('DROP TABLE runtime_devices')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute(
                "SELECT name FROM sqlite_master WHERE name='runtime_keys'").fetchone())
            self.assertIsNotNone(db.execute(
                "SELECT name FROM sqlite_master WHERE name='runtime_devices'").fetchone())


if __name__ == '__main__':
    unittest.main()
