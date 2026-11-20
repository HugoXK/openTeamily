"""Moderation persistence tests. Temporary SQLite only; no HTTP routes are wired."""
from pathlib import Path
import tempfile
import unittest

from openteamily import moderation
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


NOW = 1800000000


class ModerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = (Path(self.temp.name) / 'state').resolve()
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: NOW)
        self.alice = Client(self.app)
        self.alice_id = self.alice.register('alice')['body']['user']['id']
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob_id = self.bob.register('bob')['body']['user']['id']
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol_id = self.carol.register('carol')['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other = self.bob.workspace(
            name='Bob workspace', key='request_example_bob01')['body']['workspace']['id']
        with self.app.store.connect() as db:
            moderation.ensure_schema(db)

    def block(self, blocker_id=None, blocked_id=None, now=NOW):
        with self.app.store.connect() as db:
            return moderation.block(
                db, blocker_id or self.alice_id, blocked_id or self.bob_id, now)

    def report(self, reporter_id=None, target_type='message', target_id='message-0001',
               reason='spam', details=None, workspace_id=None, now=NOW):
        with self.app.store.connect() as db:
            return moderation.report_content(
                db, workspace_id or self.wid, reporter_id or self.alice_id,
                target_type, target_id, reason, now, details=details)

    def resolve(self, report_id, status='actioned', resolution='Removed content.',
                action='remove', reviewer_id=None, workspace_id=None, now=NOW + 1):
        with self.app.store.connect() as db:
            return moderation.resolve_report(
                db, workspace_id or self.wid, report_id, reviewer_id or self.bob_id,
                now, status, resolution, action=action)

    def reports(self, workspace_id=None, **kwargs):
        with self.app.store.connect() as db:
            return moderation.list_reports(db, workspace_id or self.wid, **kwargs)

    def test_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            moderation.ensure_schema(db)
            moderation.ensure_schema(db)
            tables = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'")}
            block_columns = [row['name'] for row in db.execute('PRAGMA table_info(user_blocks)')]
            report_columns = [row['name'] for row in db.execute('PRAGMA table_info(content_reports)')]
            action_columns = [row['name'] for row in db.execute('PRAGMA table_info(moderation_actions)')]
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertTrue({'user_blocks', 'content_reports', 'moderation_actions'} <= tables)
        self.assertEqual(block_columns, ['blocker_id', 'blocked_id', 'created'])
        self.assertEqual(report_columns, [
            'id', 'workspace_id', 'reporter_id', 'target_type', 'target_id', 'reason',
            'details', 'status', 'reviewer_id', 'resolution', 'created', 'updated',
        ])
        self.assertEqual(action_columns, [
            'id', 'report_id', 'actor_id', 'action', 'notes', 'created',
        ])
        self.assertTrue({
            'content_report_open', 'content_report_queue', 'moderation_action_report',
        } <= indexes)

    def test_block_unblock_is_idempotent_and_self_block_is_rejected(self):
        first = self.block()
        replay = self.block(now=NOW + 50)
        self.assertEqual(first['blocker_id'], self.alice_id)
        self.assertEqual(first['blocked_id'], self.bob_id)
        self.assertEqual(replay['created'], first['created'])
        with self.assertRaises(ValueError):
            self.block(self.alice_id, self.alice_id)
        with self.app.store.connect() as db:
            self.assertTrue(moderation.is_blocked(db, self.alice_id, self.bob_id))
            self.assertFalse(moderation.is_blocked(db, self.bob_id, self.alice_id))
            self.assertEqual([row['blocked_id'] for row in moderation.list_blocks(
                db, self.alice_id)], [self.bob_id])
            self.assertEqual(moderation.list_blocks(db, self.bob_id), [])
            self.assertTrue(moderation.unblock(db, self.alice_id, self.bob_id))
            self.assertFalse(moderation.unblock(db, self.alice_id, self.bob_id))
            self.assertFalse(moderation.is_blocked(db, self.alice_id, self.bob_id))
            self.assertEqual(moderation.list_blocks(db, self.alice_id), [])
        self.block(self.alice_id, self.carol_id, now=NOW + 1)
        self.block(self.alice_id, self.bob_id, now=NOW + 2)
        with self.app.store.connect() as db:
            self.assertEqual(
                {row['blocked_id'] for row in moderation.list_blocks(db, self.alice_id)},
                {self.bob_id, self.carol_id})

    def test_report_create_is_idempotent_and_only_while_pending(self):
        first = self.report(details='Repeated advertising')
        replay = self.report(details='Different details under the same open report')
        self.assertEqual(replay['id'], first['id'])
        self.assertEqual(replay['details'], 'Repeated advertising')
        self.assertEqual(first['status'], 'pending')
        self.assertIsNone(first['reviewer_id'])
        self.assertEqual(self.reports(), [first])
        self.resolve(first['id'], status='dismissed', resolution='Not a violation.',
                     action='none')
        reopened = self.report(details='New evidence')
        self.assertNotEqual(reopened['id'], first['id'])
        self.assertEqual(len(self.reports()), 2)

    def test_invalid_target_and_reason_are_rejected(self):
        for target_type in ('channel', '', None, 'MESSAGE'):
            with self.assertRaises(ValueError):
                self.report(target_type=target_type)
        for reason in ('not-a-reason', '', None, 'SPAM'):
            with self.assertRaises(ValueError):
                self.report(reason=reason)
        with self.assertRaises(ValueError):
            self.report(target_id='')
        self.assertEqual(self.reports(), [])

    def test_list_filters_and_cursor(self):
        first = self.report(target_id='message-0001')
        second = self.report(target_id='message-0002')
        third = self.report(target_id='message-0003')
        fourth = self.report(target_id='message-0004')
        self.resolve(third['id'])
        ordered = sorted([first['id'], second['id'], third['id'], fourth['id']])
        all_items = self.reports()
        self.assertEqual([item['id'] for item in all_items], ordered)
        pending = self.reports(status='pending')
        self.assertEqual({item['id'] for item in pending},
                         {first['id'], second['id'], fourth['id']})
        actioned = self.reports(status='actioned')
        self.assertEqual([item['id'] for item in actioned], [third['id']])
        page_one = self.reports(limit=2)
        page_two = self.reports(limit=2, cursor=page_one[-1]['id'])
        self.assertEqual([item['id'] for item in page_one], ordered[:2])
        self.assertEqual([item['id'] for item in page_two], ordered[2:])
        with self.assertRaises(ValueError):
            self.reports(status='open')
        with self.assertRaises(ValueError):
            self.reports(limit=0)
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                moderation.list_reports(db, self.wid, limit=5, cursor=123)

    def test_resolve_records_reviewer_action_and_rejects_reopening(self):
        report = self.report()
        resolved = self.resolve(report['id'], status='actioned', reviewer_id=self.bob_id,
                                resolution='Removed the message.', action='remove')
        self.assertEqual(resolved['status'], 'actioned')
        self.assertEqual(resolved['reviewer_id'], self.bob_id)
        self.assertEqual(resolved['resolution'], 'Removed the message.')
        self.assertEqual(resolved['updated'], NOW + 1)
        replay = self.resolve(report['id'], status='actioned', reviewer_id=self.carol_id,
                              resolution='A different retry.', action='remove')
        self.assertEqual(replay, resolved)
        with self.app.store.connect() as db:
            actions = db.execute(
                'SELECT * FROM moderation_actions WHERE report_id=?', (report['id'],)).fetchall()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]['actor_id'], self.bob_id)
        self.assertEqual(actions[0]['action'], 'remove')
        self.assertEqual(actions[0]['notes'], 'Removed the message.')
        self.assertEqual(actions[0]['created'], NOW + 1)
        with self.assertRaises(ValueError):
            self.resolve(report['id'], status='dismissed')
        self.assertEqual(self.resolve(report['id'], status='actioned')['status'], 'actioned')
        with self.assertRaises(ValueError):
            self.resolve(report['id'], status='pending')
        with self.assertRaises(ValueError):
            self.resolve(report['id'], status='unknown')
        with self.assertRaises(LookupError):
            self.resolve('f' * 32)
        dismissed = self.report(target_id='message-0002')
        self.assertEqual(self.resolve(
            dismissed['id'], status='dismissed', resolution='No action needed.',
            action='none')['status'], 'dismissed')

    def test_count_pending_and_workspace_isolation(self):
        mine = self.report(target_type='work', target_id='work-0001')
        self.report(target_type='work', target_id='work-0002')
        theirs = self.report(reporter_id=self.bob_id, target_type='work',
                             target_id='work-0001', workspace_id=self.other)
        with self.app.store.connect() as db:
            self.assertEqual(moderation.count_pending(db, self.wid), 2)
            self.assertEqual(moderation.count_pending(db, self.other), 1)
            self.assertEqual(moderation.get_report(db, self.wid, mine['id']), mine)
            self.assertIsNone(moderation.get_report(db, self.wid, theirs['id']))
            self.assertIsNone(moderation.get_report(db, self.wid, 'f' * 32))
            self.assertEqual(
                [item['id'] for item in moderation.list_reports(db, self.other)],
                [theirs['id']])
        self.resolve(mine['id'], status='dismissed', resolution='Handled.')
        with self.app.store.connect() as db:
            self.assertEqual(moderation.count_pending(db, self.wid), 1)
            self.assertEqual(moderation.count_pending(db, self.other), 1)
            with self.assertRaises(LookupError):
                moderation.resolve_report(
                    db, self.other, mine['id'], self.bob_id, NOW + 2,
                    'actioned', 'Cross-workspace write')
        same_target_other = self.report(
            reporter_id=self.alice_id, target_type='work', target_id='work-0001',
            workspace_id=self.other)
        self.assertNotEqual(same_target_other['id'], mine['id'])

    def test_oversize_and_bad_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            self.report(details='x' * (moderation.DETAILS_MAX + 1))
        report = self.report()
        with self.assertRaises(ValueError):
            self.resolve(report['id'], resolution='x' * (moderation.RESOLUTION_MAX + 1))
        with self.assertRaises(ValueError):
            self.resolve(report['id'], action='x' * (moderation.ACTION_MAX + 1))
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                moderation.list_reports(db, self.wid, limit=moderation.MAX_LIMIT + 1)
        with self.app.store.connect() as db:
            self.assertEqual(
                db.execute('SELECT COUNT(*) FROM moderation_actions').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
