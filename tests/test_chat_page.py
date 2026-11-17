"""Chat page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ChatPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/chat')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('聊天', html)
        self.assertIn('id="session-pane"', html)
        self.assertIn('id="conversation-list"', html)
        self.assertIn('id="chat-form"', html)
        self.assertIn('id="chat-body"', html)
        self.assertIn('未实现', html)
        self.assertIn('id="account-menu"', html)
        self.assertIn('所有设置', html)
        self.assertIn('退出登录', html)
        self.assertLess(html.find('id="account-menu"'), html.find('id="logout-form"'))
        self.assertNotIn('积分中心', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        script = self.raw.call('GET', '/chat/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn(b'/conversations', script['body'])
        self.assertEqual(self.raw.call('GET', '/chat/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/chat/missing')['status'], 404)
        discover = self.raw.call('GET', '/discover')
        self.assertEqual(discover['status'], 200)
        self.assertIn('id="discover-list"', discover['body'].decode())

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/chat', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/chat', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/chat')['status'], 405)


if __name__ == '__main__':
    unittest.main()
