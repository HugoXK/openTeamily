"""Opt-in public agent catalog (issue #87). Public listing is a whitelisted projection."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class DiscoverTests(unittest.TestCase):
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
        self.anon = Client(self.app, peer='127.0.0.9')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.agent = self._agent(self.alice, '值班助手', '简短的中文回答', 'secret instructions')

    def _agent(self, client, name, summary, instructions):
        created = client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': name, 'summary': summary, 'instructions': instructions},
            {'HTTP_IDEMPOTENCY_KEY': 'discover-agent-' + name.encode().hex()[:24]})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def publish(self, client, agent, slug, workspace_id=None):
        return client.call('POST', f'/v1/workspaces/{workspace_id or self.wid}/agents/{agent["id"]}/discover',
                           {'slug': slug})

    def test_publish_lists_only_the_public_projection(self):
        empty = self.anon.call('GET', '/v1/discover/agents')
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'], [])
        published = self.publish(self.alice, self.agent, 'on-call')
        self.assertEqual(published['status'], 201, published)
        self.assertEqual(published['body']['discover']['slug'], 'on-call')
        self.assertTrue(published['body']['discover']['listed'])
        listed = self.anon.call('GET', '/v1/discover/agents')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        item = listed['body']['items'][0]
        self.assertEqual(item['slug'], 'on-call')
        self.assertEqual(item['name'], '值班助手')
        self.assertEqual(item['summary'], '简短的中文回答')
        self.assertEqual(set(item), {'slug', 'name', 'summary', 'updated'})
        self.assertNotIn('secret instructions', str(listed['body']))
        self.assertNotIn(self.wid, str(listed['body']))
        search = self.anon.call('GET', '/v1/discover/agents?q=中文')
        self.assertEqual(len(search['body']['items']), 1)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?q=missing')['body']['items'], [])
        read = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover')
        self.assertEqual(read['body']['discover']['slug'], 'on-call')
        again = self.publish(self.alice, self.agent, 'on-call')
        self.assertEqual(again['status'], 200)

    def test_permissions_conflict_and_validation(self):
        self.assertEqual(self.publish(self.bob, self.agent, 'bob-slug')['status'], 403)
        self.assertEqual(self.publish(self.eve, self.agent, 'eve-slug')['status'], 404)
        self.assertEqual(self.publish(self.alice, self.agent, 'Bad Slug')['status'], 400)
        self.assertEqual(self.publish(self.alice, self.agent, 'settings')['status'], 400)
        self.assertEqual(self.publish(self.alice, self.agent, 'on-call')['status'], 201)
        other = self._agent(self.alice, '另一个', '', '')
        conflict = self.publish(self.alice, other, 'on-call')
        self.assertEqual(conflict['status'], 409)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover/revoke', {})
        self.assertEqual(revoked['status'], 200)
        self.assertFalse(revoked['body']['discover']['listed'])
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents')['body']['items'], [])
        self.assertEqual(self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover/revoke', {})['status'], 403)

    def test_archived_agents_and_pagination(self):
        agents = [self._agent(self.alice, 'A' + str(i), '', '') for i in range(3)]
        for index, agent in enumerate(agents):
            self.assertEqual(self.publish(self.alice, agent, 'agent-' + str(index))['status'], 201)
        page = self.anon.call('GET', '/v1/discover/agents?limit=2')
        self.assertEqual([row['slug'] for row in page['body']['items']], ['agent-0', 'agent-1'])
        self.assertEqual(page['body']['cursor'], 'agent-1')
        rest = self.anon.call('GET', '/v1/discover/agents?limit=2&cursor=agent-1')
        self.assertEqual([row['slug'] for row in rest['body']['items']], ['agent-2'])
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{agents[0]["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        listed = self.anon.call('GET', '/v1/discover/agents?limit=10')
        self.assertNotIn('agent-0', [row['slug'] for row in listed['body']['items']])
        self.assertEqual(self.publish(self.alice, agents[0], 'archived-slug')['status'], 409)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?limit=0')['status'], 400)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?cursor=BAD')['status'], 400)
        self.assertEqual(self.anon.call('POST', '/v1/discover/agents')['status'], 405)


if __name__ == '__main__':
    unittest.main()
