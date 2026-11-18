"""Agent replies in social groups (issue #89, speaking slice).

The fake OpenAI-compatible provider is a local test fixture, not a real vendor,
a live container or a Teamily comparison.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider


class SocialAgentReplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.provider, self.provider_thread, self.seen = start_fake_provider(SECRET, '来自假模型的回复')
        self.addCleanup(lambda: (self.provider.shutdown(), self.provider_thread.join(3),
                                 self.provider.server_close()))
        self.base = 'http://127.0.0.1:%s/v1' % self.provider.server_address[1]
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.alice.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {'provider': 'openai', 'base_url': self.base, 'model': 'fake-model', 'api_key': SECRET},
        })
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.agent = self._agent('摘要助手')
        group = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'group', 'member_ids': [self.bob_id], 'title': '项目群',
             'agent_ids': [self.agent['id']]},
            {'HTTP_IDEMPOTENCY_KEY': 'social-reply-group-01'})
        self.assertEqual(group['status'], 201, group)
        self.cid = group['body']['conversation']['id']

    def _agent(self, name):
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': name, 'summary': '', 'instructions': 'Keep answers to one sentence.'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-reply-' + name.encode().hex()[:24]})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def conv(self):
        return f'/v1/workspaces/{self.wid}/social/conversations/{self.cid}'

    def send(self, text, agent_ids, key='social-reply-msg-0001', client=None):
        body = {'body': text}
        if agent_ids:
            body['agent_ids'] = agent_ids
        return (client or self.alice).call(
            'POST', self.conv() + '/messages', body, {'HTTP_IDEMPOTENCY_KEY': key})

    def online(self, name='desk'):
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': name})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': name})['status'], (200, 201))
        return agent

    def test_no_agent_queue_merge_and_replay(self):
        sent = self.send('@摘要助手 用一句话问好。', [self.agent['id']])
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['body'], '@摘要助手 用一句话问好。')
        reply = sent['body']['agents'][0]
        self.assertEqual(reply['author_type'], 'agent')
        self.assertEqual(reply['agent_name'], '摘要助手')
        self.assertEqual(reply['status'], 'queued')
        self.assertEqual(reply['error_code'], 'no_agent')
        snapshot = self.alice.call('GET', self.conv())
        self.assertEqual([item['author_type'] for item in snapshot['body']['items']], ['user', 'agent'])
        self.assertEqual(snapshot['body']['conversation']['agent_members'][0]['name'], '摘要助手')
        replay = self.send('@摘要助手 用一句话问好。', [self.agent['id']])
        self.assertEqual(replay['status'], 200, replay)
        self.assertEqual(replay['body']['agents'][0]['id'], reply['id'])
        conflict = self.send('不同内容', [self.agent['id']])
        self.assertEqual(conflict['status'], 409)
        other = self._agent('另一个')
        self.assertEqual(self.send('未加入的智能体', [other['id']], key='social-reply-msg-0002')['status'], 400)
        self.assertEqual(self.eve.call('GET', self.conv())['status'], 404)

    def test_runtime_reply_reconciles_and_history_is_bound(self):
        agent = self.online()
        sent = self.send('请回复一句话。', [self.agent['id']])
        self.assertEqual(sent['status'], 201, sent)
        tasks = agent.call('GET', '/v1/agent/tasks')
        self.assertEqual(tasks['status'], 200, tasks)
        queued = tasks['body']['items']
        self.assertEqual(len(queued), 1)
        task = queued[0]
        self.assertIn('You are 摘要助手.', task['prompt'])
        self.assertIn('Keep answers to one sentence.', task['prompt'])
        self.assertIn('User: 请回复一句话。', task['prompt'])
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task["id"]}/claim', {})['status'], 200)
        access = agent.call('POST', f'/v1/agent/tasks/{task["id"]}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task["id"]}/result', {
            'status': 'succeeded',
            'result': {'text': '你好，我在。', 'model': 'fake-model',
                       'source': access['body']['model_api']['source']},
        })['status'], 200)
        self.now += 5
        snapshot = self.alice.call('GET', self.conv())
        self.assertEqual(snapshot['status'], 200, snapshot)
        last = snapshot['body']['items'][-1]
        self.assertEqual(last['author_type'], 'agent')
        self.assertEqual(last['status'], 'succeeded')
        self.assertEqual(last['body'], '你好，我在。')

    def test_dm_and_missing_agent_validation(self):
        self.assertEqual(self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'dm', 'member_ids': [self.bob_id], 'agent_ids': [self.agent['id']]},
            {'HTTP_IDEMPOTENCY_KEY': 'social-reply-dm-0001'})['status'], 400)
        self.assertEqual(self.send('x', ['nope'], key='social-reply-msg-0003')['status'], 400)
        self.assertEqual(self.send('x', ['a' * 32], key='social-reply-msg-0004')['status'], 400)


if __name__ == '__main__':
    unittest.main()
