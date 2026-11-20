"""Chat poll persistence tests. In-process Store + temporary SQLite only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily import polls
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class PollTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.path = (Path(self.temp.name) / 'state').resolve()
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.eve = Client(self.app, peer='127.0.0.4')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'carol', 'role': 'member'})
        self.alice_id = self._user_id(self.alice)
        self.bob_id = self._user_id(self.bob)
        self.carol_id = self._user_id(self.carol)
        self.conversation = 'c' * 32
        with self.app.store.connect() as db:
            polls.ensure_schema(db)

    def _user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def create(self, client=None, options=('Yes', 'No'), **kw):
        fields = {'workspace_id': self.wid, 'conversation_id': self.conversation,
                  'created_by': self.alice_id, 'question': 'Lunch?',
                  'options': list(options), 'now': self.now}
        fields.update(kw)
        with self.app.store.connect() as db:
            return polls.create_poll(db, **fields)

    def get(self, poll_id, workspace_id=None, viewer_id=None):
        with self.app.store.connect() as db:
            return polls.get_poll(db, workspace_id or self.wid, poll_id, viewer_id=viewer_id)

    def vote(self, poll_id, user_id, option_ids, workspace_id=None, now=None):
        with self.app.store.connect() as db:
            return polls.vote(db, workspace_id or self.wid, poll_id, user_id, option_ids,
                              self.now if now is None else now)

    def test_schema_is_idempotent_and_keeps_existing_rows(self):
        poll = self.create()
        with self.app.store.connect() as db:
            polls.ensure_schema(db)
            polls.ensure_schema(db)
            names = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({'polls', 'poll_options', 'poll_votes'} <= names)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM polls').fetchone()[0], 1)
        self.assertEqual(self.get(poll['id'])['question'], 'Lunch?')

    def test_create_get_and_list_with_cursor_paging(self):
        first = self.create(question='First', now=self.now)
        second = self.create(question='Second', now=self.now + 1)
        third = self.create(question='Third', now=self.now + 2)
        self.assertEqual(first['status'], 'open')
        self.assertEqual([item['text'] for item in first['options']], ['Yes', 'No'])
        self.assertEqual(first['total'], 0)
        self.assertEqual(first['votes'], [])
        self.assertEqual(self.get(first['id'], viewer_id=self.alice_id)['id'], first['id'])
        with self.app.store.connect() as db:
            page = polls.list_polls(db, self.wid, self.conversation, 2, None)
            self.assertEqual([item['id'] for item in page['items']], [first['id'], second['id']])
            self.assertEqual(page['next_cursor'], second['id'])
            rest = polls.list_polls(db, self.wid, self.conversation, 2, page['next_cursor'])
            self.assertEqual([item['id'] for item in rest['items']], [third['id']])
            self.assertIsNone(rest['next_cursor'])
            self.assertEqual([item['id'] for item in polls.list_polls(
                db, self.wid, self.conversation, 10, None)['items']],
                [first['id'], second['id'], third['id']])

    def test_single_choice_replaces_and_duplicate_vote_is_idempotent(self):
        poll = self.create(multi_select=False)
        yes, no = [item['id'] for item in poll['options']]
        voted = self.vote(poll['id'], self.alice_id, [yes])
        self.assertEqual(voted['votes'], [yes])
        self.assertEqual(voted['total'], 1)
        repeated = self.vote(poll['id'], self.alice_id, [yes])
        self.assertEqual(repeated['total'], 1)
        self.assertEqual([item['count'] for item in repeated['options']], [1, 0])
        changed = self.vote(poll['id'], self.alice_id, [no])
        self.assertEqual(changed['votes'], [no])
        self.assertEqual(changed['total'], 1)
        self.assertEqual([item['count'] for item in changed['options']], [0, 1])
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.alice_id, [yes, no])

    def test_multi_choice_adds_and_duplicate_vote_is_idempotent(self):
        poll = self.create(multi_select=True)
        yes, no = [item['id'] for item in poll['options']]
        self.assertEqual(self.vote(poll['id'], self.alice_id, [yes])['total'], 1)
        both = self.vote(poll['id'], self.alice_id, [no])
        self.assertEqual(set(both['votes']), {yes, no})
        self.assertEqual(both['total'], 2)
        self.assertEqual([item['count'] for item in both['options']], [1, 1])
        repeated = self.vote(poll['id'], self.alice_id, [yes, no])
        self.assertEqual(repeated['total'], 2)
        self.assertEqual(set(repeated['votes']), {yes, no})

    def test_invalid_and_foreign_options_are_rejected(self):
        poll = self.create()
        other = self.create(question='Other', options=('A', 'B'))
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.alice_id, ['missing'])
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.alice_id, [other['options'][0]['id']])
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.alice_id, [])
        self.assertEqual(self.get(poll['id'])['total'], 0)

    def test_closed_status_and_closes_timestamp_reject_votes(self):
        poll = self.create(closes=self.now + 10)
        option = poll['options'][0]['id']
        self.assertEqual(self.vote(poll['id'], self.alice_id, [option], now=self.now + 9)['total'], 1)
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.bob_id, [option], now=self.now + 10)
        with self.app.store.connect() as db:
            closed = polls.close_poll(db, self.wid, poll['id'], self.alice_id, self.now + 11)
        self.assertEqual(closed['status'], 'closed')
        with self.assertRaises(ValueError):
            self.vote(poll['id'], self.bob_id, [option], now=self.now + 9)

    def test_only_creator_can_close_or_delete_and_delete_cascades(self):
        poll = self.create()
        option = poll['options'][0]['id']
        self.vote(poll['id'], self.bob_id, [option])
        with self.app.store.connect() as db:
            with self.assertRaises(PermissionError):
                polls.close_poll(db, self.wid, poll['id'], self.bob_id, self.now)
            with self.assertRaises(PermissionError):
                polls.delete_poll(db, self.wid, poll['id'], self.carol_id)
            self.assertEqual(polls.get_poll(db, self.wid, poll['id'])['status'], 'open')
            closed = polls.close_poll(db, self.wid, poll['id'], self.alice_id, self.now)
            self.assertEqual(closed['status'], 'closed')
            self.assertTrue(polls.delete_poll(db, self.wid, poll['id'], self.alice_id))
            self.assertIsNone(polls.get_poll(db, self.wid, poll['id']))
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM poll_options WHERE poll_id=?', (poll['id'],)).fetchone()[0], 0)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM poll_votes WHERE poll_id=?', (poll['id'],)).fetchone()[0], 0)

    def test_anonymous_hides_voters_but_keeps_counts_and_own_votes(self):
        poll = self.create(anonymous=True)
        yes, no = [item['id'] for item in poll['options']]
        self.vote(poll['id'], self.alice_id, [yes])
        self.vote(poll['id'], self.bob_id, [no])
        viewed = self.get(poll['id'], viewer_id=self.carol_id)
        self.assertEqual([item['count'] for item in viewed['options']], [1, 1])
        self.assertEqual(viewed['total'], 2)
        self.assertEqual([item['voters'] for item in viewed['options']], [[], []])
        self.assertNotIn(self.bob_id, repr(viewed))
        own = self.get(poll['id'], viewer_id=self.alice_id)
        self.assertEqual(own['votes'], [yes])
        public = self.create(anonymous=False, question='Public')
        public_yes = public['options'][0]['id']
        self.vote(public['id'], self.bob_id, [public_yes])
        visible = self.get(public['id'], viewer_id=self.alice_id)
        self.assertEqual(visible['options'][0]['voters'], [self.bob_id])

    def test_workspace_isolation(self):
        poll = self.create()
        other_wid = self.eve.workspace('eve-space', 'eve_request_0001')['body']['workspace']['id']
        eve_id = self._user_id(self.eve)
        option = poll['options'][0]['id']
        with self.app.store.connect() as db:
            self.assertIsNone(polls.get_poll(db, other_wid, poll['id']))
            self.assertEqual(polls.list_polls(db, other_wid, self.conversation, 10, None)['items'], [])
            with self.assertRaises(ValueError):
                polls.vote(db, other_wid, poll['id'], eve_id, [option], self.now)
            with self.assertRaises(ValueError):
                polls.close_poll(db, other_wid, poll['id'], eve_id, self.now)
            with self.assertRaises(ValueError):
                polls.delete_poll(db, other_wid, poll['id'], eve_id)
            self.assertIsNotNone(polls.get_poll(db, self.wid, poll['id']))

    def test_oversize_duplicate_and_too_few_options_are_rejected(self):
        with self.assertRaises(ValueError):
            self.create(question='x' * 501)
        with self.assertRaises(ValueError):
            self.create(options=('x' * 201, 'No'))
        with self.assertRaises(ValueError):
            self.create(options=('Only one',))
        with self.assertRaises(ValueError):
            self.create(options=tuple(f'Option {index}' for index in range(21)))
        with self.assertRaises(ValueError):
            self.create(options=('Yes', 'yes'))
        with self.assertRaises(ValueError):
            self.create(options=('Yes', '   '))
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM polls').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
