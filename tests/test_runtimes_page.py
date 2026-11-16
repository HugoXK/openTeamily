"""Runtimes / connection page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class RuntimesPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_install_helpers_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/runtimes')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('连接', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="expires"', html)
        self.assertIn('value="never"', html)
        self.assertIn('/v1/runtime-keys', html)
        self.assertIn('不要把安装脚本管道给 shell', html)
        self.assertIn('python3 -m openteamily.flybot daemon start', html)
        self.assertNotIn('curl -fsSL', html)
        self.assertIn('/v1/runtime/tasks', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        script_app = self.raw.call('GET', '/runtimes/app.mjs')
        self.assertEqual(script_app['status'], 200)
        self.assertIn(b'/v1/runtime/connections', script_app['body'])
        self.assertEqual(self.raw.call('GET', '/runtimes/app.css')['status'], 200)
        script = self.raw.call('GET', '/install/flybot.sh')
        self.assertEqual(script['status'], 200)
        text = script['body'].decode()
        self.assertIn('github.com/openTeamily/openTeamily', text)
        self.assertIn('Do not pipe this script into a shell', text)
        self.assertIn('python3 -m openteamily.flybot', text)
        self.assertNotIn('teamily.com', text.lower())
        self.assertIn('exit 1', text)
        windows = self.raw.call('GET', '/install/flybot.ps1')
        self.assertEqual(windows['status'], 200)
        self.assertNotIn(b'teamily.com', windows['body'].lower())
        self.assertEqual(self.raw.call('GET', '/runtimes/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/runtimes', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/runtimes', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/runtimes')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/install/flybot.sh', origin='https://evil.test')['status'], 403)

    def test_wrapper_still_exposes_runtime_keys(self):
        created = self.client.call('POST', '/v1/runtime-keys', {'name': 'desk'})
        self.assertEqual(created['status'], 201, created)
        self.assertIn('token', created['body'])
        listed = self.client.call('GET', '/v1/runtime-keys')
        self.assertEqual(listed['status'], 200)
        self.assertNotIn('token', listed['body']['items'][0])


if __name__ == '__main__':
    unittest.main()
