#!/usr/bin/env python3
"""Start a throwaway loopback OpenTeamily app and seed CI screenshot fixtures.

Binds only 127.0.0.1. Uses a fake OpenAI-compatible provider, not a real vendor.
Does not print passwords, session cookies, invite tokens, or runtime keys.
Does not change firewall, proxy, or port-forwarding rules. Not for production.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from openteamily.ci_ui_fixtures import (  # noqa: E402
    PROVIDER_TEXT, USERNAME, seed_fixtures,
)
from tests.test_runtime_infer import start_fake_provider  # noqa: E402


def _free_port(preferred):
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError('No free loopback port')


def _write_private(path, text):
    path = Path(path)
    path.write_text(text)
    os.chmod(path, 0o600)


def _json_get(origin, path, cookies):
    host = origin.split('://', 1)[1]
    request = urllib.request.Request(
        origin + path,
        headers={
            'Host': host,
            'Origin': origin,
            'Accept': 'application/json',
            'Cookie': '; '.join('%s=%s' % item for item in cookies.items()),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, None


def _wait_http(origin, path, timeout=20):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(origin + path, method='GET'), timeout=2) as response:
                if response.status == 200:
                    return
                last = response.status
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            last = error
        time.sleep(0.25)
    raise RuntimeError('Loopback app did not become ready: %s' % last)


def _public_ready(seed, origin, login_file, run_status, connection_status, git_sha):
    return {
        'origin': origin,
        'username': USERNAME,
        'login_file': str(login_file),
        'workspace_name': seed['workspace_name'],
        'workspace_id': seed['workspace_id'],
        'team_slug': seed['team_slug'],
        'member_username': seed['member_username'],
        'agent_name': seed['agent_name'],
        'automation_id': seed['automation_id'],
        'automation_title': seed['automation_title'],
        'document_title': seed['document_title'],
        'website_title': seed['website_title'],
        'media_title': seed['media_title'],
        'board_title': seed['board_title'],
        'board_text': seed['board_text'],
        'runtime_key_name': seed['runtime_key_name'],
        'provider_text': seed['provider_text'],
        'run_status': run_status,
        'connection_status': connection_status,
        'git_sha': git_sha,
        'note': (
            'Synthetic throwaway CI data on a GitHub Actions runner. '
            'The model provider is a local fake, not a real vendor. '
            'This is not production and not a Teamily parity claim.'
        ),
    }


def _poll_run_and_connection(origin, seed, timeout=45):
    cookies = seed['cookies']
    wid, aid = seed['workspace_id'], seed['automation_id']
    deadline = time.time() + timeout
    run_status = 'missing'
    connection_status = 'missing'
    while time.time() < deadline:
        run_code, runs = _json_get(origin, '/v1/workspaces/%s/automations/%s/runs?limit=20' % (wid, aid), cookies)
        if run_code == 200 and runs and runs.get('items'):
            run_status = runs['items'][0].get('status') or 'unknown'
        conn_code, connections = _json_get(origin, '/v1/runtime/connections', cookies)
        if conn_code == 200 and connections and connections.get('items'):
            connection_status = connections['items'][0].get('status') or 'unknown'
        if run_status == 'succeeded' and connection_status == 'online':
            break
        time.sleep(0.5)
    return run_status, connection_status


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--out', required=True, help='Directory for ready.json (must not be uploaded with login files)')
    parser.add_argument('--port', type=int, default=18766)
    parser.add_argument('--serve', action='store_true', help='Keep the loopback app running until SIGTERM/SIGINT')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    data_dir = Path(args.data_dir)
    out_dir = Path(args.out)
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, mode=0o700)
    out_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port(args.port)
    origin = 'http://127.0.0.1:%s' % port
    model_api_key = secrets.token_urlsafe(18)
    password = secrets.token_urlsafe(18)
    provider, provider_thread, _seen = start_fake_provider(model_api_key, PROVIDER_TEXT)
    provider_base = 'http://127.0.0.1:%s/v1' % provider.server_address[1]
    login_file = data_dir / 'login'
    _write_private(login_file, 'username=%s\npassword=%s\n' % (USERNAME, password))
    seed = seed_fixtures(data_dir, origin, password, provider_base, model_api_key, insecure_local=True)
    env = os.environ.copy()
    env['PYTHONPATH'] = str(ROOT) + ((':' + env['PYTHONPATH']) if env.get('PYTHONPATH') else '')
    server = subprocess.Popen(
        [sys.executable, '-m', 'openteamily.server', '--data-dir', str(data_dir / 'state'),
         '--origin', origin, '--port', str(port), '--insecure-local'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.4)
    agent = subprocess.Popen(
        [sys.executable, '-m', 'openteamily.flybot', 'daemon', 'start',
         '--origin', origin, '--key-file', seed['runtime_key_file'],
         '--hostname', seed['runtime_key_name'], '--poll', '0.5'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    def shutdown(*_args):
        for process in (agent, server):
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        for process in (agent, server):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        provider.shutdown()
        provider_thread.join(3)
        provider.server_close()

    try:
        _wait_http(origin, '/settings')
        if server.poll() is not None:
            raise RuntimeError('Management server exited during startup')
        run_status, connection_status = _poll_run_and_connection(origin, seed)
        git_sha = os.environ.get('GITHUB_SHA') or ''
        ready = _public_ready(seed, origin, login_file, run_status, connection_status, git_sha)
        (out_dir / 'ready.json').write_text(json.dumps(ready, indent=2, sort_keys=True) + '\n')
        print('CI UI fixture listening at %s; ready.json in %s; run=%s connection=%s'
              % (origin, out_dir, run_status, connection_status), flush=True)
        if not args.serve:
            return
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        while True:
            if server.poll() is not None:
                raise SystemExit('Management server exited')
            time.sleep(1)
    finally:
        shutdown()


if __name__ == '__main__':
    main()
