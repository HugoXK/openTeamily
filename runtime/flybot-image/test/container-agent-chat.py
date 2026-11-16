#!/usr/bin/env python3
"""CI proof: a real FlyBot container talks to a loopback management server.

The container is started the way the compose manager starts the image, plus a
temporary instance runtime-key bind and host-network access to loopback
services. Management stays bound to 127.0.0.1. This script does not change
firewall or proxy rules, does not bind all interfaces, and does not publish
the image. A lease-gated manager job issues the key. An authorized workspace
agent conversation is dispatched over /v1/agent and the assistant reply is
written back to management history.

The model backend used here is a local, clearly labeled fake
OpenAI-compatible server. This is not a real vendor inference acceptance
and not a Teamily comparison.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from openteamily.app import App, Config
from openteamily.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity
from openteamily.security import digest, opaque
from openteamily.server import QuietHandler, ThreadedWSGIServer
from openteamily.store import Store
from tests.test_management import Client


FAKE_TEXT = 'container-loop-ok-from-labeled-fake-provider'
FAKE_SECRET = 'synthetic-ci-model-key-not-a-vendor'
POLL_SECONDS = 90


def redact(text, secrets):
    out = text if isinstance(text, str) else str(text or '')
    for secret in secrets:
        if secret:
            out = out.replace(secret, '[redacted]')
    return out


def start_fake_provider(secret, body_text):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0'))
            self.rfile.read(length)
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
    return server, thread


def docker(args, *, allow_failure=False, timeout=180, secrets=()):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0 and not allow_failure:
        detail = redact((result.stdout or '') + '\n' + (result.stderr or ''), secrets)
        raise RuntimeError('docker %s failed (%s): %s' % (args[0], result.returncode, detail))
    return result


def require(ok, message, secrets=()):
    if not ok:
        raise RuntimeError(redact(message, secrets))


def wait_until(desc, fn, timeout=POLL_SECONDS, secrets=()):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.4)
    raise RuntimeError(redact('timed out waiting for %s: %r' % (desc, last), secrets))


def write_runtime_key(path, payload):
    raw = (json.dumps({
        'origin': payload['origin'],
        'token': payload['token'],
        'hostname': payload['hostname'],
    }, separators=(',', ':')) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, raw)
        try:
            os.fchown(fd, 1000, 1000)
            os.fchmod(fd, 0o600)
        except PermissionError:
            # GitHub-hosted runners are typically not uid 1000. This is a
            # throwaway CI file, unlinked in finally, and never written to logs.
            os.fchmod(fd, 0o644)
    finally:
        os.close(fd)


def unused_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main(argv):
    if len(argv) != 2:
        print('usage: python3 runtime/flybot-image/test/container-agent-chat.py <image>', file=sys.stderr)
        return 2
    image = argv[1]
    if not shutil.which('docker'):
        print('this proof runs in CI with Docker; docker is not available here', file=sys.stderr)
        return 2
    inspect = docker(['image', 'inspect', image], allow_failure=True)
    if inspect.returncode != 0:
        print('image %s is not present; build it first' % image, file=sys.stderr)
        return 2

    name = 'ot-flybot-agent-chat-%s' % uuid4()
    data = name + '-data'
    secrets = [FAKE_SECRET]
    provider = provider_thread = httpd = None
    key_path = None
    started = False
    temp = tempfile.TemporaryDirectory(prefix='ot-agent-chat-')
    try:
        os.chmod(temp.name, 0o700)
        provider, provider_thread = start_fake_provider(FAKE_SECRET, FAKE_TEXT)
        fake_base = 'http://127.0.0.1:%s/v1' % provider.server_address[1]

        store = Store(Path(temp.name) / 'state')
        lifecycle = Lifecycle(store)
        httpd = make_server('127.0.0.1', 0, lambda *a: None, handler_class=QuietHandler, server_class=ThreadedWSGIServer)
        origin = 'http://127.0.0.1:%s' % httpd.server_address[1]
        app = App(
            store,
            Config(origin, insecure_local=True, allow_registration=True,
                   runtime_heartbeat_seconds=45, runtime_task_timeout_seconds=60),
            lifecycle=lifecycle,
        )
        httpd.set_app(app)
        threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True).start()

        host = urlsplit(origin).netloc

        class ApiClient(Client):
            def call(self, method, path, body=None, headers=None, raw=None, csrf=True, origin=origin, parse='json'):
                extra = {'HTTP_HOST': host}
                extra.update(headers or {})
                return super().call(method, path, body, extra, raw, csrf, origin, parse)

        user = ApiClient(app)
        registered = user.register('alice')
        require(registered['status'] == 201, 'register failed: %r' % registered)
        saved = user.call('POST', '/v1/model-api', {
            'revision': 0,
            'changes': {
                'provider': 'openai',
                'base_url': fake_base,
                'model': 'fake-model',
                'api_key': FAKE_SECRET,
            },
        })
        require(saved['status'] == 200, 'model-api failed: %r' % saved, secrets)
        workspace = user.workspace('CI container chat', 'ci_container_chat_0001')
        require(workspace['status'] == 201, 'workspace failed: %r' % workspace)
        wid = workspace['body']['workspace']['id']
        created_agent = user.call(
            'POST', f'/v1/workspaces/{wid}/agents',
            {'name': '容器助手', 'summary': '', 'instructions': 'Answer with one short sentence.'},
            {'HTTP_IDEMPOTENCY_KEY': 'ci-container-chat-agent-01'},
        )
        require(created_agent['status'] == 201, 'agent failed: %r' % created_agent)
        agent_id = created_agent['body']['agent']['id']
        created_instance = user.call(
            'POST', f'/v1/workspaces/{wid}/instances', {},
            {'HTTP_IDEMPOTENCY_KEY': 'ci-container-chat-inst-01'},
        )
        require(created_instance['status'] == 201, 'instance failed: %r' % created_instance)
        iid = created_instance['body']['instance']['id']

        manager_token = opaque()
        secrets.append(manager_token)
        app.manager_auth = ManagerAuth([
            ManagerIdentity('manager-a', digest(manager_token), frozenset([iid]), 'simulation'),
        ])
        manager = ApiClient(app)

        def manager_call(method, path, body=None):
            return manager.call(
                method, path, body,
                {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + manager_token},
                origin=None, csrf=False,
            )

        def finish_job(observed, process_ref=None, issue=False):
            claim = manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': iid})
            require(claim['status'] == 200, 'claim failed: %r' % claim)
            body = claim['body']['claim']
            issued = None
            if issue:
                issued = manager_call(
                    'POST', f'/v1/internal/instances/{iid}/runtime-agent-key',
                    {'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
                     'lease': body['lease']},
                )
                require(issued['status'] == 200, 'runtime-agent-key failed: %r' % issued, secrets)
                require(issued['body'].get('runtime_key_present') is True, 'runtime key missing', secrets)
            payload = {
                'job_id': body['job']['id'],
                'observed_revision': body['job']['revision'],
                'lease': body['lease'],
                'observed': observed,
            }
            if process_ref:
                payload['process_ref'] = process_ref
            observed_row = manager_call('POST', f'/v1/internal/instances/{iid}/observe', payload)
            require(observed_row['status'] == 200, 'observe failed: %r' % observed_row)
            return None if issued is None else issued['body']['runtime_key']

        require(finish_job('stopped') is None, 'create must not issue a runtime key')
        started_req = user.call('POST', f'/v1/instances/{iid}/start', {})
        require(started_req['status'] == 202, 'start failed: %r' % started_req)
        runtime_key = finish_job('running', process_ref='b' * 32, issue=True)
        require(runtime_key and runtime_key.get('token') and runtime_key.get('origin') == origin, 'bad runtime key', secrets)
        secrets.append(runtime_key['token'])

        key_path = Path(temp.name) / 'runtime-key.json'
        write_runtime_key(str(key_path), runtime_key)
        dsh_port = unused_loopback_port()
        docker([
            'run', '--detach', '--name', name, '--network', 'host',
            '--user', '1000:1000',
            '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
            '--mount', 'type=volume,src=%s,dst=/data' % data,
            '--mount', 'type=bind,src=%s,dst=/run/secrets/openteamily-runtime-key.json,readonly' % key_path,
            '-e', 'DSH_TELEMETRY_DISABLED=1',
            '-e', 'DSH_LISTEN_PORT=%s' % dsh_port,
            '-e', 'DSH_HOST=127.0.0.1',
            '-e', 'OPENTEAMILY_AGENT_POLL=1',
            image,
        ], secrets=secrets)
        started = True

        bound = user.call(
            'POST', f'/v1/workspaces/{wid}/agents/{agent_id}/runtime',
            {'instance_id': iid},
        )
        require(bound['status'] == 201, 'bind failed: %r' % bound)

        def binding_online():
            row = user.call('GET', f'/v1/workspaces/{wid}/agents/{agent_id}/runtime')
            status = ((row.get('body') or {}).get('runtime') or {}).get('status')
            if row.get('status') == 200 and status == 'online':
                return row
            return None

        try:
            wait_until('instance connection online', binding_online, secrets=secrets)
        except Exception:
            logs = docker(['logs', name], allow_failure=True, secrets=secrets)
            print(redact((logs.stdout or '') + '\n' + (logs.stderr or ''), secrets), file=sys.stderr)
            raise

        conversations = f'/v1/workspaces/{wid}/agents/{agent_id}/conversations'
        created_conv = user.call(
            'POST', conversations, {'title': 'CI container chat'},
            {'HTTP_IDEMPOTENCY_KEY': 'ci-container-chat-conv-01'},
        )
        require(created_conv['status'] == 201, 'conversation failed: %r' % created_conv)
        conv_id = created_conv['body']['conversation']['id']
        sent = user.call(
            'POST', f'{conversations}/{conv_id}/messages',
            {'body': '请用一句话确认你在容器里。'},
            {'HTTP_IDEMPOTENCY_KEY': 'ci-container-chat-msg-01'},
        )
        require(sent['status'] == 201, 'send failed: %r' % sent)
        reply = sent['body']['reply']
        require(reply.get('dispatch', {}).get('source') == 'instance', 'dispatch was not the instance: %r' % reply)
        require(reply.get('dispatch', {}).get('instance_id') == iid, 'dispatch instance mismatch: %r' % reply)
        require(reply.get('task_id'), 'instance dispatch did not queue a task: %r' % reply)

        def assistant_done():
            listed = user.call('GET', f'{conversations}/{conv_id}')
            if listed.get('status') != 200:
                return None
            items = listed['body'].get('items') or []
            messages = [row for row in items if row.get('role') == 'assistant' and row.get('body') == FAKE_TEXT]
            return messages[-1] if messages else None

        try:
            done = wait_until('assistant reply in history', assistant_done, secrets=secrets)
        except Exception:
            logs = docker(['logs', name], allow_failure=True, secrets=secrets)
            print(redact((logs.stdout or '') + '\n' + (logs.stderr or ''), secrets), file=sys.stderr)
            listed = user.call('GET', f'{conversations}/{conv_id}')
            print(redact(json.dumps(listed, ensure_ascii=False), secrets), file=sys.stderr)
            raise

        require(done.get('dispatch', {}).get('source') == 'instance', 'history dispatch was not instance: %r' % done)
        logs = docker(['logs', name], allow_failure=True, secrets=secrets)
        combined = (logs.stdout or '') + '\n' + (logs.stderr or '')
        require(runtime_key['token'] not in combined, 'runtime token appeared in container logs')
        require(FAKE_SECRET not in combined, 'model key appeared in container logs')
        print(
            'PASS: real FlyBot container connected to loopback management, '
            'used a lease-issued runtime key, dispatched an agent conversation, '
            'and wrote the labeled fake-provider reply back to history. '
            'This is not a real vendor inference acceptance.'
        )
        return 0
    finally:
        if started:
            docker(['rm', '--force', name], allow_failure=True, secrets=secrets)
            docker(['volume', 'rm', data], allow_failure=True, secrets=secrets)
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        if provider is not None:
            provider.shutdown()
            if provider_thread is not None:
                provider_thread.join(3)
            provider.server_close()
        if key_path is not None and os.path.exists(key_path):
            os.remove(key_path)
        temp.cleanup()


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
