"""Skills library page and install-state tests. In-process WSGI only; no skill runs."""
from pathlib import Path
import re
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
        self.api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.app = SettingsPage(self.api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_library_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/skills')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('main-panel', 'skills-search', 'skills-list', 'skills-empty', 'skills-error'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('技能库', html)
        self.assertIn('安装状态保存在你的账户里', html)
        self.assertIn('未登录', html)
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
        self.assertIn('export const SKILLS', script)
        self.assertIn('export function filterSkills', script)
        self.assertIn('/v1/skills/installed', script)
        self.assertIn('X-CSRF-Token', script)
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

    def test_the_server_catalogue_matches_the_page_catalogue(self):
        from openteamily import skill_installs
        script = Path(__file__).absolute().parent.parent.joinpath(
            'openteamily', 'static', 'skills', 'app.mjs').read_text(encoding='utf-8')
        ids = re.findall(r"\{id: '([a-z0-9-]+)'", script)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sorted(ids), sorted(skill_installs.SKILL_IDS))

    def test_install_round_trips_and_survives_a_fresh_app(self):
        installed = self.client.call('POST', '/v1/skills/installed', {'skill': 'meeting-notes'})
        self.assertEqual(installed['status'], 200)
        self.assertEqual(installed['body'], {'installed': ['meeting-notes']})
        self.assertEqual(self.client.call('POST', '/v1/skills/installed',
                                          {'skill': 'meeting-notes'})['body'],
                         {'installed': ['meeting-notes']})
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['meeting-notes']})
        # A reload, a new process or a new session must still see the row.
        restarted = Client(App(self.api.store, self.api.config, clock=lambda: 1800000000))
        restarted.cookies = dict(self.client.cookies)
        self.assertEqual(restarted.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['meeting-notes']})
        removed = self.client.call('DELETE', '/v1/skills/installed', {'skill': 'meeting-notes'})
        self.assertEqual(removed['status'], 200)
        self.assertEqual(removed['body'], {'installed': []})
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'], {'installed': []})

    def test_installs_are_scoped_to_the_session_user(self):
        self.client.call('POST', '/v1/skills/installed', {'skill': 'meeting-notes'})
        other = Client(self.app)
        other.register('bob')
        self.assertEqual(other.call('GET', '/v1/skills/installed')['body'], {'installed': []})
        other.call('POST', '/v1/skills/installed', {'skill': 'trip-plan'})
        self.assertEqual(other.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['trip-plan']})
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['meeting-notes']})
        # Bob cannot uninstall Alice's row: his delete names his own account.
        other.call('DELETE', '/v1/skills/installed', {'skill': 'meeting-notes'})
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['meeting-notes']})

    def test_signed_out_calls_are_rejected_and_write_nothing(self):
        anonymous = Client(self.app)
        for method, body in (('GET', None), ('POST', {'skill': 'meeting-notes'}),
                             ('DELETE', {'skill': 'meeting-notes'})):
            response = anonymous.call(method, '/v1/skills/installed', body)
            self.assertEqual(response['status'], 401, method)
            self.assertEqual(response['body']['error']['code'], 'unauthorized')
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'], {'installed': []})

    def test_unknown_skills_and_malformed_requests_get_a_reason(self):
        for body in ({'skill': 'not-a-skill'}, {'skill': ''}, {}, {'skill': 'meeting-notes', 'x': 1}):
            response = self.client.call('POST', '/v1/skills/installed', body)
            self.assertEqual(response['status'], 400)
            self.assertEqual(response['body']['error']['code'], 'invalid')
            self.assertTrue(response['body']['error']['message'])
        self.assertEqual(self.client.call('POST', '/v1/skills/installed?x=1',
                                          {'skill': 'meeting-notes'})['status'], 400)
        self.assertEqual(self.client.call('GET', '/v1/skills/installed?x=1')['status'], 400)
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'], {'installed': []})

    def test_writes_require_csrf_and_same_origin(self):
        self.assertEqual(self.client.call('POST', '/v1/skills/installed',
                                          {'skill': 'meeting-notes'}, csrf=False)['status'], 403)
        self.client.call('POST', '/v1/skills/installed', {'skill': 'meeting-notes'})
        self.assertEqual(self.client.call('DELETE', '/v1/skills/installed',
                                          {'skill': 'meeting-notes'}, csrf=False)['status'], 403)
        self.assertEqual(self.client.call('DELETE', '/v1/skills/installed',
                                          {'skill': 'meeting-notes'},
                                          origin='https://evil.test')['status'], 403)
        self.assertEqual(self.client.call('GET', '/v1/skills/installed')['body'],
                         {'installed': ['meeting-notes']})
        # The DELETE exemption is one path only; every other route still refuses it.
        self.assertEqual(self.client.call('DELETE', '/v1/settings')['status'], 405)


if __name__ == '__main__':
    unittest.main()
