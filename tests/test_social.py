"""Human-to-human workspace messenger (issue #86). No agent or vendor is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class SocialMessengerTests(unittest.TestCase):
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
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.eve = Client(self.app, peer='127.0.0.4')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for client, username in ((self.bob, 'bob'), (self.carol, 'carol')):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                            {'username': username, 'role': 'member'})
        self.alice_id = self._user_id(self.alice)
        self.bob_id = self._user_id(self.bob)
        self.carol_id = self._user_id(self.carol)

    def _user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def base(self, workspace_id=None):
        return f'/v1/workspaces/{workspace_id or self.wid}/social/conversations'

    def create(self, client, kind, member_ids, title=None, key='social-create-0001'):
        body = {'kind': kind, 'member_ids': member_ids}
        if title is not None:
            body['title'] = title
        return client.call('POST', self.base(), body, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_direct_message_persists_both_ways_and_replays(self):
        created = self.create(self.alice, 'dm', [self.bob_id])
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['kind'], 'dm')
        self.assertEqual(conv['title'], 'bob')
        self.assertEqual({m['username'] for m in conv['members']}, {'alice', 'bob'})
        listed = self.bob.call('GET', self.base())
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['id'] for row in listed['body']['items']], [conv['id']])
        sent = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Bob'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['body'], '你好 Bob')
        self.assertEqual(sent['body']['message']['user_id'], self._user_id(self.alice))
        reply = self.bob.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Alice'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00002'})
        self.assertEqual(reply['status'], 201, reply)
        snapshot = self.bob.call('GET', self.base() + f'/{conv["id"]}')
        self.assertEqual(snapshot['status'], 200)
        self.assertEqual([m['body'] for m in snapshot['body']['items']], ['你好 Bob', '你好 Alice'])
        replay = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Bob'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['message']['id'], sent['body']['message']['id'])
        conflict = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '不同内容'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(conflict['status'], 409)
        second_dm = self.create(self.alice, 'dm', [self.bob_id], key='social-create-0009')
        self.assertEqual(second_dm['status'], 200)
        self.assertEqual(second_dm['body']['conversation']['id'], conv['id'])

    def test_group_conversation_and_isolation(self):
        created = self.create(self.bob, 'group', [self.alice_id, self.carol_id],
                              title='产品群', key='social-group-0001')
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['kind'], 'group')
        self.assertEqual(conv['title'], '产品群')
        self.assertEqual({m['username'] for m in conv['members']}, {'alice', 'bob', 'carol'})
        self.assertEqual(self.carol.call('GET', self.base() + f'/{conv["id"]}')['status'], 200)
        self.assertEqual(self.eve.call('GET', self.base() + f'/{conv["id"]}')['status'], 404)
        self.assertEqual(self.eve.call('GET', self.base())['status'], 404)
        self.assertEqual(self.eve.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '外人'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00003'})['status'], 404)
        outsider = self.create(self.alice, 'group', [self._user_id(self.eve)],
                               key='social-group-0002')
        self.assertEqual(outsider['status'], 400)

    def test_validation_and_cross_workspace(self):
        self.assertEqual(self.create(self.alice, 'channel', [self.bob_id])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id, self.carol_id])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [self.alice_id])['status'], 400)
        missing_key = self.alice.call('POST', self.base(), {'kind': 'dm', 'member_ids': [self.bob_id]})
        self.assertEqual(missing_key['status'], 400)
        other = self.bob.workspace('bob-space', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call('GET', self.base(other))['status'], 404)
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id])['status'], 201)
        # A DM is deduplicated per workspace even under a different idempotency key.
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id], key='social-create-0003')['status'], 200)

    def test_listing_preview_is_last_authorized_snippet(self):
        created = self.create(self.alice, 'dm', [self.bob_id], key='social-preview-0001')
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['preview'], '')
        empty = self.alice.call('GET', self.base())
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'][0]['preview'], '')
        self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '  第一句\n请看这里  '},
            {'HTTP_IDEMPOTENCY_KEY': 'social-preview-msg01'})
        mid = self.alice.call('GET', self.base())
        self.assertEqual(mid['body']['items'][0]['preview'], '第一句 请看这里')
        long_body = '预览' + ('很长的正文内容' * 30)
        self.bob.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': long_body},
            {'HTTP_IDEMPOTENCY_KEY': 'social-preview-msg02'})
        listed = self.alice.call('GET', self.base())
        self.assertEqual(listed['status'], 200)
        item = listed['body']['items'][0]
        self.assertEqual(item['id'], conv['id'])
        from openteamily.search import snippet
        self.assertEqual(item['preview'], snippet(long_body))
        self.assertLessEqual(len(item['preview']), 161)
        self.assertTrue(item['preview'].endswith('…'))
        self.assertNotIn(long_body, item['preview'])
        self.assertNotIn('body', item)
        snapshot = self.bob.call('GET', self.base() + f'/{conv["id"]}')
        self.assertEqual(snapshot['body']['conversation']['preview'], snippet(long_body))
        # A later conversation Eve cannot join should not appear in Eve's workspace list.
        self.assertEqual(self.eve.call('GET', self.base())['status'], 404)


if __name__ == '__main__':
    unittest.main()
