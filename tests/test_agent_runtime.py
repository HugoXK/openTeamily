"""Workspace agent to FlyBot instance binding and lease-gated keys. No vendor calls."""
import json
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity
from openteamily.security import digest, opaque
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AgentRuntimeBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, clock=lambda: self.now)
        self.app = App(self.store, Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now, lifecycle=self.runtime)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '容器助手', 'summary': '', 'instructions': 'Keep answers short.'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-runtime-create-01'})
        self.assertEqual(created['status'], 201, created)
        self.agent = created['body']['agent']
        inst = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/instances', {},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-runtime-inst-0001'})
        self.assertEqual(inst['status'], 201, inst)
        self.iid = inst['body']['instance']['id']
        self.token = opaque()
        identity = ManagerIdentity('manager-a', digest(self.token), frozenset([self.iid]), 'simulation')
        self.app.manager_auth = ManagerAuth([identity])

    def runtime_path(self, client=None, agent_id=None):
        client = client or self.alice
        aid = agent_id or self.agent['id']
        return f'/v1/workspaces/{self.wid}/agents/{aid}/runtime'

    def manager_call(self, method, path, body=None):
        return Client(self.app).call(
            method, path, body,
            {'HTTP_AUTHORIZATION': 'Bearer manager-a.' + self.token},
            origin=None, csrf=False)

    def finish_create(self):
        claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': self.iid})
        self.assertEqual(claim['status'], 200, claim)
        body = claim['body']['claim']
        observed = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/observe', {
            'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
            'lease': body['lease'], 'observed': 'stopped'})
        self.assertEqual(observed['status'], 200, observed)

    def start_and_issue(self):
        self.finish_create()
        started = self.alice.call('POST', f'/v1/instances/{self.iid}/start', {})
        self.assertEqual(started['status'], 202, started)
        claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': self.iid})
        self.assertEqual(claim['status'], 200, claim)
        body = claim['body']['claim']
        issued = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', {
            'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
            'lease': body['lease']})
        self.assertEqual(issued['status'], 200, issued)
        again = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', {
            'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
            'lease': body['lease']})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['runtime_key']['token'], issued['body']['runtime_key']['token'])
        observed = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/observe', {
            'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
            'lease': body['lease'], 'observed': 'running', 'process_ref': 'a' * 32})
        self.assertEqual(observed['status'], 200, observed)
        return issued['body']['runtime_key'], body

    def test_bind_permissions_isolation_and_archived_agent(self):
        self.finish_create()
        bound = self.alice.call('POST', self.runtime_path(), {'instance_id': self.iid})
        self.assertEqual(bound['status'], 201, bound)
        self.assertEqual(bound['body']['runtime']['instance_id'], self.iid)
        self.assertEqual(bound['body']['runtime']['revision'], 1)
        self.assertNotIn('token', json.dumps(bound['body']))
        listed = self.bob.call('GET', self.runtime_path())
        self.assertEqual(listed['status'], 200)
        self.assertEqual(listed['body']['runtime']['instance_id'], self.iid)
        self.assertEqual(self.bob.call('POST', self.runtime_path(), {'instance_id': self.iid})['status'], 403)
        self.assertEqual(self.eve.call('GET', self.runtime_path())['status'], 404)
        other = self.eve.workspace('evespace', 'request_example_0004')['body']['workspace']['id']
        foreign = self.eve.call('POST', f'/v1/workspaces/{other}/instances', {},
                                {'HTTP_IDEMPOTENCY_KEY': 'agent-runtime-eve-inst01'})
        self.assertEqual(foreign['status'], 201, foreign)
        self.assertEqual(self.alice.call(
            'POST', self.runtime_path(),
            {'instance_id': foreign['body']['instance']['id'], 'revision': 1})['status'], 404)
        same = self.alice.call('POST', self.runtime_path(), {'instance_id': self.iid})
        self.assertEqual(same['status'], 200)
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        self.assertEqual(self.alice.call(
            'POST', self.runtime_path(),
            {'instance_id': self.iid, 'revision': 1})['status'], 409)

    def test_lease_expiry_and_snapshots_do_not_leak_the_token(self):
        key, claim = self.start_and_issue()
        token = key['token']
        inspect = self.alice.call('GET', f'/v1/instances/{self.iid}')
        listing = self.alice.call('GET', '/v1/runtime-keys')
        for payload in (inspect['body'], listing['body'], self.alice.call('GET', self.runtime_path())['body']):
            dump = json.dumps(payload)
            self.assertNotIn(token, dump)
            self.assertNotIn('token_blob', dump)
        keys = listing['body'].get('items') or listing['body'].get('keys') or listing['body']
        if isinstance(keys, dict):
            keys = keys.get('items') or keys.get('keys') or []
        names = [row.get('name') for row in keys if isinstance(row, dict)]
        self.assertNotIn('instance', names)
        self.now += 31
        stale = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', {
            'job_id': claim['job']['id'], 'observed_revision': claim['job']['revision'],
            'lease': claim['lease']})
        self.assertEqual(stale['status'], 409, stale)
        self.assertNotIn(token, json.dumps(stale['body']))
        stop = self.alice.call('POST', f'/v1/instances/{self.iid}/stop', {})
        self.assertEqual(stop['status'], 202, stop)
        stop_claim = self.manager_call('POST', '/v1/internal/jobs/claim', {'instance_id': self.iid})
        self.assertEqual(stop_claim['status'], 200, stop_claim)
        body = stop_claim['body']['claim']
        denied = self.manager_call('POST', f'/v1/internal/instances/{self.iid}/runtime-agent-key', {
            'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
            'lease': body['lease']})
        self.assertIn(denied['status'], (409, 400))
        self.assertNotIn(token, json.dumps(denied['body']))


class AgentRuntimeDisabledTests(unittest.TestCase):
    def test_binding_requires_lifecycle(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        app = App(Store(Path(temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        client = Client(app)
        client.register('alice')
        wid = client.workspace()['body']['workspace']['id']
        created = client.call(
            'POST', f'/v1/workspaces/{wid}/agents',
            {'name': '无生命周期', 'summary': '', 'instructions': ''},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-runtime-nolife-01'})
        aid = created['body']['agent']['id']
        listed = client.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/runtime')
        self.assertEqual(listed['status'], 200)
        self.assertIsNone(listed['body']['runtime'])
        bound = client.call('POST', f'/v1/workspaces/{wid}/agents/{aid}/runtime', {'instance_id': 'a' * 32})
        self.assertEqual(bound['status'], 501)


if __name__ == '__main__':
    unittest.main()
