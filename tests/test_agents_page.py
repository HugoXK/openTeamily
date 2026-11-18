"""Agents page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import re
import tempfile
import unittest

from openteamily import discover
from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class AgentsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/agents')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('智能体', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="instructions"', html)
        self.assertIn('id="chat-panel"', html)
        self.assertIn('id="homepage-panel"', html)
        self.assertIn('id="publish-homepage"', html)
        self.assertIn('/v1/workspaces', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        script = self.raw.call('GET', '/agents/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn(b'/v1/workspaces/', script['body'])
        self.assertIn(b'/conversations', script['body'])
        self.assertIn(b'/homepage', script['body'])
        self.assertIn(b'Idempotency-Key', script['body'])
        self.assertEqual(self.raw.call('GET', '/agents/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/agents/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/agents', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/agents', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/agents')['status'], 405)

    def test_category_deep_link_is_the_only_accepted_query(self):
        page = self.raw.call('GET', '/agents', query='category=design')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        slugs = re.findall(r'data-category="([a-z-]+)"', html)
        self.assertEqual(slugs, ['all', *[slug for slug, _label in discover.AGENT_CATEGORIES]])
        for bad in ('category=not-a-category', 'category=', 'category=design&x=1',
                    'x=1', 'category=Design', 'category=design&category=sales'):
            self.assertEqual(self.raw.call('GET', '/agents', query=bad)['status'], 400, bad)

    def test_wrapper_still_exposes_agent_directory(self):
        space = self.client.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                 {'HTTP_IDEMPOTENCY_KEY': 'agents-page-space-01'})
        self.assertEqual(space['status'], 201, space)
        wid = space['body']['workspace']['id']
        created = self.client.call(
            'POST', f'/v1/workspaces/{wid}/agents',
            {'name': '目录助手', 'summary': '', 'instructions': '保持简短。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agents-page-create-01'})
        self.assertEqual(created['status'], 201, created)
        listed = self.client.call('GET', f'/v1/workspaces/{wid}/agents')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['name'] for row in listed['body']['items']], ['目录助手'])


if __name__ == '__main__':
    unittest.main()
