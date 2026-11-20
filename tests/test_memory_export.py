"""Memory page Markdown export. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory',
            {'title': '季度计划', 'body': '第一稿\n\n- 一点', 'topics': ['产品', '设计']},
            {'HTTP_IDEMPOTENCY_KEY': 'memory-export-0001'},
        )
        self.assertEqual(created['status'], 201, created)
        self.page = created['body']['page']

    def export(self, client=None, workspace=None, page=None, path=None):
        target = path or f'/v1/workspaces/{workspace or self.wid}/memory/{page or self.page["id"]}/export'
        return (client or self.alice).call('GET', target, parse='raw')

    def test_export_returns_a_markdown_attachment_with_front_matter(self):
        result = self.export()
        self.assertEqual(result['status'], 200, result)
        headers = dict(result['headers'])
        self.assertEqual(headers['Content-Type'], 'text/markdown; charset=utf-8')
        disposition = headers['Content-Disposition']
        self.assertTrue(disposition.startswith('attachment;'), disposition)
        self.assertIn('filename="memory.md"', disposition)
        self.assertIn("filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E8%AE%A1%E5%88%92.md", disposition)
        self.assertIn("default-src 'none'", headers['Content-Security-Policy'])
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        document = result['body'].decode('utf-8')
        front, marker, body = document.partition('\n---\n')
        self.assertTrue(document.startswith('---\n'), document)
        self.assertEqual(marker, '\n---\n')
        self.assertIn('title: "季度计划"', front)
        self.assertIn('  - "产品"', front)
        self.assertIn('  - "设计"', front)
        self.assertIn('revision: 1', front)
        self.assertIn('updated: 2027-01-15T08:00:00Z', front)
        self.assertEqual(body.lstrip('\n'), '第一稿\n\n- 一点\n')

    def test_export_is_workspace_scoped_and_needs_a_session(self):
        anonymous = Client(self.app, peer='127.0.0.3')
        self.assertEqual(self.export(client=anonymous)['status'], 401)
        self.assertIn(b'"unauthorized"', self.export(client=anonymous)['body'])
        self.assertEqual(self.export(client=self.bob)['status'], 200)
        other = self.bob.workspace(name='另一个工作区', key='request_export_0001')['body']['workspace']['id']
        self.assertEqual(self.export(client=self.bob, workspace=other)['status'], 404)
        self.assertEqual(self.export(workspace='f' * 32)['status'], 404)
        self.assertEqual(self.export(page='f' * 32)['status'], 404)

    def test_export_refuses_writes_and_unknown_queries(self):
        posted = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/export', {})
        self.assertEqual(posted['status'], 405, posted)
        queried = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/export?download=1')
        self.assertEqual(queried['status'], 400, queried)
        unknown = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/export/remove', {})
        self.assertEqual(unknown['status'], 404, unknown)

    def test_export_escapes_the_title_and_keeps_the_body_verbatim(self):
        body = '---\n标题: 假前言\n\n第一行  \r\n第二行\n\n---\n'
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory',
            {'title': '他说"引用"和\\反斜杠', 'body': body, 'topics': []},
            {'HTTP_IDEMPOTENCY_KEY': 'memory-export-0002'},
        )
        self.assertEqual(created['status'], 201, created)
        result = self.export(page=created['body']['page']['id'])
        self.assertEqual(result['status'], 200, result)
        self.assertIn('filename="memory.md"', dict(result['headers'])['Content-Disposition'])
        document = result['body'].decode('utf-8')
        front, _marker, rest = document.partition('\n---\n')
        self.assertIn('title: "他说\\"引用\\"和\\\\反斜杠"', front)
        self.assertIn('topics: []', front)
        self.assertEqual(rest.lstrip('\n'), body)

    def test_export_reflects_the_latest_revision_without_writing_one(self):
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}',
            {'revision': 1, 'changes': {'body': '第二稿', 'topics': ['运维']}},
        )
        self.assertEqual(saved['status'], 200, saved)
        document = self.export()['body'].decode('utf-8')
        self.assertIn('revision: 2', document)
        self.assertIn('  - "运维"', document)
        self.assertTrue(document.rstrip('\n').endswith('第二稿'), document)
        again = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}')
        self.assertEqual(again['body']['page']['revision'], 2)


if __name__ == '__main__':
    unittest.main()
