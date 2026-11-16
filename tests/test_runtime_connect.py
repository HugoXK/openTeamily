"""Runtime agent registration, auth and task transport. Includes a real loopback HTTP cycle."""
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from wsgiref.simple_server import make_server

from openteamily.app import App, Config
from openteamily.flybot import handle_task, main as flybot_main, read_key_file, valid_origin
from openteamily.runtime_connect import KEY_AUTH
from openteamily.security import digest
from openteamily.server import QuietHandler
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class AgentClient:
    def __init__(self, app, token, peer='127.0.0.1'):
        self.app, self.token, self.peer = app, token, peer

    def call(self, method, path, body=None, token=None, origin=None, cookie=None, auth=True, **headers):
        import io as _io
        payload = json.dumps(body if body is not None else {}).encode()
        if method == 'GET' and body is None:
            payload = b''
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': '',
               'HTTP_HOST': 'management.test', 'REMOTE_ADDR': self.peer,
               'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(payload)),
               'wsgi.input': _io.BytesIO(payload)}
        if auth:
            env['HTTP_AUTHORIZATION'] = 'Bearer ' + (token if token is not None else self.token)
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if cookie is not None:
            env['HTTP_COOKIE'] = cookie
        env.update(headers)
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), values
        result['body'] = json.loads(b''.join(self.app(env, start)))
        return result


class RuntimeConnectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True,
                                                runtime_heartbeat_seconds=45),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app)
        self.bob.register('bob')

    def issue(self, client=None, name='desk', **body):
        payload = {'name': name}
        payload.update(body)
        return (client or self.alice).call('POST', '/v1/runtime-keys', payload)

    def agent(self, token):
        return AgentClient(self.app, token)

    def test_connect_heartbeat_dispatch_and_echo_result(self):
        token = self.issue()['body']['token']
        agent = self.agent(token)
        first = agent.call('POST', '/v1/agent/connect', {'hostname': 'desk-one'})
        self.assertEqual(first['status'], 201, first)
        connection_id = first['body']['connection']['id']
        self.assertEqual(first['body']['connection']['status'], 'online')
        self.assertEqual(first['body']['connection']['hostname'], 'desk-one')
        self.assertNotIn('token', first['body'])
        again = agent.call('POST', '/v1/agent/connect', {'hostname': 'desk-one'})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['connection']['id'], connection_id)
        self.now += 10
        beat = agent.call('POST', '/v1/agent/heartbeat', {})
        self.assertEqual(beat['status'], 200)
        self.assertEqual(beat['body']['connection']['last_seen'], self.now)
        created = self.alice.call('POST', '/v1/runtime/tasks',
                                  {'kind': 'echo', 'prompt': 'hello desk'})
        self.assertEqual(created['status'], 201, created)
        task_id = created['body']['task']['id']
        queued = agent.call('GET', '/v1/agent/tasks')
        self.assertEqual(queued['status'], 200)
        self.assertEqual(queued['body']['items'][0]['id'], task_id)
        self.assertEqual(queued['body']['items'][0]['prompt'], 'hello desk')
        claimed = agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})
        self.assertEqual(claimed['status'], 200)
        self.assertEqual(claimed['body']['task']['status'], 'claimed')
        done = agent.call('POST', f'/v1/agent/tasks/{task_id}/result',
                          {'status': 'succeeded', 'result': {'echo': 'hello desk'}})
        self.assertEqual(done['status'], 200)
        self.assertEqual(done['body']['task']['result'], {'echo': 'hello desk'})
        seen = self.alice.call('GET', f'/v1/runtime/tasks/{task_id}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['task']['status'], 'succeeded')
        connections = self.alice.call('GET', '/v1/runtime/connections')
        self.assertEqual(connections['body']['items'][0]['status'], 'online')
        self.assertEqual(self.bob.call('GET', '/v1/runtime/connections')['body']['items'], [])
        self.assertEqual(self.bob.call('GET', f'/v1/runtime/tasks/{task_id}')['status'], 404)

    def test_rejects_browser_credentials_bad_expired_and_revoked_keys(self):
        created = self.issue(expires_in=60)
        token, key_id = created['body']['token'], created['body']['key']['id']
        agent = self.agent(token)
        self.assertEqual(agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'},
                                    origin=ORIGIN)['status'], 401)
        self.assertEqual(agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'},
                                    cookie='ot_dev_session=aaaa')['status'], 401)
        self.assertEqual(agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'},
                                    auth=False)['status'], 401)
        self.assertEqual(agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'},
                                    token='a' * 32)['body']['error']['message'], KEY_AUTH)
        agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'})
        self.now += 61
        expired = agent.call('POST', '/v1/agent/heartbeat', {})
        self.assertEqual(expired['status'], 401)
        self.assertEqual(expired['body']['error']['message'], KEY_AUTH)
        fresh = self.issue(name='other')['body']['token']
        live = self.agent(fresh)
        connected = live.call('POST', '/v1/agent/connect', {'hostname': 'desk'})
        self.assertEqual(connected['status'], 201)
        key_id = self.alice.call('GET', '/v1/runtime-keys')['body']['items'][0]['id']
        # items are newest first; revoke the fresh key
        fresh_id = self.alice.call('GET', '/v1/runtime-keys')['body']['items'][0]['id']
        self.assertEqual(self.alice.call('POST', f'/v1/runtime-keys/{fresh_id}/revoke', {})['status'], 200)
        self.assertEqual(live.call('POST', '/v1/agent/heartbeat', {})['status'], 401)
        self.assertEqual(self.alice.call('GET', '/v1/runtime/connections')['body']['items'][0]['status'],
                         'offline')

    def test_offline_without_heartbeat_and_reconnect(self):
        token = self.issue()['body']['token']
        agent = self.agent(token)
        first = agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'})
        connection_id = first['body']['connection']['id']
        self.now += 46
        listed = self.alice.call('GET', '/v1/runtime/connections')
        self.assertEqual(listed['body']['items'][0]['status'], 'offline')
        self.assertEqual(self.alice.call('POST', '/v1/runtime/tasks',
                                         {'kind': 'echo', 'prompt': 'later'})['status'], 409)
        again = agent.call('POST', '/v1/agent/connect', {'hostname': 'desk-2'})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['connection']['id'], connection_id)
        self.assertEqual(again['body']['connection']['status'], 'online')
        self.assertEqual(again['body']['connection']['hostname'], 'desk-2')

    def test_rejects_unknown_task_kinds_and_cross_key_claims(self):
        token = self.issue()['body']['token']
        self.agent(token).call('POST', '/v1/agent/connect', {'hostname': 'desk'})
        self.assertEqual(self.alice.call('POST', '/v1/runtime/tasks',
                                         {'kind': 'shell', 'prompt': 'rm -rf /'})['status'], 400)
        task = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'echo', 'prompt': 'only-alice'})
        other = self.issue(self.bob, name='bob-desk')['body']['token']
        self.agent(other).call('POST', '/v1/agent/connect', {'hostname': 'bob'})
        stolen = self.agent(other).call('POST', f'/v1/agent/tasks/{task["body"]["task"]["id"]}/claim', {})
        self.assertEqual(stolen['status'], 404)
        outcome, result = handle_task({'kind': 'echo', 'prompt': 'hi'})
        self.assertEqual((outcome, result), ('succeeded', {'echo': 'hi'}))
        self.assertEqual(handle_task({'kind': 'shell', 'prompt': 'id'})[0], 'failed')

    def test_existing_v1_database_gains_tables_without_version_bump(self):
        self.issue()
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE runtime_connections')
            db.execute('DROP TABLE runtime_tasks')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            names = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE name IN ('runtime_connections','runtime_tasks')")}
            self.assertEqual(names, {'runtime_connections', 'runtime_tasks'})


class FlybotCliTests(unittest.TestCase):
    def test_origin_and_key_file_rules(self):
        self.assertTrue(valid_origin('https://management.example'))
        self.assertTrue(valid_origin('http://127.0.0.1:9'))
        self.assertFalse(valid_origin('http://example.test'))
        self.assertFalse(valid_origin('https://management.example/path'))
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / 'key'
        path.write_text('secret-token-value-not-for-logs\n')
        os.chmod(path, 0o644)
        with self.assertRaises(ValueError):
            read_key_file(path)
        os.chmod(path, 0o600)
        self.assertEqual(read_key_file(path), 'secret-token-value-not-for-logs')


