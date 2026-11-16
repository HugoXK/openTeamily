"""Profile and download page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ProfileDownloadPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_profile_shows_username_only_and_marks_missing_fields(self):
        page = self.raw.call('GET', '/profile')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('id="profile-username"', html)
        self.assertIn('未实现', html)
        self.assertIn('不能在这里编辑或保存', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertEqual(self.raw.call('GET', '/profile/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/profile', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/profile')['status'], 405)

    def test_download_lists_existing_runtime_and_disables_missing_clients(self):
        page = self.raw.call('GET', '/download')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('href="/install/flybot.pyz"', html)
        self.assertIn('id="download-unavailable"', html)
        self.assertIn('未实现：没有 OpenTeamily iOS 客户端', html)
        self.assertIn('未实现：没有 OpenTeamily Android 客户端', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertEqual(self.raw.call('GET', '/download/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/download', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/download', query='x=1')['status'], 400)
