"""Web Push subscription registry and payload-builder tests. In-process SQLite only."""
import logging
from pathlib import Path
import tempfile
import unittest

from openteamily import push_subscriptions
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


ENDPOINT_A = 'https://push.example.test/sub/alice-device'
ENDPOINT_B = 'https://push.example.test/sub/bob-device'
P256DH = 'test-p256dh-public-key-material'
AUTH = 'test-auth-key-material'
TOPICS = ['mention', 'artifact']


class PushSubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.store = Store(self.path)
        self.config = Config(ORIGIN, allow_registration=True)
        self.now = 1800000000
        self.app = App(self.store, self.config, clock=lambda: self.now)
        alice = Client(self.app)
        self.alice_id = alice.register('alice')['body']['user']['id']
        bob = Client(self.app, peer='127.0.0.2')
        self.bob_id = bob.register('bob')['body']['user']['id']
        with self.app.store.connect() as db:
            push_subscriptions.ensure_schema(db)

    def register(self, db, user_id=None, endpoint=ENDPOINT_A, p256dh=P256DH, auth=AUTH,
                 now=None, **kw):
        return push_subscriptions.register(
            db, user_id or self.alice_id, endpoint, p256dh, auth,
            self.now if now is None else now, **kw)

    def test_schema_is_idempotent_and_has_expected_shape(self):
        with self.app.store.connect() as db:
            push_subscriptions.ensure_schema(db)
            tables = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('push_subscriptions', tables)
            columns = {row['name'] for row in db.execute('PRAGMA table_info(push_subscriptions)')}
            self.assertEqual(columns, {
                'id', 'user_id', 'endpoint', 'p256dh', 'auth', 'user_agent',
                'topics', 'enabled', 'created', 'updated', 'last_seen',
            })
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='push_subscriptions'")}
            self.assertIn('push_subscription_user', indexes)
            self.assertIn('push_subscription_seen', indexes)

    def test_register_upserts_reenables_and_keeps_one_row(self):
        with self.app.store.connect() as db:
            first = self.register(db, topics=TOPICS, user_agent='Test Agent')
            self.assertTrue(first['enabled'])
            self.assertEqual(first['topics'], TOPICS)
            self.assertEqual(first['user_agent'], 'Test Agent')
            self.assertEqual(first['created'], self.now)
            self.assertEqual(first['last_seen'], self.now)

            second = self.register(
                db, p256dh='rotated-public-key', auth='rotated-auth', now=self.now + 10,
                topics=['mention'], user_agent='Test Agent 2')
            self.assertEqual(second['id'], first['id'])
            self.assertEqual(second['created'], first['created'])
            self.assertEqual(second['updated'], self.now + 10)
            self.assertEqual(second['topics'], ['mention'])
            self.assertEqual(second['p256dh'], 'rotated-public-key')
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM push_subscriptions WHERE user_id=? AND endpoint=?',
                (self.alice_id, ENDPOINT_A)).fetchone()[0], 1)

            self.assertTrue(push_subscriptions.deactivate(
                db, self.alice_id, first['id'], self.now + 20))
            third = self.register(db, now=self.now + 30, topics=TOPICS)
            self.assertEqual(third['id'], first['id'])
            self.assertTrue(third['enabled'])
            self.assertEqual(third['last_seen'], self.now + 30)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM push_subscriptions').fetchone()[0], 1)

    def test_invalid_endpoints_and_key_material_are_rejected(self):
        invalid = [
            'http://push.example.test/sub/alice',
            'https://' + 'a' * 5000,
            'https://',
            'https://user:pass@push.example.test/sub/alice',
        ]
        with self.app.store.connect() as db:
            for endpoint in invalid:
                with self.assertRaises(ValueError):
                    self.register(db, endpoint=endpoint)
            with self.assertRaises(ValueError):
                self.register(db, p256dh='')
            with self.assertRaises(ValueError):
                self.register(db, auth='x' * 5000)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM push_subscriptions').fetchone()[0], 0)

    def test_topics_are_allowlisted_deduped_and_bounded(self):
        with self.app.store.connect() as db:
            sub = self.register(db, topics=['mention', 'mention', 'artifact', 'mention'])
            self.assertEqual(sub['topics'], ['mention', 'artifact'])

            with self.assertRaises(ValueError):
                self.register(db, endpoint=ENDPOINT_B, topics=['mention', 'unknown'])
            with self.assertRaises(ValueError):
                self.register(db, endpoint=ENDPOINT_B, topics=['mention'] * 33)

            changed = push_subscriptions.update_topics(
                db, self.alice_id, sub['id'], ['artifact', 'follow_work', 'artifact'], self.now + 1)
            self.assertEqual(changed['topics'], ['artifact', 'follow_work'])
            updated = push_subscriptions.list_for_user(db, self.alice_id)[0]
            self.assertEqual(updated['topics'], ['artifact', 'follow_work'])
            self.assertEqual(updated['updated'], self.now + 1)

            with self.assertRaises(ValueError):
                push_subscriptions.update_topics(db, self.alice_id, sub['id'], ['nope'], self.now + 2)
            unchanged = push_subscriptions.list_for_user(db, self.alice_id)[0]
            self.assertEqual(unchanged['topics'], ['artifact', 'follow_work'])

    def test_list_is_isolated_per_user_and_cross_user_writes_fail(self):
        with self.app.store.connect() as db:
            alice_sub = self.register(db, topics=['mention'])
            bob_sub = self.register(
                db, user_id=self.bob_id, endpoint=ENDPOINT_B, now=self.now + 1,
                topics=['artifact'])
            alice_ids = [item['id'] for item in push_subscriptions.list_for_user(db, self.alice_id)]
            bob_ids = [item['id'] for item in push_subscriptions.list_for_user(db, self.bob_id)]
            self.assertEqual(alice_ids, [alice_sub['id']])
            self.assertEqual(bob_ids, [bob_sub['id']])

            self.assertIsNone(push_subscriptions.update_topics(
                db, self.bob_id, alice_sub['id'], ['mention'], self.now + 2))
            self.assertFalse(push_subscriptions.deactivate(
                db, self.bob_id, alice_sub['id'], self.now + 2))
            self.assertFalse(push_subscriptions.remove(db, self.bob_id, alice_sub['id']))
            self.assertEqual(push_subscriptions.list_for_user(db, self.alice_id)[0]['topics'], ['mention'])
            self.assertTrue(push_subscriptions.list_for_user(db, self.alice_id)[0]['enabled'])
            self.assertEqual(push_subscriptions.list_for_user(db, self.bob_id)[0]['id'], bob_sub['id'])
            self.assertTrue(push_subscriptions.remove(db, self.alice_id, alice_sub['id']))
            self.assertFalse(push_subscriptions.remove(db, self.alice_id, alice_sub['id']))

    def test_deactivate_keeps_the_row_and_marks_it_disabled(self):
        with self.app.store.connect() as db:
            sub = self.register(db)
            self.assertTrue(push_subscriptions.deactivate(db, self.alice_id, sub['id'], self.now + 5))
            listed = push_subscriptions.list_for_user(db, self.alice_id)
            self.assertEqual(len(listed), 1)
            self.assertFalse(listed[0]['enabled'])
            self.assertEqual(listed[0]['updated'], self.now + 5)
            self.assertEqual(listed[0]['last_seen'], self.now)

    def test_deactivate_expired_uses_last_seen_and_only_counts_newly_disabled(self):
        with self.app.store.connect() as db:
            old = self.register(db, now=1000)
            fresh = self.register(db, user_id=self.bob_id, endpoint=ENDPOINT_B, now=2000)
            self.assertEqual(push_subscriptions.deactivate_expired(db, 3000, 1500), 1)
            self.assertEqual(push_subscriptions.deactivate_expired(db, 3000, 1500), 0)
            listed = {item['id']: item for item in push_subscriptions.list_for_user(db, self.alice_id)}
            self.assertFalse(listed[old['id']]['enabled'])
            self.assertEqual(listed[old['id']]['updated'], 3000)
            bob_listed = push_subscriptions.list_for_user(db, self.bob_id)
            self.assertTrue(bob_listed[0]['enabled'])
            self.assertEqual(bob_listed[0]['id'], fresh['id'])
            with self.assertRaises(ValueError):
                push_subscriptions.deactivate_expired(db, 3000, -1)

    def test_build_payload_is_bounded_and_omits_missing_optionals(self):
        base = push_subscriptions.build_payload('Title', 'Body')
        self.assertEqual(base, {'title': 'Title', 'body': 'Body'})
        self.assertNotIn('url', base)

        rich = push_subscriptions.build_payload(
            'Title', 'Body', url='/inbox?item=1', tag='mention-1',
            data={'kind': 'mention', 'id': 'abc'}, icon='https://cdn.example.test/icon.png')
        self.assertEqual(rich['url'], '/inbox?item=1')
        self.assertEqual(rich['tag'], 'mention-1')
        self.assertEqual(rich['data'], {'kind': 'mention', 'id': 'abc'})
        self.assertEqual(rich['icon'], 'https://cdn.example.test/icon.png')

        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('x' * 10000, 'Body')
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'x' * 10000)
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', tag='x' * 1000)
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', url='http://example.test/x')
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', url='javascript:alert(1)')
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', icon='//example.test/icon.png')
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', data={'blob': 'x' * 10000})
        with self.assertRaises(ValueError):
            push_subscriptions.build_payload('Title', 'Body', data={'bad': object()})

    def test_operations_do_not_log_and_store_only_registry_fields(self):
        records = []

        class Collect(logging.Handler):
            def emit(self, record):
                records.append(record)

        handler = Collect()
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            with self.app.store.connect() as db:
                sub = self.register(db, topics=TOPICS, user_agent='Test Agent')
                push_subscriptions.update_topics(
                    db, self.alice_id, sub['id'], ['artifact'], self.now + 1)
                push_subscriptions.deactivate(db, self.alice_id, sub['id'], self.now + 2)
                push_subscriptions.deactivate_expired(db, self.now + 3, 1)
                push_subscriptions.remove(db, self.alice_id, sub['id'])
        finally:
            root.removeHandler(handler)
        self.assertEqual(records, [])

        with self.app.store.connect() as db:
            sub = self.register(db)
            row = db.execute('SELECT * FROM push_subscriptions').fetchone()
            self.assertEqual(set(row.keys()), {
                'id', 'user_id', 'endpoint', 'p256dh', 'auth', 'user_agent',
                'topics', 'enabled', 'created', 'updated', 'last_seen',
            })
            self.assertEqual(row['p256dh'], P256DH)
            self.assertEqual(row['auth'], AUTH)
            self.assertNotIn('password', row.keys())
            self.assertNotIn('token', row.keys())
            self.assertEqual(sub['id'], row['id'])


if __name__ == '__main__':
    unittest.main()
