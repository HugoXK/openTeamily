"""Messenger page serving tests. In-process WSGI only; not browser E2E."""
import unittest

from tests import test_settings_page as settings_page_tests


class MessengerPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/messenger')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('消息', html)
        self.assertIn('id="create-conversation"', html)
        self.assertIn('id="conversation-list"', html)
        self.assertIn('id="message-list"', html)
        self.assertIn('href="/messenger"', html)
        self.assertIn('id="status"', html)
        self.assertIn('<nav', html)
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(page['headers']['X-Content-Type-Options'], 'nosniff')
        script = self.raw.call('GET', '/messenger/app.mjs')
        css = self.raw.call('GET', '/messenger/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(css['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        self.assertIn(b'conversationLabel', script['body'])
        self.assertEqual(self.raw.call('HEAD', '/messenger')['status'], 200)
        self.assertEqual(self.raw.call('HEAD', '/messenger')['body'], b'')

    def test_origin_and_method_checks_still_apply(self):
        self.assertEqual(self.raw.call('GET', '/messenger', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/messenger', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/messenger')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/messenger/missing')['status'], 404)


if __name__ == '__main__':
    unittest.main()
