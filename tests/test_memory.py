"""Workspace memory pages. In-process WSGI only; not browser E2E."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def create(self, client=None, title='Notes', body='First draft.', key='memory-create-000001', csrf=True, origin=None):
        kw = {'csrf': csrf}
        if origin is not None:
            kw['origin'] = origin
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/memory', {'title': title, 'body': body},
            {'HTTP_IDEMPOTENCY_KEY': key}, **kw
        )

    def test_create_list_read_edit_and_delete_persist_in_sqlite(self):
        created = self.create(body='')
        self.assertEqual(created['status'], 201, created)
        item = created['body']['page']
        self.assertEqual(item['title'], 'Notes')
        self.assertEqual(item['body'], '')
        self.assertEqual(item['revision'], 1)
        self.assertEqual(item['created_by'], 'alice')
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['title'], 'Notes')
        self.assertNotIn('body', listed['body']['items'][0])
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['page']['body'], '')
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{item["id"]}',
            {'revision': 1, 'changes': {'body': 'Revised draft.'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['page']['body'], 'Revised draft.')
        self.assertEqual(saved['body']['page']['revision'], 2)
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{item["id"]}',
            {'revision': 1, 'changes': {'body': 'stale'}},
        )
        self.assertEqual(stale['status'], 409)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute('SELECT title, body, revision FROM memory_pages WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row, ('Notes', 'Revised draft.', 2))
        again = self.create(body='')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['page']['id'], item['id'])
        removed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/{item["id"]}/remove', {})
        self.assertEqual(removed['status'], 200, removed)
        self.assertEqual(removed['body']['removed']['id'], item['id'])
        self.assertNotIn('body', removed['body']['removed'])
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/{item["id"]}')['status'], 404)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertIsNone(db.execute('SELECT id FROM memory_pages WHERE id=?', (item['id'],)).fetchone())

    def test_permissions_isolation_and_search(self):
        created = self.create()
        page_id = created['body']['page']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/memory')['status'], 200)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/memory/{page_id}')['status'], 200)
        denied = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{page_id}',
            {'revision': 1, 'changes': {'body': 'bob rewrite'}},
        )
        self.assertEqual(denied['status'], 403)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/memory/{page_id}/remove', {})['status'], 403
        )
        bob_page = self.create(self.bob, title="Bob's note", body='From bob', key='memory-create-bob-0001')
        self.assertEqual(bob_page['status'], 201, bob_page)
        self.assertEqual(
            self.bob.call(
                'POST', f'/v1/workspaces/{self.wid}/memory/{bob_page["body"]["page"]["id"]}',
                {'revision': 1, 'changes': {'body': 'Bob edited'}},
            )['status'],
            200,
        )
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/memory')['status'], 404)
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/memory/{page_id}')['status'], 404)
        self.assertEqual(
            outsider.call('POST', f'/v1/workspaces/{self.wid}/memory', {'title': 'Nope', 'body': 'x'},
                          {'HTTP_IDEMPOTENCY_KEY': 'memory-create-carol001'})['status'],
            404,
        )
        other = self.alice.workspace(name='Other', key='request_example_0002')
        other_id = other['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other_id}/memory')['status'], 404)
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory?q=bob')
        self.assertEqual([item['title'] for item in found['body']['items']], ["Bob's note"])
        missing = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory?q=missing-term')
        self.assertEqual(missing['body']['items'], [])

    def test_search_paginates_matching_titles(self):
        for i in range(25):
            self.assertEqual(
                self.create(title=f'Pad {i:02d}', body=f'pad {i}', key=f'memory-pad-{i:02d}-keyxx')['status'],
                201,
            )
        for i, title in enumerate(('工作笔记甲', '工作笔记乙', '工作笔记丙', '其他记录')):
            self.assertEqual(
                self.create(title=title, body='zh', key=f'memory-zh-{i:02d}-keyxxxx')['status'], 201
            )
        page = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory?q=工作笔记&limit=2')
        self.assertEqual(page['status'], 200)
        titles = [item['title'] for item in page['body']['items']]
        self.assertEqual(len(titles), 2)
        self.assertTrue(set(titles) <= {'工作笔记甲', '工作笔记乙', '工作笔记丙'})
        self.assertIsNotNone(page['body']['cursor'])
        later = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory?q=工作笔记&limit=2&cursor={page["body"]["cursor"]}'
        )
        self.assertEqual(later['status'], 200)
        combined = titles + [item['title'] for item in later['body']['items']]
        self.assertEqual(set(combined), {'工作笔记甲', '工作笔记乙', '工作笔记丙'})
        self.assertIsNone(later['body']['cursor'])
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory?q=Pad 24&limit=5')
        self.assertEqual(found['status'], 200)
        self.assertEqual([item['title'] for item in found['body']['items']], ['Pad 24'])
        self.assertIsNone(found['body']['cursor'])

    def test_rejects_csrf_quota_and_keeps_schema_v1(self):
        self.assertEqual(self.create(csrf=False)['status'], 403)
        self.assertEqual(self.create(origin='https://evil.test', key='memory-create-000002')['status'], 403)
        self.assertEqual(self.create(title='')['status'], 400)
        self.app.config = replace(self.app.config, max_memory_pages_per_workspace=1)
        first = self.create()
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(self.create(title='Second', key='memory-create-000003')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE memory_pages')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='memory_pages'").fetchone())

    def test_owner_can_edit_member_page_and_duplicate_titles_conflict(self):
        created = self.create(self.bob, title='Shared', body='v1', key='memory-create-bob-0002')
        page_id = created['body']['page']['id']
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{page_id}',
            {'revision': 1, 'changes': {'title': 'Shared by owner', 'body': 'v2'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['page']['title'], 'Shared by owner')
        self.assertEqual(saved['body']['page']['updated_by'], 'alice')
        self.create(title='Taken', body='a', key='memory-create-000004')
        conflict = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{page_id}',
            {'revision': 2, 'changes': {'title': 'Taken'}},
        )
        self.assertEqual(conflict['status'], 409)
        self.assertEqual(self.create(title='taken', body='b', key='memory-create-000005')['status'], 409)
        reused = self.create(title='Other', body='x', key='memory-create-bob-0002')
        self.assertEqual(reused['status'], 409, reused)


if __name__ == '__main__':
    unittest.main()
