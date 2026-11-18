"""Multi-agent group reply requests (issue #158). In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class GroupAgentBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.a1 = self._agent('一号')
        self.a2 = self._agent('二号')
        self.a3 = self._agent('三号')
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'group', 'member_ids': [bob_id], 'title': '项目群',
             'agent_ids': [self.a1, self.a2]},
            {'HTTP_IDEMPOTENCY_KEY': 'batch-group-0001'})
        self.assertEqual(created['status'], 201, created)
        self.cid = created['body']['conversation']['id']

    def _agent(self, name):
        created = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents', {'name': name},
                                  {'HTTP_IDEMPOTENCY_KEY': 'batch-agent-' + name.encode().hex()[:24]})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']['id']

    def conv(self):
        return f'/v1/workspaces/{self.wid}/social/conversations/{self.cid}'

    def request_reply(self, body, key='batch-reply-0001', client=None, csrf=True):
        return (client or self.alice).call('POST', self.conv() + '/agent-replies', body,
                                           {'HTTP_IDEMPOTENCY_KEY': key}, csrf=csrf)

    def test_batch_creates_one_reply_per_agent_and_replays(self):
        sent = self.request_reply({'agent_ids': [self.a1, self.a2], 'prompt': '各说一句。'})
        self.assertEqual(sent['status'], 201, sent)
        replies = sent['body']['replies']
        self.assertEqual(len(replies), 2)
        self.assertEqual({item['agent_id'] for item in replies}, {self.a1, self.a2})
        for item in replies:
            self.assertEqual(item['status'], 'failed')
            self.assertEqual(item['error_code'], 'no_agent')
        replay = self.request_reply({'agent_ids': [self.a1, self.a2], 'prompt': '各说一句。'})
        self.assertEqual(replay['status'], 200, replay)
        self.assertEqual([item['id'] for item in replay['body']['replies']],
                         [item['id'] for item in replies])
        conflict = self.request_reply({'agent_ids': [self.a1, self.a2], 'prompt': '不同内容'})
        self.assertEqual(conflict['status'], 409)

    def test_single_agent_compat_and_validation(self):
        single = self.request_reply({'agent_id': self.a1, 'prompt': '你好。'}, key='batch-reply-single1')
        self.assertEqual(single['status'], 201, single)
        self.assertEqual(single['body']['reply']['agent_id'], self.a1)
        self.assertEqual(self.request_reply({'agent_ids': [self.a3], 'prompt': '未加入'})['status'], 400)
        self.assertEqual(self.request_reply({'agent_ids': [self.a1] * 2, 'prompt': '重复'})['status'], 400)
        self.assertEqual(self.request_reply({'agent_ids': [self.a1, self.a2, self.a3, self.a1], 'prompt': 'x'})['status'], 400)
        self.assertEqual(self.request_reply({'agent_ids': [], 'prompt': 'x'})['status'], 400)
        self.assertEqual(self.request_reply({'agent_ids': [self.a1], 'prompt': 'x'}, csrf=False)['status'], 403)
        self.assertEqual(self.eve.call('GET', self.conv())['status'], 404)
        self.assertEqual(self.eve.call('POST', self.conv() + '/agent-replies',
                                       {'agent_ids': [self.a1], 'prompt': 'x'},
                                       {'HTTP_IDEMPOTENCY_KEY': 'batch-reply-eve001'})['status'], 404)

    def test_roster_edit_api_still_works(self):
        added = self.alice.call('POST', self.conv() + '/agents', {'agent_ids': [self.a3]})
        self.assertEqual(added['status'], 200, added)
        names = [item['name'] for item in added['body']['conversation']['agent_members']]
        self.assertIn('三号', names)
        removed = self.alice.call('POST', self.conv() + f'/agents/{self.a3}/remove', {})
        self.assertEqual(removed['status'], 200, removed)
        names = [item['name'] for item in removed['body']['conversation']['agent_members']]
        self.assertNotIn('三号', names)
        self.assertEqual(self.bob.call('POST', self.conv() + '/agents', {'agent_ids': [self.a3]})['status'], 403)


if __name__ == '__main__':
    unittest.main()
