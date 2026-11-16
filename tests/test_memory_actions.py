"""Workspace next actions. In-process WSGI only; not browser E2E."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryActionTests(unittest.TestCase):
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

    def create_page(self, title='Linked note', body='page', key='memory-create-page-0001'):
        return self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory', {'title': title, 'body': body},
            {'HTTP_IDEMPOTENCY_KEY': key},
        )

    def create(self, client=None, title='Follow up', notes='', due_at=None, memory_page_id=None,
               key='memory-action-create01', csrf=True, origin=None):
        payload = {'title': title, 'notes': notes}
        if due_at is not None:
            payload['due_at'] = due_at
        if memory_page_id is not None:
            payload['memory_page_id'] = memory_page_id
        kw = {'csrf': csrf}
        if origin is not None:
            kw['origin'] = origin
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions', payload,
            {'HTTP_IDEMPOTENCY_KEY': key}, **kw
        )

    def test_create_list_read_edit_complete_and_delete_persist(self):
        page = self.create_page()
        self.assertEqual(page['status'], 201, page)
        page_id = page['body']['page']['id']
        created = self.create(notes='Call back', due_at=1800001000, memory_page_id=page_id)
        self.assertEqual(created['status'], 201, created)
        item = created['body']['action']
        self.assertEqual(item['title'], 'Follow up')
        self.assertEqual(item['notes'], 'Call back')
        self.assertEqual(item['status'], 'open')
        self.assertEqual(item['due_at'], 1800001000)
        self.assertEqual(item['memory_page_id'], page_id)
        self.assertEqual(item['memory_page_title'], 'Linked note')
        self.assertEqual(item['revision'], 1)
        self.assertEqual(item['created_by'], 'alice')
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['title'], 'Follow up')
        self.assertNotIn('notes', listed['body']['items'][0])
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['action']['notes'], 'Call back')
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}',
            {'revision': 1, 'changes': {'status': 'done', 'notes': 'Done today'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['action']['status'], 'done')
        self.assertEqual(saved['body']['action']['notes'], 'Done today')
        self.assertEqual(saved['body']['action']['revision'], 2)
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}',
            {'revision': 1, 'changes': {'title': 'stale'}},
        )
        self.assertEqual(stale['status'], 409)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute(
                'SELECT title, notes, status, due_at, revision FROM memory_actions WHERE id=?',
                (item['id'],),
            ).fetchone()
        self.assertEqual(row, ('Follow up', 'Done today', 'done', 1800001000, 2))
        again = self.create(notes='Call back', due_at=1800001000, memory_page_id=page_id)
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['action']['id'], item['id'])
        # Deleting the page clears the link, not the action.
        removed_page = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/{page_id}/remove', {})
        self.assertEqual(removed_page['status'], 200, removed_page)
        after = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}')
        self.assertEqual(after['status'], 200)
        self.assertIsNone(after['body']['action']['memory_page_id'])
        self.assertIsNone(after['body']['action']['memory_page_title'])
        cleared = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}',
            {'revision': 2, 'changes': {'due_at': None}},
        )
        self.assertEqual(cleared['status'], 200, cleared)
        self.assertIsNone(cleared['body']['action']['due_at'])
        removed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}/remove', {})
        self.assertEqual(removed['status'], 200, removed)
        self.assertEqual(removed['body']['removed']['id'], item['id'])
        self.assertNotIn('notes', removed['body']['removed'])
        self.assertEqual(
            self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions/{item["id"]}')['status'], 404
        )
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertIsNone(db.execute('SELECT id FROM memory_actions WHERE id=?', (item['id'],)).fetchone())

    def test_permissions_isolation_status_filter_and_search(self):
        created = self.create()
        action_id = created['body']['action']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/memory/actions')['status'], 200)
        self.assertEqual(
            self.bob.call('GET', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}')['status'], 200
        )
        denied = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}',
            {'revision': 1, 'changes': {'status': 'done'}},
        )
        self.assertEqual(denied['status'], 403)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}/remove', {})['status'],
            403,
        )
        bob_action = self.create(self.bob, title="Bob's task", notes='From bob', key='memory-action-bob-0001')
        self.assertEqual(bob_action['status'], 201, bob_action)
        self.assertEqual(
            self.bob.call(
                'POST', f'/v1/workspaces/{self.wid}/memory/actions/{bob_action["body"]["action"]["id"]}',
                {'revision': 1, 'changes': {'notes': 'Bob edited'}},
            )['status'],
            200,
        )
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/memory/actions')['status'], 404)
        self.assertEqual(
            outsider.call('GET', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}')['status'], 404
        )
        self.assertEqual(
            outsider.call(
                'POST', f'/v1/workspaces/{self.wid}/memory/actions', {'title': 'Nope'},
                {'HTTP_IDEMPOTENCY_KEY': 'memory-action-carol001'},
            )['status'],
            404,
        )
        other = self.alice.workspace(name='Other', key='request_example_0002')
        other_id = other['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other_id}/memory/actions')['status'], 404)
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?q=bob')
        self.assertEqual([item['title'] for item in found['body']['items']], ["Bob's task"])
        open_items = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?status=open')
        self.assertEqual({item['title'] for item in open_items['body']['items']}, {'Follow up', "Bob's task"})
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}',
            {'revision': 1, 'changes': {'status': 'done'}},
        )
        done_items = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?status=done')
        self.assertEqual([item['title'] for item in done_items['body']['items']], ['Follow up'])
        missing = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?q=missing-term')
        self.assertEqual(missing['body']['items'], [])
        self.assertEqual(
            self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?status=archived')['status'], 400
        )

    def test_search_paginates_matching_titles(self):
        for i in range(25):
            self.assertEqual(
                self.create(title=f'Pad {i:02d}', notes=f'pad {i}', key=f'memory-act-pad-{i:02d}xx')['status'],
                201,
            )
        for i, title in enumerate(('跟进事项甲', '跟进事项乙', '跟进事项丙', '其他记录')):
            self.assertEqual(
                self.create(title=title, notes='zh', key=f'memory-act-zh-{i:02d}xxxx')['status'], 201
            )
        page = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?q=跟进事项&limit=2')
        self.assertEqual(page['status'], 200)
        titles = [item['title'] for item in page['body']['items']]
        self.assertEqual(len(titles), 2)
        self.assertTrue(set(titles) <= {'跟进事项甲', '跟进事项乙', '跟进事项丙'})
        self.assertIsNotNone(page['body']['cursor'])
        later = self.alice.call(
            'GET',
            f'/v1/workspaces/{self.wid}/memory/actions?q=跟进事项&limit=2&cursor={page["body"]["cursor"]}',
        )
        self.assertEqual(later['status'], 200)
        combined = titles + [item['title'] for item in later['body']['items']]
        self.assertEqual(set(combined), {'跟进事项甲', '跟进事项乙', '跟进事项丙'})
        self.assertIsNone(later['body']['cursor'])
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory/actions?q=Pad 24&limit=5')
        self.assertEqual(found['status'], 200)
        self.assertEqual([item['title'] for item in found['body']['items']], ['Pad 24'])
        self.assertIsNone(found['body']['cursor'])
        filtered = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/memory/actions?q=跟进事项&status=open&limit=2'
        )
        self.assertEqual(filtered['status'], 200)
        self.assertEqual(len(filtered['body']['items']), 2)

    def test_rejects_csrf_quota_bad_links_and_keeps_schema_v1(self):
        self.assertEqual(self.create(csrf=False)['status'], 403)
        self.assertEqual(self.create(origin='https://evil.test', key='memory-action-create02')['status'], 403)
        self.assertEqual(self.create(title='')['status'], 400)
        self.assertEqual(self.create(due_at=-1, key='memory-action-create03')['status'], 400)
        self.assertEqual(self.create(due_at=True, key='memory-action-create04')['status'], 400)
        self.assertEqual(self.create(memory_page_id='not-a-page-id-at-allxxxx', key='memory-action-create05')['status'], 400)
        missing = self.create(memory_page_id='ab' * 16, key='memory-action-create06')
        self.assertEqual(missing['status'], 400, missing)
        other = self.alice.workspace(name='Other desk', key='request_example_0003')
        other_id = other['body']['workspace']['id']
        foreign = self.alice.call(
            'POST', f'/v1/workspaces/{other_id}/memory', {'title': 'Elsewhere', 'body': ''},
            {'HTTP_IDEMPOTENCY_KEY': 'memory-create-other-0001'},
        )
        self.assertEqual(foreign['status'], 201, foreign)
        crossed = self.create(
            memory_page_id=foreign['body']['page']['id'], key='memory-action-create07'
        )
        self.assertEqual(crossed['status'], 400, crossed)
        self.app.config = replace(self.app.config, max_memory_actions_per_workspace=1)
        first = self.create()
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(self.create(title='Second', key='memory-action-create08')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE memory_actions')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='memory_actions'").fetchone())
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='memory_pages'").fetchone())

    def test_owner_can_edit_member_action_and_idempotency_conflicts(self):
        created = self.create(self.bob, title='Shared task', notes='v1', key='memory-action-bob-0002')
        action_id = created['body']['action']['id']
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/actions/{action_id}',
            {'revision': 1, 'changes': {'title': 'Shared by owner', 'status': 'done'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['action']['title'], 'Shared by owner')
        self.assertEqual(saved['body']['action']['status'], 'done')
        self.assertEqual(saved['body']['action']['updated_by'], 'alice')
        reused = self.create(title='Other', notes='x', key='memory-action-bob-0002')
        self.assertEqual(reused['status'], 409, reused)
        same_title = self.create(title='Shared by owner', notes='also', key='memory-action-create09')
        self.assertEqual(same_title['status'], 201, same_title)


if __name__ == '__main__':
    unittest.main()
