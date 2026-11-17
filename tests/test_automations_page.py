"""Automations page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


SCHEDULE = {'kind': 'now', 'time_zone': 'UTC'}


class AutomationsPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/automations')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('自动化', html)
        self.assertIn('data-category="mine"', html)
        self.assertIn('data-category="work"', html)
        self.assertIn('data-category="life"', html)
        self.assertIn('name="intent"', html)
        self.assertIn('name="scope"', html)
        self.assertIn('value="now"', html)
        self.assertIn('value="monthly"', html)
        self.assertIn('value="weekdays"', html)
        self.assertIn('运行记录', html)
        self.assertIn('模板目录', html)
        self.assertIn('>模板<', html)
        self.assertNotIn('生活类模板还没有从对照里记下来', html)
        self.assertNotIn('teamily.com', html)
        self.assertIn('/v1/workspaces', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/automations/app.mjs')
        style = self.raw.call('GET', '/automations/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        self.assertEqual(self.raw.call('GET', '/automations/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/automations', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/automations', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/automations')['status'], 405)

    def test_wrapper_still_exposes_the_automations_api(self):
        workspace = self.client.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                     {'HTTP_IDEMPOTENCY_KEY': 'automation-page-space-0001'})
        self.assertEqual(workspace['status'], 201, workspace)
        wid = workspace['body']['workspace']['id']
        created = self.client.call(
            'POST', f'/v1/workspaces/{wid}/automations',
            {'title': 'Morning briefing', 'prompt': '', 'template_id': 'daily_brief',
             'schedule': SCHEDULE, 'participants': ['alice']},
            {'HTTP_IDEMPOTENCY_KEY': 'automation-page-create-0001'},
        )
        self.assertEqual(created['status'], 201, created)
        listed = self.client.call('GET', f'/v1/workspaces/{wid}/automations?category=work')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([item['title'] for item in listed['body']['items']], ['Morning briefing'])


if __name__ == '__main__':
    unittest.main()
