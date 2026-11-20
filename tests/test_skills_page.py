"""Skills library page serving tests. In-process WSGI only; no skill execution."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class SkillsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_library_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/skills')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('main-panel', 'skills-search', 'skills-list', 'skills-empty'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('技能库', html)
        self.assertIn('校验并加载后才显示加载回执', html)
        self.assertIn('技能包含真实内容和版本摘要', html)
        self.assertIn('id="skills-permission"', html)
        self.assertIn('没有匹配的技能', html)
        self.assertIn('aria-label="搜索技能"', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/skills/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/skills/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/skills', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/skills', query='q=会议')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/skills')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/skills/missing')['status'], 404)
        script = self.raw.call('GET', '/skills/app.mjs')['body'].decode()
        self.assertIn('/v1/skills/catalog', script)
        self.assertIn('/v1/skills/bindings', script)
        self.assertIn('export function filterSkills', script)
        self.assertNotIn('export function toggleSkill', script)
        self.assertIn('!permission.checked', script)
        self.assertIn('csrfCookie(document.cookie)', script)
        self.assertNotIn('innerHTML', script)

    def test_every_shell_page_links_the_skills_entry(self):
        pages = [path.parent.name for path in Path(__file__).absolute().parent.parent.joinpath(
            'openteamily', 'static').glob('*/index.html')]
        self.assertIn('skills', pages)
        for name in pages:
            html = self.raw.call('GET', '/' + name)['body'].decode()
            if 'href="/agents"' not in html:
                continue
            self.assertIn('href="/skills"', html, name)


if __name__ == '__main__':
    unittest.main()
