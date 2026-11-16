"""Artifacts page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ArtifactsPageTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/artifacts')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('作品库', html)
        self.assertIn('新建文档', html)
        self.assertIn('新建网站', html)
        self.assertIn('新建媒体', html)
        self.assertIn('新建白板', html)
        self.assertIn('创建只读分享链接', html)
        self.assertIn('/v1/workspaces', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        self.assertIn("frame-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertIn("script-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/artifacts/app.mjs')
        style = self.raw.call('GET', '/artifacts/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        self.assertEqual(self.raw.call('GET', '/artifacts/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/artifacts', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/artifacts', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/artifacts')['status'], 405)

    def test_wrapper_still_exposes_the_artifacts_api(self):
        workspace = self.client.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                     {'HTTP_IDEMPOTENCY_KEY': 'artifact-page-space-0001'})
        self.assertEqual(workspace['status'], 201, workspace)
        wid = workspace['body']['workspace']['id']
        created = self.client.call(
            'POST', f'/v1/workspaces/{wid}/artifacts',
            {'title': 'Brief', 'body': 'Hello'},
            {'HTTP_IDEMPOTENCY_KEY': 'artifact-page-create-0001'},
        )
        self.assertEqual(created['status'], 201, created)
        listed = self.client.call('GET', f'/v1/workspaces/{wid}/artifacts')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([item['title'] for item in listed['body']['items']], ['Brief'])


if __name__ == '__main__':
    unittest.main()
