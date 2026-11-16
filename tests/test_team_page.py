"""Team wizard page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class TeamPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/team')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('创建团队', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="slug"', html)
        self.assertIn('value="new"', html)
        self.assertIn('value="convert"', html)
        self.assertIn('/v1/teams', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(self.raw.call('GET', '/team/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/team/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/team', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/team', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/team')['status'], 405)

    def test_wrapper_still_exposes_the_team_api(self):
        created = self.client.call('POST', '/v1/teams',
                                   {'name': 'Desk team', 'slug': 'desk-team', 'mode': 'new'},
                                   {'HTTP_IDEMPOTENCY_KEY': 'team-page-create-0001'})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['workspace']['slug'], 'desk-team')


if __name__ == '__main__':
    unittest.main()
