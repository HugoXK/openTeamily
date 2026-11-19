"""Automations execute through connected agents. Fake provider is not a real vendor."""
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from wsgiref.simple_server import make_server

from openteamily.app import App, Config
from openteamily.flybot import main as flybot_main
from openteamily.scheduler import AgentAutomationBackend, BackgroundWorker, Scheduler
from openteamily.server import QuietHandler
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider

NOW = 1800000000
DAILY = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
IMMEDIATE = {'kind': 'now', 'time_zone': 'Asia/Shanghai'}


class AutomationExecuteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = NOW
        self.provider, self.provider_thread, self.seen = start_fake_provider(SECRET, 'brief from fake provider')
        self.addCleanup(lambda: (self.provider.shutdown(), self.provider_thread.join(3), self.provider.server_close()))
        self.base = 'http://127.0.0.1:%s/v1' % self.provider.server_address[1]
        self.path = Path(self.temp.name) / 'state'
        self.store = Store(self.path)
        self.app = App(self.store, Config('https://management.test', allow_registration=True,
                                          runtime_heartbeat_seconds=45, runtime_task_timeout_seconds=30),
                       clock=lambda: self.now)
        self.assertIsInstance(self.app.automation_backend, AgentAutomationBackend)
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

    def create(self, enabled=True, schedule=None, title='Morning briefing', prompt='Summarize overnight activity.', **fields):
        body = {'title': title, 'prompt': prompt, 'template_id': 'custom',
                'schedule': schedule or IMMEDIATE, 'participants': ['alice'], **fields}
        created = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations', body,
                                  {'HTTP_IDEMPOTENCY_KEY': 'auto-exec-' + ''.join(ch if ch.isalnum() else '-' for ch in title)[:40].ljust(16, 'x')})
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['automation']['id']
        if enabled:
            saved = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                                    {'revision': 1, 'changes': {'enabled': True}})
            self.assertEqual(saved['status'], 200, saved)
        return aid

    def online_agent(self, client=None, name='desk'):
        client = client or self.alice
        token = client.call('POST', '/v1/runtime-keys', {'name': name})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': name})['status'], (200, 201))
        return token, agent

    def tick(self, client=None, **kw):
        return (client or self.alice).call('POST', f'/v1/workspaces/{self.wid}/automations/tick', {}, **kw)

    def runs(self, aid, client=None):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')

    def finish_infer(self, agent, task_id, text='brief from fake provider'):
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 200)
        access = agent.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        self.assertEqual(access['body']['model_api']['api_key'], SECRET)
        done = agent.call('POST', f'/v1/agent/tasks/{task_id}/result',
                          {'status': 'succeeded', 'result': {'text': text, 'model': 'fake-model',
                                                            'source': access['body']['model_api']['source']}})
        self.assertEqual(done['status'], 200, done)
        return done

    def test_run_list_filters_by_stored_status(self):
        aid = self.create()
        self.tick()
        token, agent = self.online_agent()
        assigned = self.tick()
        task_id = assigned['body']['items'][0]['dispatch']['task_id']
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 200)
        failed_result = agent.call('POST', f'/v1/agent/tasks/{task_id}/result', {'status': 'failed', 'result': {'error': 'boom'}})
        self.assertEqual(failed_result['status'], 200, failed_result)
        url = f'/v1/workspaces/{self.wid}/automations/{aid}/runs'
        failed = self.alice.call('GET', url + '?status=failed')
        self.assertEqual(failed['status'], 200, failed)
        self.assertEqual([item['status'] for item in failed['body']['items']], ['failed'], failed['body'])
        succeeded = self.alice.call('GET', url + '?status=succeeded')
        self.assertEqual(succeeded['status'], 200, succeeded)
        self.assertEqual(succeeded['body']['items'], [])
        queued = self.alice.call('GET', url + '?status=queued')
        self.assertEqual(queued['status'], 200, queued)
        self.assertEqual(queued['body']['items'], [])
        every = self.alice.call('GET', url + '?limit=20')
        self.assertEqual(every['status'], 200, every)
        self.assertEqual(len(every['body']['items']), 1)
        bogus = self.alice.call('GET', url + '?status=bogus')
        self.assertEqual(bogus['status'], 400, bogus)

    def test_no_agent_stays_queued_and_retries_when_connected(self):
        aid = self.create()
        first = self.tick()
        self.assertEqual(first['status'], 200, first)
        self.assertEqual(len(first['body']['items']), 1)
        run = first['body']['items'][0]
        self.assertEqual(run['status'], 'queued')
        self.assertEqual(run['error_code'], 'no_agent')
        self.assertNotIn('task_id', run['dispatch'])
        again = self.tick()
        self.assertEqual(again['body']['items'][0]['id'], run['id'])
        self.assertEqual(again['body']['items'][0]['error_code'], 'no_agent')
        token, agent = self.online_agent()
        assigned = self.tick()
        self.assertEqual(assigned['body']['items'][0]['id'], run['id'])
        self.assertEqual(assigned['body']['items'][0]['error_code'], None)
        task_id = assigned['body']['items'][0]['dispatch']['task_id']
        self.finish_infer(agent, task_id)
        listed = self.runs(aid)
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['status'], 'succeeded')
        self.assertEqual(listed['body']['items'][0]['result']['text'], 'brief from fake provider')
        blob = json.dumps(listed['body'])
        self.assertNotIn(SECRET, blob)
        self.assertNotIn('api_key', blob)
        dumped = (self.path / 'management.sqlite3').read_bytes()
        self.assertNotIn(SECRET.encode(), dumped)
        self.assertEqual(self.tick()['body']['items'], [])

    def test_permission_cancel_timeout_and_isolation(self):
        token, agent = self.online_agent()
        aid = self.create()
        fired = self.tick()
        run = fired['body']['items'][0]
        run_id = run['id']
        task_id = run['dispatch']['task_id']
        self.assertEqual(self.bob.call('POST', f'/v1/workspaces/{self.wid}/automations/tick', {})['status'], 403)
        self.assertEqual(self.runs(aid, self.bob)['status'], 200)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/cancel', {})['status'],
            403,
        )
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')['status'], 404)
        self.assertEqual(
            outsider.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/cancel', {})['status'],
            404,
        )
        cancelled = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/cancel', {})
        self.assertEqual(cancelled['status'], 200, cancelled)
        self.assertEqual(cancelled['body']['run']['status'], 'cancelled')
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 409)
        # timeout on a fresh run: use a unique title/idempotency by new automation with daily due slot after now
        aid2 = self.create(title='Timeout check', schedule=DAILY)
        queued = self.tick()
        self.assertEqual(queued['body']['items'][0]['status'], 'queued')
        self.now += 31
        listed = self.runs(aid2)
        self.assertEqual(listed['body']['items'][0]['status'], 'timeout')
        self.assertEqual(listed['body']['items'][0]['error_code'], 'timeout')

    def test_csrf_required_for_tick_and_cancel(self):
        _, agent = self.online_agent()
        aid = self.create()
        self.assertEqual(self.tick(csrf=False)['status'], 403)
        self.assertEqual(self.tick(origin='https://evil.test')['status'], 403)
        run = self.tick()['body']['items'][0]
        self.assertEqual(
            self.alice.call(
                'POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run["id"]}/cancel', {}, csrf=False
            )['status'],
            403,
        )
        self.assertEqual(run['dispatch']['backend'], 'agent')

    def test_restart_recovery_copies_finished_task_result(self):
        _, agent = self.online_agent()
        aid = self.create()
        run = self.tick()['body']['items'][0]
        self.finish_infer(agent, run['dispatch']['task_id'], text='recovered brief')
        # Simulate a process restart: a new App on the same store, no HTTP tick.
        recovered = App(self.store, self.app.config, clock=lambda: self.now)
        items = recovered.make_scheduler().recover(self.now)
        self.assertTrue(any(item['id'] == run['id'] and item['status'] == 'succeeded' for item in items), items)
        listed = self.runs(aid)
        self.assertEqual(listed['body']['items'][0]['result']['text'], 'recovered brief')

    def test_preferred_member_agent_is_used_when_online(self):
        self.online_agent(self.alice, 'alice-desk')
        bob_token, bob_agent = self.online_agent(self.bob, 'bob-desk')
        aid = self.create(title='Prefer bob', agents=['bob'])
        run = self.tick()['body']['items'][0]
        task_id = run['dispatch']['task_id']
        # Alice's agent must not be able to claim bob's task.
        alice_agent = AgentClient(self.app, self.alice.call('GET', '/v1/runtime-keys') and
                                  self.alice.call('POST', '/v1/runtime-keys', {'name': 'unused'})['body']['token'])
        # Use the already connected alice agent via a new connect on first token? Simpler: list alice tasks.
        alice_tasks = self.alice.call('GET', '/v1/runtime/tasks')
        self.assertTrue(all(item['id'] != task_id for item in alice_tasks['body']['items']), alice_tasks)
        bob_tasks = self.bob.call('GET', '/v1/runtime/tasks')
        self.assertEqual(bob_tasks['body']['items'][0]['id'], task_id)
        self.finish_infer(bob_agent, task_id, text='from bob agent')
        listed = self.runs(aid)
        self.assertEqual(listed['body']['items'][0]['result']['text'], 'from bob agent')
        self.assertEqual(listed['body']['items'][0]['result']['source'], 'account')

    def test_background_worker_cycle_reconciles_without_http_tick(self):
        _, agent = self.online_agent()
        aid = self.create()
        worker = BackgroundWorker(self.app.make_scheduler(), interval=1)
        worker.run_cycle()
        listed = self.runs(aid)
        self.assertEqual(listed['body']['items'][0]['status'], 'queued')
        task_id = listed['body']['items'][0]['dispatch']['task_id']
        self.finish_infer(agent, task_id, text='worker reconciled')
        worker.run_cycle()
        listed = self.runs(aid)
        self.assertEqual(listed['body']['items'][0]['status'], 'succeeded')
        self.assertEqual(listed['body']['items'][0]['result']['text'], 'worker reconciled')


