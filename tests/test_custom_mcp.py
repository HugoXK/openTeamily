"""Synthetic transport only. Not real MCP-vendor or Composio acceptance."""
import ipaddress
import json
import socket
import unittest
from unittest.mock import patch
from openteamily import custom_mcp, connected_tools
from tests.test_composio import ComposioTests
from tests.test_runtime_connect import AgentClient

TOKEN = 'synthetic_mcp_owner_only_secret'


class FixtureMcp:
    def __init__(self):
        self.calls = []
        self.fail_call = False

    def __call__(self, url, headers, body):
        d = json.loads(body)
        self.calls.append((d, headers))
        assert headers.get('Authorization') == 'Bearer ' + TOKEN
        if 'id' not in d:
            return 202, {}, b''
        result = {}
        if d['method'] == 'initialize':
            result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'explicit-ci-fixture', 'version': '1'}}
        if d['method'] == 'tools/list':
            result = {'tools': [{'name': 'fixture.status', 'description': 'Explicit CI fixture; no real external service', 'inputSchema': {'type': 'object'}}]}
        if d['method'] == 'tools/call':
            if self.fail_call:
                raise TimeoutError()
            result = {'content': [{'type': 'text', 'text': 'fixture ' + TOKEN}]}
        return 200, {'content-type': 'application/json', 'mcp-session-id': 'synthetic-session'}, json.dumps({'jsonrpc': '2.0', 'id': d['id'], 'result': result}).encode()


class CustomMcpTests(unittest.TestCase):
    def setUp(self):
        ComposioTests.setUp(self)
        self.fixture = FixtureMcp()
        self.app.mcp_transport = self.fixture
        saved = self.alice.call('POST', '/v1/mcp/servers', {'name': 'Explicit CI fixture', 'url': 'https://mcp.example.test/mcp', 'bearer_token': TOKEN})
        self.assertEqual(saved['status'], 200, saved)
        self.server = saved['body']['server']
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'test'})['body']['token']
        self.agent = AgentClient(self.app, token)
        self.agent.call('POST', '/v1/agent/connect', {'hostname': 'test'})
        self.task = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'check fixture'})['body']['task']
        self.agent.call('POST', '/v1/agent/tasks/' + self.task['id'] + '/claim', {})
        self.path = '/v1/agent/tasks/' + self.task['id'] + '/tools'

    def discovery(self):
        d = self.agent.call('POST', self.path, {})
        self.assertEqual(d['status'], 200, d)
        self.assertNotIn(TOKEN, json.dumps(d))
        return d['body']['tools'][0]['function']['name']

    def propose(self):
        name = self.discovery()
        return self.agent.call('POST', self.path + '/calls', {'name': name, 'arguments': {}, 'call_id': 'mcp_1'})['body']['call']

    def test_isolation_csrf_wrapped_storage_and_redacted_views(self):
        self.assertNotIn(TOKEN, json.dumps(self.server))
        listed = self.alice.call('GET', '/v1/mcp/servers')
        self.assertNotIn(TOKEN, json.dumps(listed))
        self.assertEqual(self.bob.call('GET', '/v1/mcp/servers')['body']['items'], [])
        self.assertEqual(self.bob.call('DELETE', '/v1/mcp/servers/' + self.server['id'])['status'], 404)
        self.assertEqual(self.alice.call('DELETE', '/v1/mcp/servers/' + self.server['id'], csrf=False)['status'], 403)
        with self.app.store.connect() as db:
            row = db.execute('SELECT * FROM custom_mcp_servers').fetchone()
            self.assertNotIn(TOKEN, row['config_blob'])
            self.assertEqual(custom_mcp.secret_config(self.app.store, row)['bearer_token'], TOKEN)
            self.assertTrue(connected_tools.available(db, self.task['id']))

    def test_native_bridge_schema_then_explicit_owner_approval_exactly_once(self):
        proposal = self.propose()
        cid = proposal['id']
        execute = lambda: self.agent.call('POST', self.path + '/calls/' + cid, {})
        self.assertEqual(execute()['body']['call']['status'], 'pending')
        self.assertFalse(any(c[0]['method'] == 'tools/call' for c in self.fixture.calls))
        self.assertEqual(self.bob.call('POST', '/v1/composio/approvals/' + cid, {'decision': 'approve'})['status'], 404)
        listing = self.alice.call('GET', '/v1/composio/approvals')
        self.assertIn('MCP:', listing['body']['items'][0]['account']['toolkit'])
        self.assertEqual(self.alice.call('POST', '/v1/composio/approvals/' + cid, {'decision': 'approve'})['status'], 200)
        done = execute()
        self.assertEqual(done['body']['call']['status'], 'succeeded', done)
        self.assertNotIn(TOKEN, json.dumps(done))
        execute()
        self.assertEqual(sum(c[0]['method'] == 'tools/call' for c in self.fixture.calls), 1)

    def test_removed_or_changed_server_invalidates_discovery_and_approval(self):
        proposal = self.propose()
        self.alice.call('POST', '/v1/composio/approvals/' + proposal['id'], {'decision': 'approve'})
        self.alice.call('DELETE', '/v1/mcp/servers/' + self.server['id'])
        self.assertEqual(self.agent.call('POST', self.path + '/calls/' + proposal['id'], {})['status'], 409)
        self.assertFalse(any(c[0]['method'] == 'tools/call' for c in self.fixture.calls))

    def test_ambiguous_remote_outcome_never_retries(self):
        p = self.propose()
        self.alice.call('POST', '/v1/composio/approvals/' + p['id'], {'decision': 'approve'})
        self.fixture.fail_call = True
        for _ in range(2):
            r = self.agent.call('POST', self.path + '/calls/' + p['id'], {})
            self.assertEqual(r['body']['call']['status'], 'unknown', r)
        self.assertEqual(sum(c[0]['method'] == 'tools/call' for c in self.fixture.calls), 1)

    def test_private_redirect_query_and_secret_url_rejected(self):
        for url in ['http://mcp.example.test/mcp', 'https://127.0.0.1/mcp', 'https://169.254.169.254/mcp', 'https://[::1]/mcp', 'https://mcp.example.test:8443/mcp', 'https://u:p@mcp.example.test/mcp', 'https://mcp.example.test/mcp?token=x', 'https://host.local/mcp']:
            r = self.alice.call('POST', '/v1/mcp/servers', {'name': 'bad', 'url': url})
            self.assertEqual(r['status'], 400, url)
        with patch.object(socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]), patch.object(custom_mcp, 'PinnedHTTPS') as pinned:
            with self.assertRaises(connected_tools.Fault):
                custom_mcp.transport('https://mcp.example.test/mcp', {}, b'{}')
            pinned.assert_not_called()
        for addr in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:8.8.8.8', '224.0.0.1']:
            self.assertFalse(custom_mcp.public_ip(ipaddress.ip_address(addr)))

    def test_redirect_and_oversized_responses_rejected_without_retry(self):
        for response in [(302, {'location': 'https://other.test/'}, b''), (200, {}, b'x' * (custom_mcp.LIMIT + 1))]:
            calls = []
            def fake(*args):
                calls.append(args)
                return response
            with self.assertRaises(connected_tools.Fault):
                custom_mcp.Client({'url': 'https://mcp.example.test/mcp'}, fake).initialize()
            self.assertEqual(len(calls), 1)
