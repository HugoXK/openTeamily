"""Explicit group infer: real HTTP claim/access/result, labeled local fake provider.

Not a real vendor, Docker container, Teamily or Impeccable acceptance.
"""
import http.client
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from openteamily.store import Store
import threading
from urllib.parse import urlsplit
from wsgiref.simple_server import make_server
import unittest

from openteamily.server import QuietHandler
from tests.test_management import ORIGIN
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider
from tests import test_social as social_tests


class GroupAgentReplyTests(unittest.TestCase):
    setUp = social_tests.SocialMessengerTests.setUp
    _user_id = social_tests.SocialMessengerTests._user_id
    base = social_tests.SocialMessengerTests.base
    create = social_tests.SocialMessengerTests.create
    make_agent = social_tests.SocialMessengerTests.make_agent

    def group(self):
        self.aid = self.make_agent()
        created = self.alice.call('POST', self.base(), {
            'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': [self.aid]},
            {'HTTP_IDEMPOTENCY_KEY': 'reply-test-group-001'})
        self.assertEqual(created['status'], 201, created)
        self.cid = created['body']['conversation']['id']
        return self.base() + '/' + self.cid

    def trigger(self, path, key='group-reply-test-001', client=None, **changes):
        return (client or self.alice).call('POST', path + '/agent-replies',
            {'agent_id': self.aid, 'prompt': 'A clearly explicit request', **changes},
            {'HTTP_IDEMPOTENCY_KEY': key})

    def connect(self, client=None):
        token = (client or self.alice).call('POST', '/v1/runtime-keys', {'name': 'group-desk'})['body']['token']
        agent = AgentClient(self.app, token)
        result = agent.call('POST', '/v1/agent/connect', {'hostname': 'group-desk'})
        self.assertIn(result['status'], (200, 201), result)
        return agent

    def test_http_claim_model_access_result_persists_agent_message(self):
        path = self.group()
        provider, thread, seen = start_fake_provider(SECRET, '[FAKE PROVIDER] one group reply')
        self.addCleanup(lambda: (provider.shutdown(), thread.join(3), provider.server_close()))
        self.alice.call('POST', '/v1/model-api', {'revision': 0, 'changes': {
            'provider': 'openai', 'base_url': 'http://127.0.0.1:%s/v1' % provider.server_port,
            'model': 'fake-model', 'api_key': SECRET}})
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'group-http'})['body']['token']
        server = make_server('127.0.0.1', 0, self.app, handler_class=QuietHandler)
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        worker.start()
        self.addCleanup(lambda: (server.shutdown(), worker.join(3), server.server_close()))

        def runtime_http(path, body):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                conn.request('POST', path, json.dumps(body), {'Host': urlsplit(ORIGIN).netloc,
                             'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                response = conn.getresponse()
                return response.status, json.loads(response.read())
            finally:
                conn.close()

        self.assertIn(runtime_http('/v1/agent/connect', {'hostname': 'group-http'})[0], (200, 201))
        sent = self.trigger(path)
        self.assertEqual(sent['status'], 201, sent)
        reply = sent['body']['reply']
        self.assertEqual(reply['status'], 'queued')
        tid = reply['task_id']
        claim_status, claim = runtime_http(f'/v1/agent/tasks/{tid}/claim', {})
        self.assertEqual(claim_status, 200, claim)
        self.assertIn('You are Group helper.', claim['task']['prompt'])
        running = self.bob.call('GET', path)
        self.assertEqual(running['body']['agent_replies'][0]['status'], 'running')
        self.assertEqual(self.trigger(path, key='group-reply-conflict')['status'], 409)
        code, access = runtime_http(f'/v1/agent/tasks/{tid}/model-access', {})
        self.assertEqual(code, 200, access)
        self.assertEqual(access['model_api']['source'], 'account')
        self.assertEqual(runtime_http(f'/v1/agent/tasks/{tid}/model-access', {})[0], 409)
        # A separate runtime-client process calls only the local fake provider.
        inference = subprocess.run([sys.executable, '-c',
            'import json,sys; from openteamily.flybot import infer_chat; '
            'p=json.load(sys.stdin); print(infer_chat(p["model_api"],p["prompt"]))'],
            input=json.dumps({'model_api': access['model_api'], 'prompt': claim['task']['prompt']}),
            text=True, capture_output=True, timeout=10, check=True)
        text = inference.stdout.strip()
        self.assertEqual(seen['count'], 1)
        code, done = runtime_http(f'/v1/agent/tasks/{tid}/result', {
            'status': 'succeeded', 'result': {'text': text, 'source': 'account', 'model': 'fake-model'}})
        self.assertEqual(code, 200, done)
        for _ in range(2):
            snapshot = self.bob.call('GET', path)
            self.assertEqual(snapshot['body']['agent_replies'][0]['status'], 'succeeded')
            self.assertEqual(len(snapshot['body']['items']), 1)
            msg = snapshot['body']['items'][0]
            self.assertEqual(msg['id'], reply['id'])
            self.assertEqual(msg['role'], 'agent')
            self.assertEqual(msg['agent_id'], self.aid)
            self.assertIsNone(msg['user_id'])
            self.assertEqual(msg['body'], '[FAKE PROVIDER] one group reply')
            self.assertNotIn(SECRET, json.dumps(snapshot))
        self.assertEqual(self.bob.call('GET', self.base())['body']['items'][0]['preview'], text)
        replay = self.trigger(path)
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['reply']['id'], reply['id'])
        self.assertEqual(seen['count'], 1)
        self.assertEqual(self.trigger(path, prompt='different')['status'], 409)
        # Human messages use the shared sequence and paging after an agent reply works.
        self.alice.call('POST', path + '/messages', {'body': 'Thanks'},
                        {'HTTP_IDEMPOTENCY_KEY': 'group-reply-human-01'})
        page = self.bob.call('GET', path + '/messages?cursor=' + reply['id'])
        self.assertEqual([m['body'] for m in page['body']['items']], ['Thanks'])
        listed = self.bob.call('GET', self.base())
        self.assertEqual(listed['body']['items'][0]['preview'], 'Thanks')

    def test_isolation_authorization_and_no_automatic_requests(self):
        path = self.group()
        self.assertEqual(self.trigger(path, client=self.carol)['status'], 404)  # workspace member, not group
        self.assertEqual(self.trigger(path, client=self.eve)['status'], 404)
        foreign_wid = self.eve.workspace()['body']['workspace']['id']
        foreign_agent = self.make_agent(self.eve, foreign_wid)
        self.assertEqual(self.trigger(path, agent_id=foreign_agent)['status'], 400)
        uninvited = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents', {'name': 'Not invited'},
            {'HTTP_IDEMPOTENCY_KEY': 'uninvited-agent-test1'})['body']['agent']['id']
        self.assertEqual(self.trigger(path, agent_id=uninvited)['status'], 400)
        self.assertEqual(self.trigger(path, prompt='')['status'], 400)
        self.assertEqual(self.trigger(path, key='short')['status'], 400)
        csrf = self.alice.call('POST', path + '/agent-replies', {'agent_id': self.aid, 'prompt': 'x'},
                              {'HTTP_X_CSRF_TOKEN': ''})
        self.assertEqual(csrf['status'], 403)
        self.alice.call('POST', path + '/messages', {'body': 'Human text must not run a model'},
                        {'HTTP_IDEMPOTENCY_KEY': 'group-no-automatic1'})
        self.assertEqual(self.alice.call('GET', path)['body']['agent_replies'], [])
        dm = self.create(self.alice, 'dm', [self.bob_id], key='group-reply-dm-test')['body']['conversation']
        self.assertEqual(self.trigger(self.base() + '/' + dm['id'])['status'], 400)
        offline = self.trigger(path)
        self.assertEqual(offline['body']['reply']['status'], 'failed')
        self.assertEqual(offline['body']['reply']['error_code'], 'no_agent')
        self.connect()
        # Reads never redispatch a no-runtime failure; only an explicit new request may retry.
        self.assertEqual(self.alice.call('GET', path)['body']['agent_replies'][0]['status'], 'failed')
        sent = self.trigger(path, key='group-reply-online1')
        self.assertEqual(sent['body']['reply']['status'], 'queued')
        other = self.connect(self.bob)
        tid = sent['body']['reply']['task_id']
        self.assertEqual(other.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 404)
        self.assertEqual(other.call('POST', f'/v1/agent/tasks/{tid}/result',
                                   {'status': 'succeeded', 'result': {'text': 'forged'}})['status'], 404)

    def test_timeout_failure_and_empty_success_are_not_fake_replies(self):
        path = self.group()
        agent = self.connect()
        for index, mode in enumerate(['timeout', 'failure', 'empty']):
            sent = self.trigger(path, key='group-error-test-%03d' % index)
            tid = sent['body']['reply']['task_id']
            self.assertTrue(tid)
            agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
            if mode == 'timeout':
                self.now += self.app.config.runtime_task_timeout_seconds + 1
            else:
                result = {'status': 'failed', 'result': {'error': 'private-runtime-diagnostic'}} if mode == 'failure' else {
                    'status': 'succeeded', 'result': {'text': ''}}
                done = agent.call('POST', f'/v1/agent/tasks/{tid}/result', result)
                self.assertEqual(done['status'], 200, done)
            snapshot = self.alice.call('GET', path)
            reply = next(item for item in snapshot['body']['agent_replies'] if item['id'] == sent['body']['reply']['id'])
            self.assertEqual(reply['status'], 'failed')
            self.assertEqual(reply['error_code'], {'timeout': 'timeout', 'failure': 'runtime_failed', 'empty': 'empty_reply'}[mode])
            self.assertEqual(snapshot['body']['items'], [])
            self.assertNotIn('private-runtime-diagnostic', json.dumps(snapshot))
            agent.call('POST', '/v1/agent/connect', {'hostname': 'group-desk'})

    def test_additive_upgrade_archive_and_capacity(self):
        path = self.group()
        with self.app.store.connect() as db:
            db.execute('DROP TABLE social_agent_replies')
            db.commit()
        Store(Path(self.temp.name) / 'state')
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.app.config = replace(self.app.config, max_social_messages_per_conversation=1)
        first = self.trigger(path)
        self.assertEqual(first['body']['reply']['error_code'], 'no_agent')
        self.assertEqual(self.trigger(path, key='group-reply-quota02')['status'], 429)
        self.app.config = replace(self.app.config, max_social_messages_per_conversation=500)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{self.aid}/archive', {'revision': 1})
        self.assertEqual(self.trigger(path, key='group-reply-archived')['status'], 400)
