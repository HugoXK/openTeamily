"""Conversation replies finish through runtime infer tasks.

The fake OpenAI-compatible provider in this file is a local test fixture.
It is not a real model vendor, a live container, or a Teamily comparison.
No third-party messaging is performed.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider


class AgentChatInferTests(unittest.TestCase):
    """Labeled fake-provider tests for the existing infer task path."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.provider, self.provider_thread, self.seen = start_fake_provider(SECRET, 'hello from fake provider')
        self.addCleanup(lambda: (self.provider.shutdown(), self.provider_thread.join(3), self.provider.server_close()))
        self.base = 'http://127.0.0.1:%s/v1' % self.provider.server_address[1]
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True,
                                                                     runtime_heartbeat_seconds=45,
                                                                     runtime_task_timeout_seconds=30),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        saved = self.alice.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {'provider': 'openai', 'base_url': self.base, 'model': 'fake-model', 'api_key': SECRET},
        })
        self.assertEqual(saved['status'], 200, saved)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '摘要助手', 'summary': '', 'instructions': 'Keep answers to one sentence.'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-create-01'})
        self.assertEqual(created['status'], 201, created)
        self.agent = created['body']['agent']

    def conversations(self):
        return f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/conversations'

    def online_agent(self, client=None, name='desk'):
        client = client or self.alice
        token = client.call('POST', '/v1/runtime-keys', {'name': name})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': name})['status'], (200, 201))
        return token, agent

    def finish_infer(self, agent, task_id, text='hello from fake provider'):
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 200)
        access = agent.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        self.assertEqual(access['body']['model_api']['api_key'], SECRET)
        self.assertEqual(access['body']['model_api']['source'], 'account')
        done = agent.call('POST', f'/v1/agent/tasks/{task_id}/result',
                          {'status': 'succeeded', 'result': {'text': text, 'model': 'fake-model',
                                                            'source': access['body']['model_api']['source']}})
        self.assertEqual(done['status'], 200, done)
        return done

    def test_send_reuses_runtime_infer_and_reconciles_history(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '问答'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-conv-0001'})
        self.assertEqual(created['status'], 201, created)
        conv_id = created['body']['conversation']['id']
        token, agent = self.online_agent()
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '请用一句话问好。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-msg-0001'})
        self.assertEqual(sent['status'], 201, sent)
        reply = sent['body']['reply']
        self.assertEqual(reply['status'], 'queued')
        self.assertIsNone(reply['error_code'])
        task_id = reply['task_id']
        self.assertTrue(task_id)
        # The infer prompt is bound to the directory agent, not a second chat engine.
        claimed = agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})
        self.assertEqual(claimed['status'], 200, claimed)
        prompt = claimed['body']['task']['prompt']
        self.assertIn('You are 摘要助手.', prompt)
        self.assertIn('Keep answers to one sentence.', prompt)
        self.assertIn('User: 请用一句话问好。', prompt)
        access = agent.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        done = agent.call('POST', f'/v1/agent/tasks/{task_id}/result',
                          {'status': 'succeeded', 'result': {'text': '你好，我是摘要助手。', 'model': 'fake-model',
                                                            'source': access['body']['model_api']['source']}})
        self.assertEqual(done['status'], 200, done)
        mid = self.now + 5
        self.now = mid
        listed = self.alice.call('GET', self.conversations() + f'/{conv_id}/messages')
        self.assertEqual(listed['status'], 200, listed)
        items = listed['body']['items']
        self.assertEqual(items[-1]['id'], reply['id'])
        self.assertEqual(items[-1]['status'], 'succeeded')
        self.assertEqual(items[-1]['body'], '你好，我是摘要助手。')
        saved = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages/{reply["id"]}/artifact', {})
        self.assertEqual(saved['status'], 201, saved)
        self.assertEqual(saved['body']['artifact']['body'], '你好，我是摘要助手。')
        self.assertEqual(saved['body']['artifact']['source']['kind'], 'agent_message')
        # Bob's online connection cannot be used to finish Alice's conversation.
        bob_conv = self.bob.call(
            'POST', self.conversations(), {'title': 'bob的对话'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-conv-bob01'})
        self.assertEqual(bob_conv['status'], 201, bob_conv)
        bob_sent = self.bob.call(
            'POST', self.conversations() + f'/{bob_conv["body"]["conversation"]["id"]}/messages',
            {'body': 'hello from bob'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-msg-bob01'})
        self.assertEqual(bob_sent['status'], 201, bob_sent)
        self.assertEqual(bob_sent['body']['reply']['error_code'], 'no_agent')
        self.assertIsNone(bob_sent['body']['reply']['task_id'])

    def test_no_agent_retries_on_read_after_connect(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '稍后连接'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-conv-retry'})
        conv_id = created['body']['conversation']['id']
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '先离线发送'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-infer-msg-retry'})
        self.assertEqual(sent['body']['reply']['error_code'], 'no_agent')
        token, agent = self.online_agent()
        listed = self.alice.call('GET', self.conversations() + f'/{conv_id}')
        self.assertEqual(listed['status'], 200, listed)
        reply = [row for row in listed['body']['items'] if row['role'] == 'assistant'][0]
        self.assertIsNone(reply['error_code'])
        self.assertTrue(reply['task_id'])
        self.finish_infer(agent, reply['task_id'], '已在连接后回复。')
        self.now += 1
        again = self.alice.call('GET', self.conversations() + f'/{conv_id}/messages')
        self.assertEqual(again['body']['items'][-1]['status'], 'succeeded')
        self.assertEqual(again['body']['items'][-1]['body'], '已在连接后回复。')


if __name__ == '__main__':
    unittest.main()
