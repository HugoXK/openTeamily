"""Allowlisted infer tasks, cancel, timeout, isolation, and zipapp install."""
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from wsgiref.simple_server import make_server

from openteamily.app import App, Config
from openteamily.flybot import handle_task, infer_chat, main as flybot_main
from openteamily.flybot_bundle import build
from openteamily.server import QuietHandler
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client
from tests.test_runtime_connect import AgentClient
from tests.test_settings_page import RawClient

SECRET = 'synthetic-model-key-for-tests'


def start_fake_provider(secret, body_text='hello from fake provider'):
    seen = {'authorization': None, 'body': None, 'count': 0}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length)
            seen['authorization'] = self.headers.get('Authorization')
            seen['body'] = raw
            seen['count'] += 1
            if self.path.rstrip('/') != '/v1/chat/completions':
                self.send_response(404)
                self.end_headers()
                return
            if self.headers.get('Authorization') != 'Bearer ' + secret:
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"error":"unauthorized"}')
                return
            payload = json.dumps({
                'choices': [{'message': {'role': 'assistant', 'content': body_text}}],
                'model': 'fake-model',
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format, *args):
            return

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
    thread.start()
    return server, thread, seen


class InferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.provider, self.provider_thread, self.seen = start_fake_provider(SECRET)
        self.addCleanup(lambda: (self.provider.shutdown(), self.provider_thread.join(3), self.provider.server_close()))
        self.base = 'http://127.0.0.1:%s/v1' % self.provider.server_address[1]
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config('https://management.test', allow_registration=True,
                                                runtime_heartbeat_seconds=45,
                                                runtime_task_timeout_seconds=30),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app)
        self.bob.register('bob')
        saved = self.alice.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {'provider': 'openai', 'base_url': self.base, 'model': 'fake-model', 'api_key': SECRET},
        })
        self.assertEqual(saved['status'], 200, saved)
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'desk'})['body']['token']
        self.token = token
        self.agent = AgentClient(self.app, token)
        self.agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'})

    def test_infer_uses_configured_key_once_and_omits_it_from_results(self):
        created = self.alice.call('POST', '/v1/runtime/tasks',
                                  {'kind': 'infer', 'prompt': 'say hello'})
        self.assertEqual(created['status'], 201, created)
        task_id = created['body']['task']['id']
        listed = self.alice.call('GET', '/v1/runtime/tasks')
        blob = json.dumps(listed['body'])
        self.assertNotIn(SECRET, blob)
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 200)
        access = self.agent.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})
        self.assertEqual(access['status'], 200, access)
        self.assertEqual(access['body']['model_api']['api_key'], SECRET)
        self.assertEqual(access['body']['model_api']['source'], 'account')
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{task_id}/model-access', {})['status'], 409)
        text = infer_chat(access['body']['model_api'], 'say hello')
        self.assertEqual(text, 'hello from fake provider')
        self.assertEqual(self.seen['authorization'], 'Bearer ' + SECRET)
        done = self.agent.call('POST', f'/v1/agent/tasks/{task_id}/result',
                               {'status': 'succeeded', 'result': {'text': text, 'model': 'fake-model', 'source': 'account'}})
        self.assertEqual(done['status'], 200, done)
        self.assertNotIn('api_key', done['body']['task']['result'])
        self.assertNotIn(SECRET, json.dumps(done['body']))
        seen = self.alice.call('GET', f'/v1/runtime/tasks/{task_id}')
        self.assertEqual(seen['body']['task']['result']['text'], 'hello from fake provider')
        self.assertNotIn(SECRET, json.dumps(seen['body']))
        dumped = Path(self.path / 'management.sqlite3').read_bytes()
        self.assertNotIn(SECRET.encode(), dumped)

    def test_loopback_daemon_and_zipapp_run_infer_without_leaking_the_key(self):
        holder = type('Holder', (), {'app': None})()
        def wsgi(env, start):
            return holder.app(env, start)
        server = make_server('127.0.0.1', 0, wsgi, handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), thread.join(3), server.server_close()))
        origin = 'http://127.0.0.1:' + str(server.server_port)
        store = Store(Path(self.temp.name) / 'loop')
        holder.app = SettingsPage(App(store, Config(origin, insecure_local=True, allow_registration=True),
                                      clock=lambda: 1800000000))
        client = Client(holder.app.api if hasattr(holder.app, 'api') else holder.app)
        # SettingsPage wraps App; Client should talk to the wrapper so /install works,
        # but /v1 goes through to App. Use the wrapper.
        client = Client(holder.app)
        host = origin.split('://', 1)[1]
        original = client.call
        def call(method, path, body=None, headers=None, **kw):
            extra = {'HTTP_HOST': host}
            extra.update(headers or {})
            return original(method, path, body, extra, **kw, origin=origin)
        client.call = call
        # Raw client for binary bundle
        raw = RawClient(holder.app)
        client.register('alice')
        saved = client.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {'provider': 'openai', 'base_url': self.base, 'model': 'fake-model', 'api_key': SECRET},
        })
        self.assertEqual(saved['status'], 200, saved)
        issued = client.call('POST', '/v1/runtime-keys', {'name': 'desk'})
        token = issued['body']['token']
        key_file = Path(self.temp.name) / 'runtime-key'
        key_file.write_text(token + '\n')
        os.chmod(key_file, 0o600)
        self.assertEqual(client.call('POST', '/v1/runtime-keys', {'name': 'x'}) and
                         flybot_main(['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
                                      '--hostname', 'desk', '--once'],
                                     stdout=io.StringIO(), stderr=io.StringIO()), 0)
        created = client.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'loop infer'})
        self.assertEqual(created['status'], 201, created)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
                            '--hostname', 'desk', '--once'], stdout=stdout, stderr=stderr)
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertNotIn(SECRET, stdout.getvalue() + stderr.getvalue())
        self.assertNotIn(token, stdout.getvalue() + stderr.getvalue())
        seen = client.call('GET', '/v1/runtime/tasks/' + created['body']['task']['id'])
        self.assertEqual(seen['body']['task']['status'], 'succeeded', seen)
        self.assertEqual(seen['body']['task']['result']['text'], 'hello from fake provider')
        self.assertNotIn(SECRET, json.dumps(seen['body']))
        bundle = raw.call('GET', '/install/flybot.pyz', origin=origin, host=host)
        self.assertEqual(bundle['status'], 200, bundle)
        pyz = Path(self.temp.name) / 'flybot.pyz'
        pyz.write_bytes(bundle['body'])
        created = client.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'zipapp infer'})
        self.assertEqual(created['status'], 201, created)
        process = subprocess.run(
            [sys.executable, str(pyz), 'daemon', 'start', '--origin', origin,
             '--key-file', str(key_file), '--hostname', 'zip', '--once'],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertNotIn(SECRET, process.stdout + process.stderr)
        self.assertNotIn(token, process.stdout + process.stderr)
        seen = client.call('GET', '/v1/runtime/tasks/' + created['body']['task']['id'])
        self.assertEqual(seen['body']['task']['status'], 'succeeded', seen)
        self.assertEqual(seen['body']['task']['result']['text'], 'hello from fake provider')

    def test_cancel_timeout_isolation_and_revocation(self):
        queued = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'later'})
        task_id = queued['body']['task']['id']
        cancelled = self.alice.call('POST', f'/v1/runtime/tasks/{task_id}/cancel', {})
        self.assertEqual(cancelled['status'], 200, cancelled)
        self.assertEqual(cancelled['body']['task']['status'], 'cancelled')
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 409)
        other = self.bob.call('POST', '/v1/runtime-keys', {'name': 'bob'})['body']['token']
        bob_agent = AgentClient(self.app, other)
        bob_agent.call('POST', '/v1/agent/connect', {'hostname': 'bob'})
        live = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'secret work'})
        live_id = live['body']['task']['id']
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{live_id}/claim', {})['status'], 200)
        self.assertEqual(bob_agent.call('POST', f'/v1/agent/tasks/{live_id}/model-access', {})['status'], 404)
        self.assertEqual(self.bob.call('GET', f'/v1/runtime/tasks/{live_id}')['status'], 404)
        space = self.alice.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                {'HTTP_IDEMPOTENCY_KEY': 'infer-space-00000001'})
        self.assertEqual(space['status'], 201, space)
        foreign = self.bob.call('POST', '/v1/runtime/tasks',
                                {'kind': 'infer', 'prompt': 'nope',
                                 'workspace_id': space['body']['workspace']['id']})
        self.assertEqual(foreign['status'], 404)
        key_id = self.alice.call('GET', '/v1/runtime-keys')['body']['items'][0]['id']
        self.assertEqual(self.alice.call('POST', f'/v1/runtime-keys/{key_id}/revoke', {})['status'], 200)
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{live_id}/model-access', {})['status'], 401)
        # timeout
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'fresh'})['body']['token']
        fresh = AgentClient(self.app, token)
        fresh.call('POST', '/v1/agent/connect', {'hostname': 'desk'})
        timed = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'echo', 'prompt': 'wait'})
        self.now += 31
        seen = self.alice.call('GET', '/v1/runtime/tasks/' + timed['body']['task']['id'])
        self.assertEqual(seen['body']['task']['status'], 'timeout')
        self.assertEqual(fresh.call('POST', '/v1/agent/tasks/' + timed['body']['task']['id'] + '/claim', {})['status'], 409)

    def test_handle_task_infer_and_shell_rejection(self):
        calls = []
        def requester(origin, method, path, token, body=None, timeout=10):
            calls.append(path)
            return 200, {'model_api': {'provider': 'openai', 'base_url': self.base,
                                       'model': 'fake-model', 'api_key': SECRET, 'source': 'account'}}
        status, result = handle_task({'id': 'a' * 32, 'kind': 'infer', 'prompt': 'hi'},
                                     origin='http://127.0.0.1:1', token='tok', requester=requester)
        self.assertEqual(status, 'succeeded')
        self.assertEqual(result['text'], 'hello from fake provider')
        self.assertNotIn('api_key', result)
        self.assertEqual(handle_task({'kind': 'shell', 'prompt': 'id'})[0], 'failed')
        built = build()
        self.assertGreater(len(built), 100)
        self.assertNotIn(b'teamily.com', built.lower())


if __name__ == '__main__':
    unittest.main()