class LoopbackAutomationTests(unittest.TestCase):
    def test_loopback_http_worker_and_daemon_complete_a_run(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        provider, provider_thread, seen = start_fake_provider(SECRET, 'hello from fake provider')
        self.addCleanup(lambda: (provider.shutdown(), provider_thread.join(3), provider.server_close()))
        base = 'http://127.0.0.1:%s/v1' % provider.server_address[1]
        holder = type('Holder', (), {'app': None})()

        def wsgi(env, start):
            return holder.app(env, start)

        server = make_server('127.0.0.1', 0, wsgi, handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), thread.join(3), server.server_close()))
        origin = 'http://127.0.0.1:' + str(server.server_port)
        store = Store(Path(temp.name) / 'loop')
        api = App(store, Config(origin, insecure_local=True, allow_registration=True,
                                automation_interval_seconds=1, runtime_task_timeout_seconds=30),
                  clock=time.time)
        holder.app = SettingsPage(api)
        client = Client(holder.app)
        host = origin.split('://', 1)[1]
        original = client.call

        def call(method, path, body=None, headers=None, **kw):
            extra = {'HTTP_HOST': host}
            extra.update(headers or {})
            return original(method, path, body, extra, **kw, origin=origin)

        client.call = call
        client.register('alice')
        saved = client.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {'provider': 'openai', 'base_url': base, 'model': 'fake-model', 'api_key': SECRET},
        })
        self.assertEqual(saved['status'], 200, saved)
        wid = client.workspace()['body']['workspace']['id']
        created = client.call('POST', f'/v1/workspaces/{wid}/automations', {
            'title': 'Loop briefing', 'prompt': 'Write a one-line brief.', 'template_id': 'custom',
            'schedule': IMMEDIATE, 'participants': ['alice'],
        }, {'HTTP_IDEMPOTENCY_KEY': 'auto-loop-000000000001'})
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['automation']['id']
        self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/automations/{aid}',
                                     {'revision': 1, 'changes': {'enabled': True}})['status'], 200)
        issued = client.call('POST', '/v1/runtime-keys', {'name': 'desk'})
        token = issued['body']['token']
        key_file = Path(temp.name) / 'runtime-key'
        key_file.write_text(token + '\n')
        os.chmod(key_file, 0o600)
        # Connect the agent first, then let the worker dispatch, then drain once.
        stdout, stderr = io.StringIO(), io.StringIO()
        self.assertEqual(flybot_main(['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
                                      '--hostname', 'desk', '--once'], stdout=stdout, stderr=stderr), 0)
        worker = api.start_automation_worker()
        self.addCleanup(api.stop_automation_worker)
        worker.run_cycle()
        listed = client.call('GET', f'/v1/workspaces/{wid}/automations/{aid}/runs')
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual(listed['body']['items'][0]['status'], 'queued', listed)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
                            '--hostname', 'desk', '--once'], stdout=stdout, stderr=stderr)
        self.assertEqual(code, 0, stderr.getvalue())
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(SECRET, output)
        self.assertNotIn(token, output)
        worker.run_cycle()
        listed = client.call('GET', f'/v1/workspaces/{wid}/automations/{aid}/runs')
        self.assertEqual(listed['body']['items'][0]['status'], 'succeeded', listed)
        self.assertEqual(listed['body']['items'][0]['result']['text'], 'hello from fake provider')
        self.assertNotIn(SECRET, json.dumps(listed['body']))
        self.assertNotIn('teamily.com', json.dumps(listed['body']))


if __name__ == '__main__':
    unittest.main()