class LoopbackAgentTests(unittest.TestCase):
    def start_stack(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        holder = type('Holder', (), {'app': None})()
        def wsgi(env, start):
            return holder.app(env, start)
        server = make_server('127.0.0.1', 0, wsgi, handler_class=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        def close():
            server.shutdown()
            thread.join(3)
            server.server_close()
        self.addCleanup(close)
        origin = 'http://127.0.0.1:' + str(server.server_port)
        store = Store(Path(self.temp.name) / 'state')
        holder.app = App(store, Config(origin, insecure_local=True, allow_registration=True), clock=lambda: 1800000000)
        client = Client(holder.app)
        # Host header must match the loopback origin netloc.
        host = origin.split('://', 1)[1]
        original = client.call
        def call(method, path, body=None, headers=None, **kw):
            extra = {'HTTP_HOST': host}
            extra.update(headers or {})
            return original(method, path, body, extra, **kw, origin=origin)
        client.call = call
        client.register('alice')
        return origin, client, holder.app

    def write_key(self, token):
        path = Path(self.temp.name) / 'runtime-key'
        path.write_text(token + '\n')
        os.chmod(path, 0o600)
        return path

    def test_loopback_daemon_echo_revocation_and_reconnect(self):
        origin, client, app = self.start_stack()
        issued = client.call('POST', '/v1/runtime-keys', {'name': 'desk'})
        self.assertEqual(issued['status'], 201, issued)
        token = issued['body']['token']
        key_file = self.write_key(token)
        self.assertEqual(client.call('POST', '/v1/runtime/tasks',
                                     {'kind': 'echo', 'prompt': 'loopback-1'})['status'], 409)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(
            ['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
             '--hostname', 'loop-desk', '--once'],
            stdout=stdout, stderr=stderr)
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertNotIn(token, stdout.getvalue())
        self.assertNotIn(token, stderr.getvalue())
        created = client.call('POST', '/v1/runtime/tasks', {'kind': 'echo', 'prompt': 'loopback-1'})
        self.assertEqual(created['status'], 201, created)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(
            ['daemon', 'start', '--origin', origin, '--key-file', str(key_file),
             '--hostname', 'loop-desk', '--once'],
            stdout=stdout, stderr=stderr)
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertIn('tasks 1', stdout.getvalue())
        self.assertNotIn(token, stdout.getvalue() + stderr.getvalue())
        task = client.call('GET', '/v1/runtime/tasks/' + created['body']['task']['id'])
        self.assertEqual(task['body']['task']['status'], 'succeeded')
        self.assertEqual(task['body']['task']['result'], {'echo': 'loopback-1'})
        key_id = issued['body']['key']['id']
        self.assertEqual(client.call('POST', f'/v1/runtime-keys/{key_id}/revoke', {})['status'], 200)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(
            ['daemon', 'start', '--origin', origin, '--key-file', str(key_file), '--once'],
            stdout=stdout, stderr=stderr)
        self.assertEqual(code, 1)
        self.assertIn('Runtime key not accepted', stderr.getvalue())
        self.assertNotIn(token, stdout.getvalue() + stderr.getvalue())
        replacement = client.call('POST', '/v1/runtime-keys', {'name': 'desk-2'})
        self.assertEqual(replacement['status'], 201, replacement)
        new_token = replacement['body']['token']
        new_file = self.write_key(new_token)
        # overwrite write_key uses same path; use a second file
        new_file = Path(self.temp.name) / 'runtime-key-2'
        new_file.write_text(new_token + '\n')
        os.chmod(new_file, 0o600)
        stdout, stderr = io.StringIO(), io.StringIO()
        code = flybot_main(
            ['daemon', 'start', '--origin', origin, '--key-file', str(new_file),
             '--hostname', 'loop-desk', '--once'],
            stdout=stdout, stderr=stderr)
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertNotIn(new_token, stdout.getvalue() + stderr.getvalue())
        root = Path(__file__).resolve().parents[1]
        process = subprocess.run(
            [sys.executable, '-m', 'openteamily.flybot', 'daemon', 'start',
             '--origin', origin, '--key-file', str(new_file), '--hostname', 'proc', '--once'],
            cwd=str(root), env={**os.environ, 'PYTHONPATH': str(root)},
            capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertNotIn(new_token, process.stdout + process.stderr)
        listed = client.call('GET', '/v1/runtime/connections')
        self.assertEqual(listed['status'], 200)
        self.assertTrue(any(item['status'] == 'online' for item in listed['body']['items']))


if __name__ == '__main__':
    unittest.main()
