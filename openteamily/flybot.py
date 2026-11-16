"""FlyBot connection daemon for a self-hosted OpenTeamily server.

Authenticate with a runtime key, register, heartbeat, and run allowlisted
tasks (currently `echo` only). Payloads are never passed to a shell.
Do not pipe install scripts into a shell; start this module explicitly:

  python3 -m openteamily.flybot daemon start --origin <origin> --key-file <path>

The key is never written to logs or traces. HTTP origins other than loopback
are rejected; HTTPS is required for non-loopback hosts.
"""
import argparse
import ipaddress
import json
import os
import ssl
import stat
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .runtime_connect import echo_result

USER_AGENT = 'FlyBot-OpenTeamily-agent/1'


class AgentError(Exception):
    def __init__(self, status, body):
        self.status, self.body = status, body
        message = 'request failed'
        if isinstance(body, dict) and isinstance(body.get('error'), dict):
            message = body['error'].get('message') or message
        super().__init__(message)


def valid_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        return False
    if parsed.scheme == 'https':
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return parsed.hostname in ('localhost',)


def read_key_file(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Key file must be a private regular file owned by this user')
        raw = os.read(fd, 256)
    finally:
        os.close(fd)
    token = raw.decode('utf-8').strip()
    if not token or len(token) > 128 or any(c.isspace() for c in token):
        raise ValueError('Key file must contain a single runtime key')
    return token


def request(origin, method, path, token, body=None, timeout=10):
    payload = None if body is None and method == 'GET' else json.dumps(body if body is not None else {}).encode()
    headers = {'Accept': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': USER_AGENT}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(origin + path, data=payload, headers=headers, method=method)
    context = ssl.create_default_context() if urlsplit(origin).scheme == 'https' else None
    try:
        with urlopen(req, timeout=timeout, context=context) as response:
            raw = response.read()
            status = response.status
    except HTTPError as error:
        raw = error.read()
        status = error.code
    except URLError as error:
        raise AgentError(0, {'error': {'code': 'network', 'message': 'Cannot reach the management server'}}) from error
    try:
        parsed = json.loads(raw.decode('utf-8')) if raw else {}
    except (UnicodeError, ValueError):
        parsed = {}
    if status >= 400:
        raise AgentError(status, parsed if isinstance(parsed, dict) else {})
    return status, parsed if isinstance(parsed, dict) else {}


def handle_task(task):
    if not isinstance(task, dict) or task.get('kind') != 'echo':
        return 'failed', {'error': 'unsupported task kind'}
    prompt = task.get('prompt')
    if not isinstance(prompt, str):
        return 'failed', {'error': 'invalid prompt'}
    return 'succeeded', echo_result(prompt)


def run_cycle(origin, token, hostname, once=False, poll=1.0, sleeper=time.sleep, requester=request):
    status, connected = requester(origin, 'POST', '/v1/agent/connect', token, {'hostname': hostname})
    if status not in (200, 201):
        raise AgentError(status, connected)
    processed = []
    while True:
        requester(origin, 'POST', '/v1/agent/heartbeat', token, {})
        listed = requester(origin, 'GET', '/v1/agent/tasks', token)[1]
        items = listed.get('items') or []
        for task in items:
            claimed = requester(origin, 'POST', '/v1/agent/tasks/' + task['id'] + '/claim', token, {})[1]
            outcome, result = handle_task(claimed.get('task') or task)
            requester(origin, 'POST', '/v1/agent/tasks/' + task['id'] + '/result', token,
                      {'status': outcome, 'result': result})
            processed.append(task['id'])
        if once:
            return connected.get('connection'), processed
        sleeper(poll)


def main(argv=None, stdout=None, stderr=None):
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    parser = argparse.ArgumentParser(prog='openteamily.flybot', description=__doc__)
    sub = parser.add_subparsers(dest='group', required=True)
    daemon = sub.add_parser('daemon')
    action = daemon.add_subparsers(dest='action', required=True)
    start = action.add_parser('start', help='Register with the management server and poll for tasks')
    start.add_argument('--origin', required=True, help='Exact management origin, such as https://management.example')
    key = start.add_mutually_exclusive_group(required=True)
    key.add_argument('--key-file', help='Private file containing the runtime key (preferred)')
    key.add_argument('--key', help='Runtime key (for tests only; prefer --key-file)')
    start.add_argument('--hostname', default='flybot')
    start.add_argument('--once', action='store_true', help='Connect, drain queued tasks, and exit')
    start.add_argument('--poll', type=float, default=1.0)
    args = parser.parse_args(argv)
    if args.group == 'daemon' and args.action == 'start':
        if not valid_origin(args.origin):
            parser.error('Origin must be https, or http on a loopback address, without a path')
        if not 0.1 <= args.poll <= 60:
            parser.error('--poll must be between 0.1 and 60 seconds')
        try:
            token = read_key_file(args.key_file) if args.key_file else args.key
        except (OSError, ValueError) as error:
            print('Cannot read the runtime key', file=stderr)
            return 2
        try:
            connection, processed = run_cycle(
                args.origin.rstrip('/'), token, args.hostname, once=True if args.once else False, poll=args.poll)
        except AgentError as error:
            # Never print the key or Authorization header.
            print('FlyBot daemon: ' + str(error), file=stderr)
            return 1
        if args.once:
            print('connected ' + connection['id'] + ' tasks ' + str(len(processed)), file=stdout)
            return 0
        return 0
    parser.error('Unsupported command')
    return 2


if __name__ == '__main__':
    sys.exit(main())
