"""Workspace memory preferences persist per user and workspace. In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryPreferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def add(self, client=None, text='回复用中文', key='preference-create-0001'):
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/memory/preferences', {'text': text},
            {'HTTP_IDEMPOTENCY_KEY': key})

    def test_add_read_remove_round_trip_survives_a_new_session(self):
        empty = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/preferences')
        self.assertEqual(empty['status'], 200, empty)
        self.assertEqual(empty['body']['items'], [])
        created = self.add()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['preference']
        self.assertEqual(item['text'], '回复用中文')
        self.assertTrue(item['id'])
        # A fresh login is the "refresh / new conversation" case: the row must
        # come back from the store, not from page state.
        fresh = Client(self.app, peer='127.0.0.3')
        fresh.call('POST', '/v1/auth/login', {'username': 'alice', 'password': 'Synthetic test passphrase #2026'})
        listed = fresh.call('GET', f'/v1/workspaces/{self.wid}/memory/preferences')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['text'] for row in listed['body']['items']], ['回复用中文'])
        removed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/preferences/{item["id"]}/remove', {})
        self.assertEqual(removed['status'], 200, removed)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/preferences')['body']['items'], [])

    def test_duplicate_text_reuses_the_same_row(self):
        first = self.add(key='preference-create-0001')
        second = self.add(key='preference-create-0002')
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(second['status'], 200, second)
        self.assertEqual(second['body']['preference']['id'], first['body']['preference']['id'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/preferences')
        self.assertEqual(len(listed['body']['items']), 1)
        # Case and surrounding whitespace are folded, so it is not a second row.
        third = self.add(text='  回复用中文  ', key='preference-create-0003')
        self.assertEqual(third['status'], 200, third)
        self.assertEqual(len(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/preferences')['body']['items']), 1)

    def test_preferences_are_private_per_user_and_workspace(self):
        self.add()
        self.assertEqual(self.bob.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/preferences')['body']['items'], [])
        other = self.alice.workspace(name='另一个工作区', key='request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{other}/memory/preferences')['body']['items'], [])

    def test_invalid_text_and_missing_key_are_refused(self):
        for body in ({'text': ''}, {'text': '   '}, {'text': 'x' * 121}, {'text': 7}, {}):
            refused = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/preferences', body,
                                      {'HTTP_IDEMPOTENCY_KEY': 'preference-create-0009'})
            self.assertEqual(refused['status'], 400, (body, refused))
        no_key = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/preferences', {'text': '中文'})
        self.assertEqual(no_key['status'], 400, no_key)

    def test_unknown_workspace_and_preference_are_404(self):
        missing_workspace = self.alice.call('GET', '/v1/workspaces/' + '0' * 32 + '/memory/preferences')
        self.assertEqual(missing_workspace['status'], 404, missing_workspace)
        missing_id = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/preferences/' + '0' * 32 + '/remove', {})
        self.assertEqual(missing_id['status'], 404, missing_id)


if __name__ == '__main__':
    unittest.main()
