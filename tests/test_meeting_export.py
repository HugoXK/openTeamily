"""Meeting Markdown export. In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MeetingExportTests(unittest.TestCase):
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
            'POST', f'/v1/workspaces/{self.wid}/meetings',
            {'title': '周会', 'attendees': ['alice', 'bob'], 'summary': '同步进度。',
             'transcript': '大家讨论了排期。',
             'action_items': [{'text': '订会议室', 'owner': 'bob', 'done': True},
                              {'text': '发纪要', 'owner': 'alice'}]},
            {'HTTP_IDEMPOTENCY_KEY': 'meeting-export-create-01'})
        self.assertEqual(created['status'], 201, created)
        self.mid = created['body']['meeting']['id']

    def export(self, client=None):
        return (client or self.alice).call(
            'GET', f'/v1/workspaces/{self.wid}/meetings/{self.mid}/export', parse='raw')

    def test_member_downloads_markdown_with_real_fields(self):
        for client in (self.alice, self.bob):
            response = self.export(client)
            self.assertEqual(response['status'], 200, response)
            headers = dict(response['headers'])
            self.assertEqual(headers['Content-Type'], 'text/markdown; charset=utf-8')
            self.assertEqual(headers['Content-Disposition'],
                             'attachment; filename="meeting-%s.md"' % self.mid)
            self.assertEqual(headers['Cache-Control'], 'no-store')
            text = response['body'].decode('utf-8')
            self.assertIn('# 周会', text)
            self.assertIn('参会人：alice、bob', text)
            self.assertIn('## 摘要\n\n同步进度。', text)
            self.assertIn('## 转写 / 正文\n\n大家讨论了排期。', text)
            self.assertIn('- [x] 订会议室（bob）', text)
            self.assertIn('- [ ] 发纪要（alice）', text)
            self.assertNotIn('workspace_id', text)
            self.assertNotIn('request_hash', text)

    def test_permissions_and_methods(self):
        eve = Client(self.app, peer='127.0.0.3')
        eve.register('eve')
        self.assertEqual(self.export(eve)['status'], 404)
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/meetings/{"0" * 32}/export')['status'], 404)
        self.assertEqual(self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/meetings/{self.mid}/export')['status'], 405)
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/meetings/{self.mid}/export?x=1')['status'], 400)
        other = self.bob.workspace('Bob space', 'bob-workspace-0001')['body']['workspace']['id']
        self.assertEqual(self.bob.call(
            'GET', f'/v1/workspaces/{other}/meetings/{self.mid}/export')['status'], 404)


if __name__ == '__main__':
    unittest.main()
