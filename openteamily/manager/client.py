"""Numeric-loopback HTTP only, no proxies/cookies/redirects/retries or body logs."""
import http.client
import json
import re
import socket
import threading
from urllib.parse import urlsplit, urlencode

from .safety import ManagerError, require, json_loads

HEX = re.compile(r'[0-9a-f]{32}')
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
KEY = re.compile(r'[A-Za-z0-9_-]{16,64}')


def check_id(value):
    require(isinstance(value, str) and HEX.fullmatch(value), 'invalid_id')
    return value


class ManagerClient:
    def __init__(self, base_url, manager_id, token, *, enabled=False, timeout=2, host_header=None):
        p = urlsplit(base_url)
        require(p.scheme == 'http' and p.hostname in ('127.0.0.1', '::1') and
                p.path in ('', '/') and not (p.username or p.password or p.query or p.fragment), 'loopback_url')
        require(p.port is not None and 1 <= p.port <= 65535, 'loopback_port')
        require(isinstance(manager_id, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,31}', manager_id), 'manager_id')
        require(isinstance(token, str) and TOKEN.fullmatch(token), 'manager_token')
        require(type(timeout) in (int, float) and 0 < timeout <= 5, 'http_timeout')
        host_header = p.netloc if host_header is None else host_header
        hp = urlsplit('http://' + host_header)
        require(hp.netloc == host_header and host_header == host_header.lower() and hp.hostname and
                not any(c in host_header for c in ('\r', '\n', ' ', '@', '/', '?', '#')) and not hp.username, 'host_header')
        if hp.port is not None:
            require(1 <= hp.port <= 65535, 'host_header')
        self.host_header = host_header
        self.host, self.port, self.manager_id, self._token = p.hostname, p.port, manager_id, token
        self.enabled, self.timeout = enabled, timeout

    def call(self, method, path, payload=None):
        require(self.enabled is True, 'execution_disabled')
        require(method in ('GET', 'POST') and path.startswith('/v1/internal/') and '\r' not in path and '\n' not in path, 'invalid_request')
        body = None if payload is None else json.dumps(payload, separators=(',', ':')).encode()
        require(body is None or len(body) <= 16384, 'request_limit')
        conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        timer = None
        try:
            # Numeric host only; HTTPConnection has no proxy/redirect/cookie machinery.
            conn.connect()
            wire = conn.sock
            def abort():
                try:
                    wire.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            timer = threading.Timer(self.timeout, abort)
            timer.daemon = True
            timer.start()  # total response/header deadline, not only per-read timeout
            conn.request(method, path, body=body, headers={
                'Host': self.host_header, 'Authorization': f'Bearer {self.manager_id}.{self._token}',
                'Content-Type': 'application/json', 'Accept': 'application/json', 'Connection': 'close',
                'X-Openteamily-Model-HTTP': 'openteamily.exact-http-task.v1'})
            response = conn.getresponse()
            raw = response.read(131073)
            require(len(raw) <= 131072, 'response_limit')
            data = json_loads(raw)
            require(isinstance(data, dict), 'response_shape')
            if response.status != 200:
                # Server error format is nested, unlike the original draft's assumption.
                code = data.get('error', {}).get('code') if isinstance(data.get('error'), dict) else None
                code = code if isinstance(code, str) and re.fullmatch('[a-z_]{1,40}', code) else 'http_error'
                raise ManagerError(code)
            return data
        except (OSError, ValueError, http.client.HTTPException):
            raise ManagerError('http_transport') from None
        finally:
            if timer:
                timer.cancel()
            conn.close()

    def snapshot(self, iid):
        check_id(iid)
        cursor = ''
        for _ in range(11):
            data = self.call('GET', '/v1/internal/instances?' + urlencode({'limit': 100, 'cursor': cursor}))
            items = data.get('items')
            require(isinstance(items, list) and len(items) <= 100, 'response_shape')
            for item in items:
                require(isinstance(item, dict), 'response_shape')
                if item.get('id') == iid:
                    return item
            nxt = data.get('cursor')
            if nxt is None:
                raise ManagerError('not_found')
            check_id(nxt)
            require(nxt > cursor, 'cursor_not_advancing')
            cursor = nxt
        raise ManagerError('list_limit')

    def claim(self, iid):
        check_id(iid)
        data = self.call('POST', '/v1/internal/jobs/claim', {'instance_id': iid})
        require(set(data) == {'claim'}, 'claim_shape')
        claim = data['claim']
        if claim is None:
            return None
        require(isinstance(claim, dict), 'claim_shape')
        instance, job = claim.get('instance'), claim.get('job')
        require(isinstance(instance, dict) and isinstance(job, dict), 'claim_shape')
        require(instance.get('id') == iid and job.get('instance_id') == iid, 'claim_target')
        check_id(job.get('id'))
        rev = job.get('revision')
        operation = instance.get('operation')
        require(type(rev) is int and rev > 0 and type(instance.get('revision')) is int and rev == instance['revision'], 'claim_revision')
        require(isinstance(operation, dict) and job.get('operation_id') == operation.get('operation_id') and
                isinstance(job.get('operation_id'), str) and KEY.fullmatch(job['operation_id']) and
                job.get('operation_type') == operation.get('type') and job.get('operation_type') in ('create', 'start', 'stop', 'restart', 'recover') and
                job.get('status') == 'running' and instance.get('backend_mode') == 'compose' and instance.get('blocked') is False, 'claim_operation')
        desired = 'stopped' if job['operation_type'] in ('create', 'stop', 'recover') else 'running'
        require(instance.get('desired') == desired, 'claim_desired')
        require(isinstance(claim.get('lease'), str) and TOKEN.fullmatch(claim['lease']) and
                type(claim.get('lease_until')) is int, 'claim_lease')
        previous = claim.get('previous_process_ref')
        require(previous is None or (isinstance(previous, str) and HEX.fullmatch(previous)), 'claim_process_identity')
        return claim

    def leased_call(self, iid, claim, action, **fields):
        check_id(iid)
        require(action in ('heartbeat', 'observe'), 'invalid_request')
        job = claim['job']
        return self.call('POST', f'/v1/internal/instances/{iid}/{action}', {
            'job_id': job['id'], 'observed_revision': job['revision'], 'lease': claim['lease'], **fields})

    def runtime_secret(self, iid, claim):
        """Lease-gated one-shot fetch. The key is written to a file and not logged."""
        check_id(iid)
        job = claim['job']
        data = self.call('POST', f'/v1/internal/instances/{iid}/runtime-secret', {
            'job_id': job['id'], 'observed_revision': job['revision'], 'lease': claim['lease']})
        require(isinstance(data, dict) and set(data) == {'model_api_present', 'model_api'}, 'secret_shape')
        require(data['model_api_present'] in (True, False), 'secret_shape')
        if data['model_api_present'] is False:
            require(data['model_api'] is None, 'secret_shape')
            return None
        doc = data['model_api']
        require(isinstance(doc, dict) and set(doc) in ({'provider', 'base_url', 'model', 'api_key', 'source'},
                {'provider', 'base_url', 'model', 'api_key', 'source', 'http_endpoint_grant'}), 'secret_shape')
        for key in ('provider', 'base_url', 'model', 'api_key', 'source'):
            require(isinstance(doc[key], str) and doc[key], 'secret_shape')
        require(doc['source'] in ('platform', 'user'), 'secret_shape')
        from .. import model_api
        from ..model_http_policy import valid_grant
        grant = doc.get('http_endpoint_grant')
        require(valid_grant(doc['base_url'], grant) if 'http_endpoint_grant' in doc else model_api.valid_base_url(doc['base_url']), 'model_endpoint')
        return doc

    def runtime_bot_social(self, iid, claim):
        """Lease-gated one-shot fetch of the collaboration server URL. No token."""
        check_id(iid)
        job = claim['job']
        data = self.call('POST', f'/v1/internal/instances/{iid}/runtime-bot-social', {
            'job_id': job['id'], 'observed_revision': job['revision'], 'lease': claim['lease']})
        require(isinstance(data, dict) and set(data) == {'bot_social_present', 'bot_social'}, 'bot_social_shape')
        require(data['bot_social_present'] in (True, False), 'bot_social_shape')
        if data['bot_social_present'] is False:
            require(data['bot_social'] is None, 'bot_social_shape')
            return None
        doc = data['bot_social']
        require(isinstance(doc, dict) and 'server' in doc and set(doc) <= {'server', 'displayName', 'source'}, 'bot_social_shape')
        require(isinstance(doc['server'], str) and doc['server'], 'bot_social_shape')
        require('token' not in doc and 'api_key' not in doc, 'bot_social_shape')
        if 'displayName' in doc:
            require(isinstance(doc['displayName'], str) and doc['displayName'], 'bot_social_shape')
        require(doc.get('source') in ('platform', 'workspace'), 'bot_social_shape')
        return doc

    def runtime_agent_key(self, iid, claim):
        """Lease-gated fetch of the instance runtime key. The token is written to a file and not logged."""
        check_id(iid)
        job = claim['job']
        data = self.call('POST', f'/v1/internal/instances/{iid}/runtime-agent-key', {
            'job_id': job['id'], 'observed_revision': job['revision'], 'lease': claim['lease']})
        require(isinstance(data, dict) and set(data) == {'runtime_key_present', 'runtime_key'}, 'runtime_key_shape')
        require(data['runtime_key_present'] in (True, False), 'runtime_key_shape')
        if data['runtime_key_present'] is False:
            require(data['runtime_key'] is None, 'runtime_key_shape')
            return None
        doc = data['runtime_key']
        require(isinstance(doc, dict) and set(doc) == {'origin', 'token', 'hostname'}, 'runtime_key_shape')
        for key in ('origin', 'token', 'hostname'):
            require(isinstance(doc[key], str) and doc[key], 'runtime_key_shape')
        return doc


    def recover(self, iid, revision, operation_id):
        check_id(iid)
        require(type(revision) is int and revision > 0 and isinstance(operation_id, str) and KEY.fullmatch(operation_id), 'recovery_fields')
        return self.call('POST', f'/v1/internal/instances/{iid}/recover', {
            'expected_revision': revision, 'operation_id': operation_id, 'confirmation': 'quiesced-executors'})
