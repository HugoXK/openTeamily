"""Memory page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class MemoryPageServingTests(unittest.TestCase):
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
        page = self.raw.call('GET', '/memory')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('记忆', html)
        self.assertIn('新建', html)
        self.assertIn('id="dir-collapse"', html)
        self.assertIn('收起侧边栏', html)
        self.assertIn('id="dir-expand"', html)
        self.assertIn('展开侧边栏', html)
        self.assertIn('id="dir-title"', html)
        self.assertIn('+ 新建', html)
        self.assertIn('class="view-icon"', html)
        self.assertIn('placeholder="搜索主题……"', html)
        self.assertIn('下一步行动', html)
        self.assertIn('总览', html)
        self.assertIn('我的资料', html)
        self.assertIn('我的作品', html)
        self.assertIn('href="/space"', html)
        self.assertIn('我的会议', html)
        self.assertIn('href="/space?view=meetings"', html)
        self.assertNotIn('data-view="meetings"', html)
        self.assertNotIn('id="meetings-panel"', html)
        self.assertNotIn('<button type="button" data-view="meetings"', html)
        self.assertIn('话题亮点', html)
        self.assertIn('未实现', html)
        self.assertIn('尚未自动注入模型', html)
        self.assertIn('id="memory-profile-form"', html)
        self.assertIn('做梦', html)
        self.assertIn('Professional Profile', html)
        self.assertIn('Work Style', html)
        self.assertIn('Communication &amp; Writing Style', html)
        self.assertIn('当前没有可预期的事项。', html)
        self.assertIn('id="new-action-open"', html)
        self.assertIn('id="new-action-form"', html)
        self.assertIn('id="new-action-form" hidden', html)
        css = self.raw.call('GET', '/memory/app.css')['body'].decode()
        self.assertIn('.memory-views a[aria-current="page"]', css)
        self.assertIn('flex-direction: column', css)
        self.assertIn('var(--ot-accent-soft)', css)
        self.assertIn('.dir-title', css)
        self.assertIn('#new-page', css)
        self.assertIn('.view-icon', css)
        self.assertIn('href="/memory?page=profile"', html)
        self.assertIn('href="/memory?page=todos"', html)
        self.assertNotIn('Develops and maintains software', html)
        self.assertNotIn('Teamily Wiki', html)
        self.assertNotIn('Welcome to Teamily', html)
        self.assertIn('已读状态接口', html)
        self.assertIn('data-filter="updated"', html)
        self.assertIn('id="graph-canvas"', html)
        self.assertIn('id="graph-empty"', html)
        self.assertIn('id="graph-empty" class="graph-empty" hidden', html)
        self.assertIn('创建两个或更多记忆页后，这里会把它们连成图谱', html)
        self.assertIn('id="graph-empty-new"', html)
        self.assertIn('新建记忆页', html)
        self.assertIn('class="graph-hint"', html)
        self.assertIn('单击查看 · 双击打开 · 悬停预览', html)
        self.assertIn('id="graph-hover-card"', html)
        self.assertIn('class="graph-hover-title"', html)
        self.assertIn('悬停预览卡的版式未经核实', html)
        self.assertNotIn('尚未实现这些手势', html)
        self.assertIn('id="topic-list"', html)
        self.assertIn('id="memory-list"', html)
        self.assertIn('id="action-list"', html)
        self.assertIn('id="overview-panel"', html)
        self.assertIn('data-view="overview"', html)
        self.assertNotIn('id="new-title"', html)
        self.assertIn('id="editor-form"', html)
        self.assertIn('id="action-editor-form"', html)
        self.assertIn('/v1/workspaces', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        self.assertIn("script-src 'self'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        script = self.raw.call('GET', '/memory/app.mjs')
        style = self.raw.call('GET', '/memory/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        self.assertIn('text/javascript', script['headers']['Content-Type'])
        js = script['body'].decode()
        css = style['body'].decode()
        self.assertIn('export function directoryGroups', js)
        self.assertIn('export function applyDirectoryCollapsed', js)
        self.assertIn('export function topicTag', js)
        self.assertIn('export function memoryPageMeta', js)
        self.assertIn('export function graphPreviewModel', js)
        self.assertIn('export function graphEmptyStateVisible', js)
        self.assertIn('GRAPH_EMPTY_MESSAGE', js)
        self.assertIn('export function bindGraphNodeGestures', js)
        self.assertIn('GRAPH_HOVER_DELAY_MS', js)
        self.assertIn('dir-collapse', js)
        self.assertIn('memory-page-link', js)
        self.assertIn('memory-page-preview', js)
        self.assertIn('memory-page-icon', js)
        self.assertIn('memory-topic-group', js)
        self.assertNotIn('Teamily Wiki', js)
        self.assertNotIn('Welcome to Teamily', js)
        self.assertNotIn('Welcome to my wiki', js)
        self.assertIn('memory-topic-group', css)
        self.assertIn('memory-page-meta', css)
        self.assertIn('memory-page-preview', css)
        self.assertIn('memory-page-icon', css)
        self.assertIn('.graph-hint', css)
        self.assertIn('.graph-empty', css)
        self.assertIn('.graph-empty[hidden]', css)
        self.assertIn('.graph-hover-card', css)
        self.assertEqual(self.raw.call('GET', '/memory/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/memory', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/memory', query='q=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory', query='page=overview')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory', query='page=profile&x=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/memory/app.mjs', query='page=profile')['status'], 400)
        for query in ('page=profile', 'page=todos'):
            page = self.raw.call('GET', '/memory', query=query)
            self.assertEqual(page['status'], 200, query)
            self.assertIn('我的资料', page['body'].decode())
        self.assertEqual(self.raw.call('POST', '/memory')['status'], 405)

    def test_wrapper_still_exposes_the_memory_api(self):
        workspace = self.client.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                     {'HTTP_IDEMPOTENCY_KEY': 'memory-page-space-0001'})
        self.assertEqual(workspace['status'], 201, workspace)
        wid = workspace['body']['workspace']['id']
        created = self.client.call(
            'POST', f'/v1/workspaces/{wid}/memory',
            {'title': 'Brief', 'body': 'Hello'},
            {'HTTP_IDEMPOTENCY_KEY': 'memory-page-create-0001'},
        )
        self.assertEqual(created['status'], 201, created)
        listed = self.client.call('GET', f'/v1/workspaces/{wid}/memory')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([item['title'] for item in listed['body']['items']], ['Brief'])

    def test_directory_search_filters_in_place_and_keeps_open_editor(self):
        page = self.raw.call('GET', '/memory')
        html = page['body'].decode()
        self.assertIn('id="search"', html)
        self.assertIn('placeholder="搜索主题……"', html)
        self.assertIn('这个工作区还没有记忆页。', html)
        script = self.raw.call('GET', '/memory/app.mjs')
        source = script['body'].decode()
        self.assertNotIn("addEventListener('input', () => loadWorkspace())", source)
        self.assertIn("addEventListener('input', () => renderDirectory())", source)
        self.assertIn('没有匹配的记忆页。试试其他关键词。', source)
        self.assertIn("event.key !== 'Escape'", source)
        self.assertIn('matchingMemoryPages', source)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/memory_search.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_graph_empty_state_explains_how_to_get_a_graph(self):
        page = self.raw.call('GET', '/memory')
        html = page['body'].decode()
        self.assertIn('id="graph-empty" class="graph-empty" hidden', html)
        self.assertIn('创建两个或更多记忆页后，这里会把它们连成图谱', html)
        js = self.raw.call('GET', '/memory/app.mjs')['body'].decode()
        self.assertIn('export function graphEmptyStateVisible', js)
        self.assertIn("getElementById('graph-empty-new')", js)
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            ['node', '--test', 'tests/memory_graph_empty.test.mjs'],
            cwd=root, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)



if __name__ == '__main__':
    unittest.main()


class MemoryProfileWorkspaceSwitchTests(unittest.TestCase):
    def test_workspace_switch_invalidates_previous_profile_before_loading(self):
        source = (Path(__file__).resolve().parents[1] / 'openteamily/static/memory/app.mjs').read_text()
        handler = source.split("workspaceSelect.addEventListener('change'", 1)[1].split('});', 1)[0]
        self.assertLess(handler.index('invalidateMemoryProfile()'), handler.index('await loadWorkspace()'))
        helper = source.split('function invalidateMemoryProfile()', 1)[1].split('\n  }', 1)[0]
        self.assertIn('profileRevision = null', helper)
        self.assertIn('profileRequest += 1', helper)
        self.assertIn('save.disabled = true', helper)


class MemoryShareTests(unittest.TestCase):
    """Revocable read-only share links for one memory page (issue 288)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.path = Path(self.temp.name) / 'state'
        self.api = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.app = SettingsPage(self.api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')
        self.wid = self.client.workspace('Desk', 'memory-share-space-0001')['body']['workspace']['id']
        self.page = self.make_page(self.client, 'Brief', 'Hello from the brief body.', 'memory-share-page-0001')

    def make_page(self, client, title, body, key):
        created = client.call('POST', f'/v1/workspaces/{self.wid}/memory',
                              {'title': title, 'body': body}, {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['page']

    def share_path(self, page_id=None):
        return f'/v1/workspaces/{self.wid}/memory/{page_id or self.page["id"]}/share'

    def test_shared_link_opens_signed_out_and_revocation_is_immediate(self):
        created = self.client.call('POST', self.share_path())
        self.assertEqual(created['status'], 201, created)
        share = created['body']['share']
        token = share['token']
        self.assertRegex(token, r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(share['path'], '/s/' + token)
        self.assertEqual(share['scope'], 'read')
        self.assertTrue(share['active'])
        opened = self.raw.call('GET', '/s/' + token)
        self.assertEqual(opened['status'], 200, opened)
        html = opened['body'].decode()
        self.assertIn('Brief', html)
        self.assertIn('Hello from the brief body.', html)
        self.assertIn('只读', html)
        self.assertNotIn('id="editor-form"', html)
        self.assertNotIn('保存', html)
        headers = dict(opened['headers'])
        self.assertEqual(headers.get('X-Robots-Tag'), 'noindex, nofollow')
        self.assertIn("default-src 'none'", headers.get('Content-Security-Policy', ''))
        state = self.client.call('GET', self.share_path())
        self.assertEqual(state['status'], 200, state)
        self.assertTrue(state['body']['share']['active'])
        self.assertNotIn('token', state['body']['share'])
        self.assertNotIn('path', state['body']['share'])
        revoked = self.client.call('DELETE', self.share_path())
        self.assertEqual(revoked['status'], 200, revoked)
        self.assertFalse(revoked['body']['share']['active'])
        self.assertTrue(revoked['body']['share']['revoked'])
        self.assertEqual(self.raw.call('GET', '/s/' + token)['status'], 404)
        after = self.client.call('GET', self.share_path())
        self.assertEqual(after['status'], 200)
        self.assertFalse(after['body']['share']['active'])
        self.assertEqual(self.client.call('DELETE', self.share_path())['status'], 404)

    def test_new_link_revokes_the_previous_one(self):
        first = self.client.call('POST', self.share_path())['body']['share']
        second = self.client.call('POST', self.share_path())['body']['share']
        self.assertNotEqual(first['token'], second['token'])
        self.assertEqual(self.raw.call('GET', '/s/' + first['token'])['status'], 404)
        self.assertEqual(self.raw.call('GET', '/s/' + second['token'])['status'], 200)
        state = self.client.call('GET', self.share_path())
        self.assertEqual(state['body']['share']['prefix'], second['prefix'])

    def test_link_carries_only_the_shared_page(self):
        self.make_page(self.client, 'Ledger', 'Secret ledger entry.', 'memory-share-page-0002')
        bob = Client(self.app, peer='127.0.0.2')
        bob.register('bob')
        bob_wid = bob.workspace('Bob desk', 'memory-share-space-0002')['body']['workspace']['id']
        bob_page = bob.call('POST', f'/v1/workspaces/{bob_wid}/memory',
                            {'title': 'Bob notes', 'body': 'Bob private line'},
                            {'HTTP_IDEMPOTENCY_KEY': 'memory-share-page-0003'})['body']['page']
        token = self.client.call('POST', self.share_path())['body']['share']['token']
        html = self.raw.call('GET', '/s/' + token)['body'].decode()
        self.assertIn('Brief', html)
        self.assertNotIn('Ledger', html)
        self.assertNotIn('Secret ledger entry.', html)
        self.assertNotIn('Bob private line', html)
        bob_view = bob.call('GET', '/s/' + token, parse='raw')
        self.assertEqual(bob_view['status'], 200)
        self.assertIn(b'Hello from the brief body.', bob_view['body'])
        self.assertEqual(bob.call('POST', self.share_path())['status'], 404)
        self.assertEqual(bob.call('GET', self.share_path())['status'], 404)
        self.assertEqual(bob.call('DELETE', self.share_path())['status'], 404)
        alice_on_bob = f'/v1/workspaces/{bob_wid}/memory/{bob_page["id"]}/share'
        self.assertEqual(self.client.call('POST', alice_on_bob)['status'], 404)

    def test_only_editors_share_and_writes_need_csrf(self):
        self.assertEqual(self.raw.call('POST', self.share_path())['status'], 401)
        self.assertEqual(self.raw.call('DELETE', self.share_path())['status'], 401)
        self.assertEqual(self.client.call('POST', self.share_path(), csrf=False)['status'], 403)
        self.assertEqual(self.client.call('DELETE', self.share_path(), csrf=False)['status'], 403)
        self.client.call('POST', self.share_path())
        self.assertEqual(self.client.call('DELETE', self.share_path(), csrf=False)['status'], 403)
        self.assertEqual(self.raw.call('GET', self.share_path())['status'], 401)

    def test_invalid_share_requests_are_rejected(self):
        self.assertEqual(self.raw.call('GET', '/s/short')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/s/' + 'a' * 43)['status'], 404)
        self.assertEqual(self.raw.call('GET', '/s/' + 'a' * 43, query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/s/' + 'a' * 43)['status'], 400)
        self.assertEqual(self.client.call('GET', self.share_path() + '?x=1')['status'], 400)
        missing = '/v1/workspaces/{}/memory/{}/share'.format(self.wid, '0' * 32)
        self.assertEqual(self.client.call('GET', missing)['status'], 404)
        self.assertEqual(self.client.call('POST', missing)['status'], 404)
        self.assertEqual(self.client.call('DELETE', missing)['status'], 404)
        unknown_ws = '/v1/workspaces/{}/memory/{}/share'.format('0' * 32, self.page['id'])
        self.assertEqual(self.client.call('GET', unknown_ws)['status'], 404)
        self.assertEqual(self.client.call('POST', self.share_path(), {'viewer': 'x'})['status'], 400)
        deleted = self.client.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/remove', {})
        self.assertEqual(deleted['status'], 200, deleted)
        self.assertEqual(self.client.call('POST', self.share_path())['status'], 404)

    def test_memory_page_wires_the_share_controls(self):
        html = self.raw.call('GET', '/memory')['body'].decode()
        self.assertIn('id="share-memory"', html)
        self.assertIn('id="share-row"', html)
        self.assertIn('id="share-link"', html)
        self.assertIn('id="copy-share-link"', html)
        self.assertIn('id="revoke-share-link"', html)
        self.assertIn('id="share-status"', html)
        self.assertNotIn('未接通：还没有分享记忆页的接口', html)
        self.assertNotRegex(html, r'<button[^>]*id="share-memory"[^>]*disabled')
        script = self.raw.call('GET', '/memory/app.mjs')['body'].decode()
        self.assertIn('export function memorySharePath', script)
        self.assertIn('export function shareRowState', script)
        self.assertIn('/share', script)
