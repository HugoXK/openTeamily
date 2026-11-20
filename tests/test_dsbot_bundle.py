"""Per-user DS-Bot import bundles (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5)."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import dsbot_bundle
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.bob_wid = self.bob.workspace(key='request_example_0002')['body']['workspace']['id']

    def user(self, db, name):
        return db.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()[0]

    def test_meetings_bundle_is_scoped_to_one_account_and_verifiable(self):
        for client, wid, title, key in ((self.alice, self.wid, '周会', 'bundle-meeting-0001'),
                                         (self.bob, self.bob_wid, 'bob 的会', 'bundle-meeting-0002')):
            self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/meetings', {'title': title},
                                         {'HTTP_IDEMPOTENCY_KEY': key})['status'], 201)
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.user(db, 'alice'), 'meetings', now=1)
            before = db.execute('SELECT COUNT(*) FROM meetings').fetchone()[0]
        self.assertEqual(bundle['format'], dsbot_bundle.FORMAT)
        text = bundle['tables']['meetings']
        self.assertEqual(bundle['manifest']['meetings'],
                         {'rows': 1, 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()})
        rows = json.loads(text)
        self.assertEqual([row['title'] for row in rows], ['周会'])
        self.assertEqual(rows[0]['workspace_id'], self.wid)
        self.assertEqual(before, 2, 'legacy rows are left untouched')
        self.assertEqual(json.loads(dsbot_bundle.dumps(bundle)), bundle)
        with self.assertRaises(ValueError):
            dsbot_bundle.build(db, 'x', 'nope')


if __name__ == '__main__':
    unittest.main()
