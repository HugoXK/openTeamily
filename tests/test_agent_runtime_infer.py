"""Conversation dispatch through a bound instance connection.

The fake OpenAI-compatible provider in this file is a local test fixture.
It is not a real model vendor, a live Docker inference pass, or a Teamily
comparison. No third-party messaging is performed.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity
from openteamily.security import digest, opaque
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider


class AgentRuntimeInferTests(unittest.TestCase):
    """Labeled fake-provider tests for instance-bound infer dispatch."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.provider, self.provider_thread, self.seen = start_fake_provider(SECRET, 'hello from fake provider')
        self.addCleanup(lambda: (self.provider.shutdown(), self.provider_thread.join(3), self.provider.server_close()))
        self.base = 'http://127.0.0.1:%s/v1' % self.provider.server_address[1]
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, clock=lambda: self.now)
        self.app = App(self.store, Config(ORIGIN, allow_registration=True,
                                          runtime_heartbeat_seconds=45,
                                          runtime_task_timeout_seconds=30),
                       clock=lambda: self.now, lifecycle=self.runtime)
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
            {'name': '共享助手', 'summary': '', 'instructions': 'Keep answers to one sentence.'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-create-01'})
        self.assertEqual(created['status'], 201, created)
        self.agent = created['body']['agent']
        inst = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/instances', {},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-inst-0001'})
        self.assertEqual(inst['status'], 201, inst)
        self.iid = inst['body']['instance']['id']
        self.token = opaque()
        self.app.manager_auth = ManagerAuth([
            ManagerIdentity('manager-a', digest(self.token), frozenset([self.iid]), 'simulation')])

    def manager_call(self, method, path, body=None):
        return Client(self.app).call(
            method, path, body,
            {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + self.token},
            origin=None, csrf=False)

    def conversations(self):
        return f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/conversations'

    def finish_job(self, observed, process_ref=None, issue=False):
        claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': self.iid})
        self.assertEqual(claim['status'], 200, claim)
        body = claim['body']['claim']
        issued = None
        if issue:
            issued = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', {
                'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
                'lease': body['lease']})
            self.assertEqual(issued['status'], 200, issued)
        payload = {'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
                   'lease': body['lease'], 'observed': observed}
        if process_ref:
            payload['process_ref'] = process_ref
        observed_row = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/observe', payload)
        self.assertEqual(observed_row['status'], 200, observed_row)
        return issued['body']['runtime_key'] if issued else None, body

    def start_instance(self):
        key, _ = self.finish_job('stopped')
        self.assertIsNone(key)
        self.assertEqual(self.alice.call('POST', f'/v1/instances/{self.iid}/start', {})['status'], 202)
        return self.finish_job('running', process_ref='b' * 32, issue=True)[0]

    def online_personal(self, client=None, name='laptop'):
        client = client or self.alice
        token = client.call('POST', '/v1/runtime-keys', {'name': name})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': name})['status'], (200, 201))
        return token, agent

    def test_member_send_uses_bound_instance_and_falls_back_to_own_machine(self):
        key = self.start_instance()
        bound = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/runtime',
            {'instance_id': self.iid})
        self.assertEqual(bound['status'], 201, bound)
        container = AgentClient(self.app, key['token'])
        connected = container.call('POST', '/v1/agent/connect', {'hostname': key['hostname']})
        self.assertIn(connected['status'], (200, 201), connected)
        created = self.bob.call(
            'POST', self.conversations(), {'title': '共享对话'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-conv-0001'})
        self.assertEqual(created['status'], 201, created)
        conv_id = created['body']['conversation']['id']
        sent = self.bob.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '请用一句话问好。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-msg-0001'})
        self.assertEqual(sent['status'], 201, sent)
        reply = sent['body']['reply']
        self.assertEqual(reply['dispatch']['source'], 'instance')
        self.assertEqual(reply['dispatch']['instance_id'], self.iid)
        self.assertEqual(reply['status'], 'queued')
        task_id = reply['task_id']
        claimed = container.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})
        self.assertEqual(claimed['status'], 200, claimed)
        self.assertIn('You are 共享助手.', claimed['body']['task']['prompt'])
        access = container.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        self.assertEqual(access['body']['model_api']['api_key'], SECRET)
        done = container.call('POST', f'/v1/agent/tasks/{task_id}/result',
                              {'status': 'succeeded', 'result': {'text': '你好，我是共享助手。',
                                                                'model': 'fake-model',
                                                                'source': access['body']['model_api']['source']}})
        self.assertEqual(done['status'], 200, done)
        self.now += 1
        listed = self.bob.call('GET', self.conversations() + f'/{conv_id}/messages')
        self.assertEqual(listed['body']['items'][-1]['body'], '你好，我是共享助手。')
        # Fallback: stop the instance (unavailable) and use Alice's laptop.
        self.assertEqual(self.alice.call('POST', f'/v1/instances/{self.iid}/stop', {})['status'], 202)
        self.finish_job('stopped')
        token, laptop = self.online_personal()
        alice_conv = self.alice.call(
            'POST', self.conversations(), {'title': '本机回退'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-conv-fb01'})
        alice_id = alice_conv['body']['conversation']['id']
        fallback = self.alice.call(
            'POST', self.conversations() + f'/{alice_id}/messages',
            {'body': '用本机回答。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-msg-fb01'})
        self.assertEqual(fallback['status'], 201, fallback)
        self.assertEqual(fallback['body']['reply']['dispatch']['source'], 'connection')
        self.assertNotIn('instance_id', fallback['body']['reply']['dispatch'])
        # Bob has no personal connection and the instance is down.
        bob_wait = self.bob.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '还在吗？'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-msg-na01'})
        self.assertEqual(bob_wait['status'], 201, bob_wait)
        self.assertEqual(bob_wait['body']['reply']['error_code'], 'no_agent')
        self.assertIsNone(bob_wait['body']['reply']['task_id'])

    def test_restart_rotates_the_key_and_redelivers_queued_work(self):
        key = self.start_instance()
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/runtime',
            {'instance_id': self.iid})
        first = AgentClient(self.app, key['token'])
        self.assertIn(first.call('POST', '/v1/agent/connect', {'hostname': key['hostname']})['status'], (200, 201))
        created = self.alice.call(
            'POST', self.conversations(), {'title': '重启恢复'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-conv-rs01'})
        conv_id = created['body']['conversation']['id']
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '先排队。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-rt-infer-msg-rs01'})
        old_task = sent['body']['reply']['task_id']
        self.assertTrue(old_task)
        self.assertEqual(self.alice.call('POST', f'/v1/instances/{self.iid}/restart',
                                         {'operation_id': 'restart-agent-key-0001'})['status'], 202)
        rotated, _ = self.finish_job('running', process_ref='c' * 32, issue=True)
        self.assertNotEqual(rotated['token'], key['token'])
        denied = first.call('POST', '/v1/agent/heartbeat', {})
        self.assertIn(denied['status'], (401, 403, 404))
        second = AgentClient(self.app, rotated['token'])
        self.assertIn(second.call('POST', '/v1/agent/connect', {'hostname': rotated['hostname']})['status'], (200, 201))
        listed = self.alice.call('GET', self.conversations() + f'/{conv_id}')
        reply = [row for row in listed['body']['items'] if row['role'] == 'assistant'][0]
        self.assertNotEqual(reply['task_id'], old_task)
        self.assertEqual(reply['dispatch']['source'], 'instance')
        claimed = second.call('POST', f'/v1/agent/tasks/{reply["task_id"]}/claim', {})
        self.assertEqual(claimed['status'], 200, claimed)


if __name__ == '__main__':
    unittest.main()
