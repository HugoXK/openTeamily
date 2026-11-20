"""Proactive core persistence tests. In-process WSGI + temporary SQLite only.

No worker thread, network, LLM call or container execution is involved.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import proactive
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

NOW = 1800000000
TABLES = {'proactive_rules', 'proactive_events', 'proactive_runs', 'proactive_messages'}


class ProactiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: NOW)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})

    def rule(self, **changes):
        value = {'name': 'Watch', 'event_kind': 'message',
                 'cooldown_seconds': 0, 'daily_budget': 100}
        value.update(changes)
        return value

    def test_ensure_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            proactive.ensure_schema(db)
            names = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue(TABLES <= names)

    def test_event_dedupe_is_workspace_scoped(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            first = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1',
                {'text': 'first'}, 'dedupe-1', NOW)
            again = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1',
                {'text': 'changed'}, 'dedupe-1', NOW + 1)
            other = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1',
                {'text': 'other'}, 'dedupe-2', NOW)
            count = db.execute('SELECT COUNT(*) FROM proactive_events').fetchone()[0]
            stored = db.execute('SELECT payload FROM proactive_events WHERE id=?',
                                (first,)).fetchone()[0]
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)
        self.assertEqual(count, 2)
        self.assertIn('first', stored)

    def test_matching_by_kind_and_optional_scope(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            all_messages = proactive.upsert_rule(db, self.wid, self.rule(), NOW)
            conversation = proactive.upsert_rule(db, self.wid, self.rule(
                name='Conversation', source_type='conversation',
                conversation_id='conv-1'), NOW)
            agent = proactive.upsert_rule(db, self.wid, self.rule(
                name='Agent', agent_id='agent-1'), NOW)
            one = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1',
                {'conversation_id': 'conv-1', 'agent_id': 'agent-1'}, 'e1', NOW)
            two = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-2',
                {'conversation_id': 'conv-2'}, 'e2', NOW)
            ignored = proactive.record_event(
                db, self.wid, 'other', 'conversation', 'conv-1', {}, 'e3', NOW)
            runs = proactive.evaluate(db, self.wid, NOW, budget=10)
            pairs = {(run['rule_id'], run['event_id']) for run in runs}
            self.assertEqual(len(runs), 4)
            self.assertIn((all_messages['id'], one), pairs)
            self.assertIn((all_messages['id'], two), pairs)
            self.assertIn((conversation['id'], one), pairs)
            self.assertIn((agent['id'], one), pairs)
            unmatched = db.execute('SELECT consumed FROM proactive_events WHERE id=?',
                                   (ignored,)).fetchone()[0]
            later_rule = proactive.upsert_rule(
                db, self.wid, self.rule(name='Other', event_kind='other'), NOW)
            later = proactive.evaluate(db, self.wid, NOW, budget=10)
            self.assertEqual([(run['rule_id'], run['event_id']) for run in later],
                             [(later_rule['id'], ignored)])
        self.assertEqual(unmatched, 0)

    def test_cooldown_holds_then_releases_the_event(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule = proactive.upsert_rule(db, self.wid, self.rule(cooldown_seconds=3600), NOW)
            first = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'c1', NOW)
            second = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'c2', NOW + 10)
            self.assertEqual(len(proactive.evaluate(db, self.wid, NOW)), 1)
            self.assertEqual(proactive.evaluate(db, self.wid, NOW + 10), [])
            held = db.execute('SELECT consumed FROM proactive_events WHERE id=?',
                              (second,)).fetchone()[0]
            released = proactive.evaluate(db, self.wid, NOW + 3600)
            self.assertEqual([(run['rule_id'], run['event_id']) for run in released],
                             [(rule['id'], second)])
            consumed = db.execute('SELECT consumed FROM proactive_events WHERE id=?',
                                  (second,)).fetchone()[0]
            total = db.execute('SELECT COUNT(*) FROM proactive_runs').fetchone()[0]
        self.assertEqual(held, 0)
        self.assertEqual(consumed, 1)
        self.assertEqual(total, 2)

    def test_daily_budget_blocks_then_resets_next_day(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            proactive.upsert_rule(db, self.wid, self.rule(daily_budget=2), NOW)
            for index in range(3):
                proactive.record_event(
                    db, self.wid, 'message', 'conversation', 'conv-1', {},
                    f'b{index}', NOW + index)
            first = proactive.evaluate(db, self.wid, NOW + 2, budget=10)
            self.assertEqual(len(first), 2)
            self.assertEqual(proactive.evaluate(db, self.wid, NOW + 3), [])
            remaining = db.execute(
                'SELECT COUNT(*) FROM proactive_events WHERE consumed=0').fetchone()[0]
            next_day = proactive.evaluate(db, self.wid, NOW + 86400)
            total = db.execute('SELECT COUNT(*) FROM proactive_runs').fetchone()[0]
        self.assertEqual(remaining, 1)
        self.assertEqual(len(next_day), 1)
        self.assertEqual(total, 3)

    def test_claim_lease_prevents_double_claim_and_expires(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule = proactive.upsert_rule(db, self.wid, self.rule(), NOW)
            event = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'lease', NOW)
            run = proactive.enqueue_run(
                db, self.wid, rule['id'], event, {'event': event}, NOW)
            replay = proactive.enqueue_run(
                db, self.wid, rule['id'], event, {'event': event}, NOW)
            claimed = proactive.claim_runs(db, NOW, 10, 60)
            blocked = proactive.claim_runs(db, NOW + 59, 10, 60)
            expired = proactive.claim_runs(db, NOW + 61, 10, 60)
            count = db.execute('SELECT COUNT(*) FROM proactive_runs').fetchone()[0]
        self.assertEqual(run['id'], replay['id'])
        self.assertEqual(count, 1)
        self.assertEqual([(item['id'], item['status'], item['attempts']) for item in claimed],
                         [(run['id'], 'claimed', 1)])
        self.assertEqual(blocked, [])
        self.assertEqual([(item['id'], item['attempts']) for item in expired],
                         [(run['id'], 2)])

    def test_complete_and_fail_transitions(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule = proactive.upsert_rule(db, self.wid, self.rule(), NOW)
            def queued(key):
                event = proactive.record_event(
                    db, self.wid, 'message', 'conversation', 'conv-1', {}, key, NOW)
                return proactive.enqueue_run(
                    db, self.wid, rule['id'], event, {'key': key}, NOW)['id']
            done = queued('done')
            proactive.claim_runs(db, NOW, 10, 60)
            completed = proactive.complete_run(
                db, done, 'succeeded', {'text': 'ok'}, NOW + 1)
            retry = queued('retry')
            proactive.claim_runs(db, NOW, 10, 60)
            failed = proactive.fail_run(db, retry, 'timeout', NOW + 2, retryable=True)
            proactive.claim_runs(db, NOW + 2, 10, 60)
            fatal = proactive.fail_run(db, retry, 'fatal', NOW + 3, retryable=False)
        self.assertEqual(completed['status'], 'succeeded')
        self.assertEqual(completed['result'], {'text': 'ok'})
        self.assertEqual(completed['finished'], NOW + 1)
        self.assertIsNone(completed['lease_until'])
        self.assertEqual(failed['status'], 'queued')
        self.assertEqual(failed['error'], 'timeout')
        self.assertIsNone(failed['finished'])
        self.assertIsNone(failed['lease_until'])
        self.assertEqual(fatal['status'], 'failed')
        self.assertEqual(fatal['error'], 'fatal')
        self.assertEqual(fatal['finished'], NOW + 3)

    def test_duplicate_message_per_run_is_prevented_and_body_is_bounded(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule = proactive.upsert_rule(db, self.wid, self.rule(), NOW)
            event = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'msg', NOW)
            run = proactive.enqueue_run(db, self.wid, rule['id'], event, {}, NOW)
            first = proactive.record_message(
                db, self.wid, run['id'], 'conv-1', 'hello', NOW)
            again = proactive.record_message(
                db, self.wid, run['id'], 'conv-1', 'different', NOW + 1)
            count = db.execute('SELECT COUNT(*) FROM proactive_messages').fetchone()[0]
            with self.assertRaises(ValueError):
                proactive.record_message(
                    db, self.wid, run['id'], 'conv-1', 'x' * 4001, NOW + 2)
            listed = proactive.list_messages(db, self.wid, 10, None)
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(again['body'], 'hello')
        self.assertEqual(count, 1)
        self.assertEqual([item['body'] for item in listed], ['hello'])

    def test_message_listing_paginates_by_cursor(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule = proactive.upsert_rule(db, self.wid, self.rule(), NOW)
            run_ids = []
            for index in range(3):
                event = proactive.record_event(
                    db, self.wid, 'message', 'conversation', 'conv-1', {},
                    f'page-{index}', NOW)
                run = proactive.enqueue_run(db, self.wid, rule['id'], event, {}, NOW)
                run_ids.append(run['id'])
                proactive.record_message(
                    db, self.wid, run['id'], 'conv-1', f'body-{index}', NOW + index)
            page = proactive.list_messages(db, self.wid, 2, None)
            rest = proactive.list_messages(db, self.wid, 2, page[-1]['id'])
        self.assertEqual([item['body'] for item in page], ['body-0', 'body-1'])
        self.assertEqual([item['body'] for item in rest], ['body-2'])

    def test_workspace_isolation(self):
        other_wid = self.alice.workspace(
            name='Other', key='request_example_0002')['body']['workspace']['id']
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            rule_one = proactive.upsert_rule(db, self.wid, self.rule(name='One'), NOW)
            rule_two = proactive.upsert_rule(db, other_wid, self.rule(name='Two'), NOW)
            event_one = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'same-key', NOW)
            event_two = proactive.record_event(
                db, other_wid, 'message', 'conversation', 'conv-1', {}, 'same-key', NOW)
            self.assertEqual([item['id'] for item in proactive.list_rules(db, self.wid)],
                             [rule_one['id']])
            self.assertEqual([item['id'] for item in proactive.list_rules(db, other_wid)],
                             [rule_two['id']])
            first = proactive.evaluate(db, self.wid, NOW)
            second = proactive.evaluate(db, other_wid, NOW)
            self.assertEqual([(run['rule_id'], run['event_id']) for run in first],
                             [(rule_one['id'], event_one)])
            self.assertEqual([(run['rule_id'], run['event_id']) for run in second],
                             [(rule_two['id'], event_two)])
            claimed = proactive.claim_runs(db, NOW, 10, 60, workspace_id=other_wid)
            self.assertEqual([run['id'] for run in claimed], [second[0]['id']])
            with self.assertRaises(ValueError):
                proactive.record_message(
                    db, self.wid, second[0]['id'], 'conv-1', 'wrong workspace', NOW)
            proactive.record_message(
                db, other_wid, second[0]['id'], 'conv-1', 'right workspace', NOW)
            self.assertEqual(proactive.list_messages(db, self.wid, 10, None), [])
            self.assertEqual([item['body'] for item in
                              proactive.list_messages(db, other_wid, 10, None)],
                             ['right workspace'])

    def test_disabled_rule_produces_nothing(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            proactive.upsert_rule(db, self.wid, self.rule(enabled=False), NOW)
            event = proactive.record_event(
                db, self.wid, 'message', 'conversation', 'conv-1', {}, 'disabled', NOW)
            runs = proactive.evaluate(db, self.wid, NOW)
            consumed = db.execute('SELECT consumed FROM proactive_events WHERE id=?',
                                  (event,)).fetchone()[0]
        self.assertEqual(runs, [])
        self.assertEqual(consumed, 0)

    def test_oversize_payload_and_rule_text_are_rejected(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            with self.assertRaises(ValueError):
                proactive.record_event(
                    db, self.wid, 'message', 'conversation', 'conv-1',
                    {'text': 'x' * 7000}, 'oversize', NOW)
            with self.assertRaises(ValueError):
                proactive.upsert_rule(
                    db, self.wid, self.rule(name='n' * 81), NOW)
            count = db.execute('SELECT COUNT(*) FROM proactive_events').fetchone()[0]
        self.assertEqual(count, 0)

    def test_rule_upsert_update_and_remove(self):
        with self.app.store.connect() as db:
            proactive.ensure_schema(db)
            created = proactive.upsert_rule(db, self.wid, self.rule(name='Before'), NOW)
            updated = proactive.upsert_rule(
                db, self.wid, self.rule(id=created['id'], name='After'), NOW + 5)
            self.assertEqual(updated['id'], created['id'])
            self.assertEqual(updated['name'], 'After')
            self.assertEqual(updated['created'], NOW)
            self.assertTrue(proactive.remove_rule(db, self.wid, created['id']))
            self.assertFalse(proactive.remove_rule(db, self.wid, created['id']))
            self.assertEqual(proactive.list_rules(db, self.wid), [])


if __name__ == '__main__':
    unittest.main()
