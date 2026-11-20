"""Message send mode (Auto / Instant / Agentic) is stored with the message.

The composer used to show a disabled "Instant" button: the chosen mode never
left the browser. This pins the smallest real contract: the mode travels in the
send request, one row records it, and every later read returns it.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class SocialMessageModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']

    def base(self):
        return f'/v1/workspaces/{self.wid}/social/conversations'

    def conversation(self):
        created = self.alice.call(
            'POST', self.base(), {'kind': 'dm', 'member_ids': [self.bob_id]},
            {'HTTP_IDEMPOTENCY_KEY': 'social-mode-create-0001'})
        self.assertEqual(created['status'], 201, created)
        return created['body']['conversation']['id']

    def send(self, conversation_id, body, key):
        return self.alice.call(
            'POST', self.base() + f'/{conversation_id}/messages', body,
            {'HTTP_IDEMPOTENCY_KEY': key})

    def test_agentic_mode_is_stored_and_survives_a_reload(self):
        cid = self.conversation()
        sent = self.send(cid, {'body': '整理这周的发布计划', 'mode': 'agentic'}, 'social-mode-msg-0001')
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['mode'], 'agentic')
        listed = self.bob.call('GET', self.base() + f'/{cid}/messages')
        self.assertEqual(listed['status'], 200)
        rows = [row for row in listed['body']['items'] if row['id'] == sent['body']['message']['id']]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['mode'], 'agentic')
        self.assertEqual(rows[0]['body'], '整理这周的发布计划')

    def test_missing_mode_defaults_to_auto(self):
        cid = self.conversation()
        sent = self.send(cid, {'body': '普通消息'}, 'social-mode-msg-0002')
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['mode'], 'auto')

    def test_unknown_mode_is_rejected_and_nothing_is_stored(self):
        cid = self.conversation()
        sent = self.send(cid, {'body': '不要存下来', 'mode': 'turbo'}, 'social-mode-msg-0003')
        self.assertEqual(sent['status'], 400, sent)
        self.assertEqual(sent['body']['error']['code'], 'invalid')
        listed = self.alice.call('GET', self.base() + f'/{cid}/messages')
        self.assertEqual(listed['body']['items'], [])


if __name__ == '__main__':
    unittest.main()
