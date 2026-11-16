"""Settings page serving tests. In-process WSGI only; not browser E2E."""
import io
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class RawClient:
    def __init__(self, app, peer='127.0.0.1'):
        self.app, self.peer = app, peer

    def call(self, method, path, origin=ORIGIN, host='management.test', site='', query=''):
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query,
               'HTTP_HOST': host, 'REMOTE_ADDR': self.peer, 'CONTENT_LENGTH': '0',
               'wsgi.input': io.BytesIO()}
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if site:
            env['HTTP_SEC_FETCH_SITE'] = site
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), dict(values)
        result['body'] = b''.join(self.app(env, start))
        return result


class SettingsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.api = api
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/settings')
        self.assertEqual(page['status'], 200)
        self.assertIn('账号设置', page['body'].decode())
        self.assertIn(b'/v1/settings', page['body'])
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(page['headers']['X-Content-Type-Options'], 'nosniff')
        script = self.raw.call('GET', '/settings/app.mjs')
        css = self.raw.call('GET', '/settings/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(css['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        head = self.raw.call('HEAD', '/settings')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/settings', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', host='evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', site='cross-site')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', query='q=1')['status'], 400)
        posted = self.raw.call('POST', '/settings')
        self.assertEqual(posted['status'], 405)
        self.assertEqual(posted['headers']['Allow'], 'GET, HEAD')
        self.assertEqual(self.raw.call('GET', '/settings/../settings.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)

    def test_wrapper_still_exposes_the_settings_api(self):
        response = self.client.call('GET', '/v1/settings')
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['settings']['revision'], 0)
        saved = self.client.call('POST', '/v1/settings', {'revision': 0, 'changes': {'appearance': 'dark'}})
        self.assertEqual(saved['status'], 200)
        self.assertEqual(saved['body']['settings']['values']['appearance'], 'dark')
        login = Client(self.app, peer='127.0.0.2')
        again = login.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(again['status'], 200)

    def test_html_lists_only_documented_setting_keys(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        for name in ('appearance', 'appearance_schedule', 'language', 'chat_language', 'auto_translate',
                     'send_shortcut', 'message_folding', 'document_cards', 'link_previews',
                     'task_completion_reminders', 'likes_visible', 'favorites_visible'):
            self.assertIn(f'name="{name}"', html)
        self.assertIn('sunset_sunrise', html)
        self.assertNotIn('name="fold_long_messages"', html)


if __name__ == '__main__':
    unittest.main()
