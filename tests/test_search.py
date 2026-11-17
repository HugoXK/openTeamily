"""Workspace-authorized message search (issue #88). In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        agent = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '财务助手', 'summary': '', 'instructions': ''},
            {'HTTP_IDEMPOTENCY_KEY': 'search-agent-0001'})
        self.agent_id = agent['body']['agent']['id']
        conversation = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent_id}/conversations',
            {'title': '预算'},
            {'HTTP_IDEMPOTENCY_KEY': 'search-conv-0001'})
        self.conv_id = conversation['body']['conversation']['id']
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent_id}/conversations/{self.conv_id}/messages',
            {'body': '预算表需要更新'},
            {'HTTP_IDEMPOTENCY_KEY': 'search-msg-00001'})
        dm = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'dm', 'member_ids': [self.bob_id]},
            {'HTTP_IDEMPOTENCY_KEY': 'search-social-0001'})
        self.dm_id = dm['body']['conversation']['id']
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations/{self.dm_id}/messages',
            {'body': '预算表发你了'},
            {'HTTP_IDEMPOTENCY_KEY': 'search-social-msg-0001'})

    def search(self, client, query, workspace_id=None):
        return client.call('GET', f'/v1/workspaces/{workspace_id or self.wid}/search/messages?{query}')

    def test_owner_sees_agent_and_social_hits(self):
        result = self.search(self.alice, 'q=预算表')
        self.assertEqual(result['status'], 200, result)
        kinds = sorted(item['kind'] for item in result['body']['items'])
        self.assertEqual(kinds, ['agent', 'social'])
        for item in result['body']['items']:
            self.assertEqual(set(item), {'kind', 'conversation_id', 'message_id', 'title', 'snippet', 'created'})
            self.assertIn('预算表', item['snippet'])
        agent_only = self.search(self.alice, 'q=预算表&kind=agent')
        self.assertEqual([item['kind'] for item in agent_only['body']['items']], ['agent'])
        social_only = self.search(self.alice, 'q=预算表&kind=social')
        self.assertEqual([item['kind'] for item in social_only['body']['items']], ['social'])
        self.assertEqual(self.search(self.alice, 'q=不存在')['body']['items'], [])

    def test_permission_isolation_between_users(self):
        bob = self.search(self.bob, 'q=预算表')
        self.assertEqual(bob['status'], 200)
        self.assertEqual([item['kind'] for item in bob['body']['items']], ['social'])
        self.assertEqual(self.search(self.eve, 'q=预算表')['status'], 404)
        other = self.bob.workspace('bob-space', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.search(self.alice, 'q=预算表', workspace_id=other)['status'], 404)

    def test_validation_and_methods(self):
        self.assertEqual(self.search(self.alice, 'q=')['status'], 400)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/search/messages')['status'], 400)
        self.assertEqual(self.search(self.alice, 'q=x&kind=channel')['status'], 400)
        self.assertEqual(self.search(self.alice, 'q=x&limit=0')['status'], 400)
        self.assertEqual(self.search(self.alice, 'q=x&limit=51')['status'], 400)
        self.assertEqual(self.search(self.alice, 'q=x&cursor=BAD')['status'], 400)
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/search/messages?q=x')['status'], 400)
        page = self.search(self.alice, 'q=预算表&limit=1')
        self.assertEqual(len(page['body']['items']), 1)
        self.assertEqual(page['body']['cursor'], page['body']['items'][0]['message_id'])
        rest = self.search(self.alice, f'q=预算表&limit=1&cursor={page["body"]["cursor"]}')
        self.assertEqual(len(rest['body']['items']), 1)
        self.assertNotEqual(rest['body']['items'][0]['message_id'], page['body']['items'][0]['message_id'])


if __name__ == '__main__':
    unittest.main()
