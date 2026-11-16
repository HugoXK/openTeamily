"""Shared management shell serving tests. In-process WSGI only; not browser E2E."""
import unittest

from tests import test_settings_page as settings_page_tests


PAGES = (
    '/settings', '/agents', '/automations', '/artifacts',
    '/members', '/team', '/runtimes', '/memory',
)

CAPTURE_IDS = {
    '/settings': ('login-panel', 'username', 'password', 'settings-panel',
                  'whoami', 'model-key-state', 'model-api-form'),
    '/agents': ('main-panel', 'agent-list', 'edit-form', 'chat-panel',
                'conversation-list', 'message-list', 'chat-form'),
    '/automations': ('automation-list', 'editor-form', 'run-panel',
                     'run-list', 'run-empty'),
    '/artifacts': ('artifact-list', 'editor-form', 'media-image',
                   'board-canvas', 'website-preview'),
    '/members': ('member-list', 'invite-list'),
    '/team': ('wizard-form', 'step-1', 'step-2', 'step-3', 'next'),
    '/runtimes': ('runtimes-panel', 'connect-panel', 'key-list',
                  'connection-list', 'issued-token'),
    '/memory': ('main-panel', 'memory-list', 'editor-form',
                'search', 'new-title', 'graph-canvas', 'topic-list'),
}


class ShellPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)
    def test_shell_assets_are_served_with_strict_headers(self):
        css = self.raw.call('GET', '/shell/app.css')
        script = self.raw.call('GET', '/shell/app.mjs')
        self.assertEqual(css['status'], 200, css)
        self.assertEqual(script['status'], 200, script)
        self.assertIn('text/css', css['headers']['Content-Type'])
        self.assertIn('javascript', script['headers']['Content-Type'])
        for response in (css, script):
            self.assertIn("default-src 'none'", response['headers']['Content-Security-Policy'])
            self.assertEqual(response['headers']['Cache-Control'], 'no-store')
            self.assertEqual(response['headers']['X-Content-Type-Options'], 'nosniff')
            self.assertLessEqual(len(response['body']), 262144)
        self.assertIn(b'--ot-measure', css['body'])
        self.assertIn(b'[hidden]', css['body'])
        self.assertIn(b'display: none !important', css['body'])
        self.assertIn(b'.skip-link', css['body'])
        self.assertNotIn(b'teamily.com', css['body'].lower())
        self.assertNotIn(b'teamily.com', script['body'].lower())
        self.assertIn(b'export function resolveTheme', script['body'])
        self.assertIn(b'export function startShell', script['body'])
        head = self.raw.call('HEAD', '/shell/app.css')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')
        self.assertEqual(self.raw.call('GET', '/shell/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/../settings_page.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/app.css', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/shell/app.css')['status'], 405)

    def test_management_pages_share_the_shell_and_keep_functional_ids(self):
        for path in PAGES:
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('href="/shell/app.css"', html, path)
            self.assertIn('src="/shell/app.mjs"', html, path)
            self.assertIn('class="skip-link"', html, path)
            self.assertIn('href="#main"', html, path)
            self.assertIn('id="main"', html, path)
            self.assertIn('OpenTeamily / FlyBot', html, path)
            self.assertIn('aria-label="管理导航"', html, path)
            self.assertIn('<nav', html, path)
            self.assertIn('id="status"', html, path)
            self.assertNotIn('teamily.com', html.lower(), path)
            for ident in CAPTURE_IDS[path]:
                self.assertIn(f'id="{ident}"', html, f'{path} missing {ident}')
            self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
            if path == '/runtimes':
                self.assertIn('data-tab="connect"', html)
            if path == '/agents':
                self.assertIn('name="name"', html)
            if path == '/artifacts':
                self.assertIn('textarea', html)
            if path == '/team':
                self.assertIn('<h1>', html)


if __name__ == '__main__':
    unittest.main()
