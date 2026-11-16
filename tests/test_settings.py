"""Settings API tests (issue #4). In-process WSGI + temporary SQLite only."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

DEFAULTS = {'appearance': 'system', 'language': 'zh-CN', 'send_shortcut': 'enter',
            'fold_long_messages': True, 'document_cards': True}


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')

    def save(self, client, revision, changes, **kw):
        return client.call('POST', '/v1/settings', {'revision': revision, 'changes': changes}, **kw)

    def test_defaults_before_any_write(self):
        response = self.alice.call('GET', '/v1/settings')
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['settings'], {'values': DEFAULTS, 'revision': 0})

    def test_partial_update_persists_across_restart(self):
        saved = self.save(self.alice, 0, {'appearance': 'dark', 'send_shortcut': 'mod_enter'})
        self.assertEqual(saved['status'], 200)
        self.assertEqual(saved['body']['settings']['revision'], 1)
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        client = Client(restarted)
        client.cookies = dict(self.alice.cookies)
        values = client.call('GET', '/v1/settings')['body']['settings']
        self.assertEqual(values, {'values': dict(DEFAULTS, appearance='dark', send_shortcut='mod_enter'), 'revision': 1})

    def test_stale_revision_conflicts_and_returns_current(self):
        self.save(self.alice, 0, {'language': 'en'})
        stale = self.save(self.alice, 0, {'appearance': 'light'})
        self.assertEqual(stale['status'], 409)
        self.assertEqual(stale['body']['error']['current']['values']['language'], 'en')
        self.assertEqual(self.alice.call('GET', '/v1/settings')['body']['settings']['values']['appearance'], 'system')

    def test_no_op_write_does_not_bump_revision(self):
        self.save(self.alice, 0, {'fold_long_messages': False})
        again = self.save(self.alice, 1, {'fold_long_messages': False})
        self.assertEqual(again['body']['settings']['revision'], 1)

    def test_rejects_unknown_fields_and_values(self):
        for changes in ({'theme': 'dark'}, {'appearance': 'blue'}, {'fold_long_messages': 1},
                        {'language': 'fr'}, {}):
            self.assertEqual(self.save(self.alice, 0, changes)['status'], 400, changes)
        self.assertEqual(self.alice.call('POST', '/v1/settings', {'revision': '0', 'changes': {'language': 'en'}})['status'], 400)
        self.assertEqual(self.alice.call('POST', '/v1/settings', {'revision': 0, 'changes': {}, 'x': 1})['status'], 400)
        self.assertEqual(self.alice.call('GET', '/v1/settings')['body']['settings']['revision'], 0)

    def test_requires_session_csrf_and_origin(self):
        anonymous = Client(self.app)
        self.assertEqual(anonymous.call('GET', '/v1/settings')['status'], 401)
        self.assertEqual(self.save(self.alice, 0, {'language': 'en'}, csrf=False)['status'], 403)
        self.assertEqual(self.save(self.alice, 0, {'language': 'en'}, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.alice.call('GET', '/v1/settings')['body']['settings']['revision'], 0)

    def test_settings_are_isolated_per_account(self):
        bob = Client(self.app, peer='127.0.0.2')
        bob.register('bob')
        self.save(self.alice, 0, {'appearance': 'dark'})
        self.assertEqual(bob.call('GET', '/v1/settings')['body']['settings'], {'values': DEFAULTS, 'revision': 0})

    def test_corrupted_stored_values_fall_back_to_defaults(self):
        self.save(self.alice, 0, {'appearance': 'dark'})
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute("UPDATE user_settings SET document='{\"appearance\":\"neon\",\"x\":1,\"language\":\"en\"}'")
        values = self.alice.call('GET', '/v1/settings')['body']['settings']['values']
        self.assertEqual(values, dict(DEFAULTS, language='en'))

    def test_existing_v1_database_gains_table_without_version_bump(self):
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE user_settings')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='user_settings'").fetchone())


if __name__ == '__main__':
    unittest.main()
