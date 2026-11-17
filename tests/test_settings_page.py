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
        html = page['body'].decode()
        self.assertIn('<h1>设置</h1>', html)
        self.assertIn('id="settings-index"', html)
        self.assertIn('账户与资料', html)
        self.assertIn('AI 与智能体设置', html)
        self.assertIn('偏好与安全', html)
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
        self.assertIn('id="appearance"', html)
        light, dark, auto, system = (html.find(f'value="{name}"') for name in ('light', 'dark', 'auto', 'system'))
        self.assertTrue(-1 < light < dark < auto < system)
        self.assertLess(html.find('始终使用浅色主题。'), html.find('始终使用深色主题。'))
        self.assertIn('没有使用实际日出日落时刻', html)
        self.assertNotIn('name="fold_long_messages"', html)

    def test_overview_maps_existing_settings_and_omits_billing_shells(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        self.assertIn('id="settings-index"', html)
        self.assertIn('href="/profile"', html)
        self.assertIn('href="/settings/language"', html)
        self.assertIn('href="/settings/channels"', html)
        self.assertIn('href="/settings/agent-access"', html)
        self.assertIn('href="#model-api"', html)
        self.assertIn('href="#skill-secrets"', html)
        self.assertIn('href="/settings/connectors"', html)
        self.assertIn('href="/runtimes"', html)
        language = html.find('href="/settings/language"')
        channels = html.find('href="/settings/channels"')
        agent_api = html.find('href="/settings/agent-access"')
        model_api = html.find('href="#model-api"')
        skills = html.find('href="#skill-secrets"')
        connectors = html.find('href="/settings/connectors"')
        runtimes = html.find('href="/runtimes"')
        self.assertTrue(-1 < language < channels < agent_api < model_api < skills < connectors < runtimes)
        self.assertIn('href="/settings/appearance"', html)
        self.assertIn('href="/settings/shortcuts"', html)
        self.assertIn('href="/settings/message-folding"', html)
        self.assertIn('href="/settings/privacy"', html)
        self.assertIn('系统语言', html)
        self.assertIn('始终使用浅色主题。', html)
        self.assertIn('选择长消息在对话里折叠前展示多少内容。', html)
        self.assertIn('保存更改', html)
        self.assertIn('name="link_previews"', html)
        self.assertNotIn('创作赚钱', html)
        self.assertNotIn('积分中心', html)
        self.assertNotIn('套餐与账单', html)
        self.assertNotIn('教育优惠认证', html)
        self.assertNotIn('兑换码', html)
        self.assertNotIn('>升级<', html)
        self.assertNotIn('Teamily Agent', html)
        self.assertNotIn('<img', html)

    def test_recorded_subpages_serve_the_same_settings_shell(self):
        for path in ('/settings/appearance', '/settings/language',
                     '/settings/message-folding', '/settings/privacy',
                     '/settings/shortcuts', '/settings/channels',
                     '/settings/agent-access', '/settings/connectors'):
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('id="settings-index"', html)
            self.assertIn(f'data-settings-page="{path.rsplit("/", 1)[-1]}"', html)
            self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/appearance', query='q=1')['status'], 400)

    def test_channel_agent_api_and_connectors_pages_stay_disabled(self):
        html = self.raw.call('GET', '/settings/channels')['body'].decode()
        self.assertIn('data-settings-page="channels"', html)
        self.assertIn('WeChat Official Account', html)
        self.assertIn('Apple iMessage', html)
        self.assertIn('Slack', html)
        self.assertIn('WhatsApp', html)
        self.assertEqual(html.count('+ 连接'), 4)
        self.assertEqual(html.count('title="未实现：OpenTeamily 还没有接入'), 4)
        self.assertIn('disabled', html)
        self.assertNotIn('Teamily Agent', html)
        agent = self.raw.call('GET', '/settings/agent-access')['body'].decode()
        self.assertIn('你的 agent 还没有向本实例之外开放。', agent)
        self.assertIn('没有已授权的 AI 客户端。', agent)
        self.assertIn('Claude Code', agent)
        connectors = self.raw.call('GET', '/settings/connectors')['body'].decode()
        self.assertIn('placeholder="搜索应用…"', connectors)
        self.assertIn('+ 添加 MCP 服务器', connectors)
        self.assertIn('还没有可连接的应用目录。', connectors)
        self.assertIn('disabled title="未实现：对照里「添加 MCP 服务器」', connectors)
        self.assertNotIn('已连接', connectors)




if __name__ == '__main__':
    unittest.main()
