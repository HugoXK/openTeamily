"""Memory page revision history: preview and non-destructive restore. In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryPageHistoryTests(unittest.TestCase):
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
            'POST', f'/v1/workspaces/{self.wid}/memory', {'title': '笔记', 'body': '第一稿'},
            {'HTTP_IDEMPOTENCY_KEY': 'memory-create-000001'})
        self.assertEqual(created['status'], 201, created)
        self.page = created['body']['page']

    def edit(self, body, title=None, revision=None):
        changes = {'body': body}
        if title is not None:
            changes['title'] = title
        return self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}',
            {'revision': revision if revision is not None else self.page['revision'], 'changes': changes})

    def versions(self, client=None):
        return (client or self.alice).call(
            'GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions')

    def test_three_edits_list_three_previous_versions_newest_first(self):
        for body in ('第二稿', '第三稿', '第四稿'):
            saved = self.edit(body)
            self.assertEqual(saved['status'], 200, saved)
            self.page = saved['body']['page']
        listed = self.versions()
        self.assertEqual(listed['status'], 200, listed)
        revisions = [item['revision'] for item in listed['body']['items']]
        self.assertEqual(revisions, [3, 2, 1])
        self.assertEqual(listed['body']['current'], 4)
        self.assertEqual([item['summary'] for item in listed['body']['items']], ['第三稿', '第二稿', '第一稿'])
        self.assertNotIn('body', listed['body']['items'][0])
        self.assertTrue(listed['body']['items'][0]['created'] > 0)
        self.assertEqual(listed['body']['items'][0]['created_by'], 'alice')

    def test_one_version_can_be_previewed_with_its_full_body(self):
        for body in ('第二稿', '第三稿'):
            self.page = self.edit(body)['body']['page']
        seen = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/1')
        self.assertEqual(seen['status'], 200, seen)
        self.assertEqual(seen['body']['version']['body'], '第一稿')
        self.assertEqual(seen['body']['version']['revision'], 1)
        missing = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/99')
        self.assertEqual(missing['status'], 404, missing)

    def test_restore_creates_a_new_revision_and_keeps_the_old_ones(self):
        for body in ('第二稿', '第三稿', '第四稿'):
            self.page = self.edit(body)['body']['page']
        restored = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/2/restore',
            {'revision': self.page['revision']})
        self.assertEqual(restored['status'], 200, restored)
        self.assertEqual(restored['body']['page']['revision'], 5)
        self.assertEqual(restored['body']['page']['body'], '第二稿')
        history = self.versions()['body']
        self.assertEqual(history['current'], 5)
        self.assertEqual([item['revision'] for item in history['items']], [4, 3, 2, 1])
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/2')['body']['version']['body'], '第二稿')
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}')['body']['page']['body'], '第二稿')

    def test_restore_requires_the_current_revision_and_edit_rights(self):
        self.page = self.edit('第二稿')['body']['page']
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/1/restore', {'revision': 1})
        self.assertEqual(stale['status'], 409, stale)
        forbidden = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/versions/1/restore',
            {'revision': self.page['revision']})
        self.assertEqual(forbidden['status'], 403, forbidden)

    def test_history_is_workspace_scoped_and_deleted_with_the_page(self):
        self.page = self.edit('第二稿')['body']['page']
        other = self.alice.workspace(name='另一个工作区', key='request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{other}/memory/{self.page["id"]}/versions')['status'], 404)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.page["id"]}/remove', {})
        self.assertEqual(self.versions()['status'], 404)


if __name__ == '__main__':
    unittest.main()
