"""Workspace agent directory tests (issue #6). In-process WSGI + temporary SQLite only."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AgentDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']

    def create(self, client, name='文档助手', summary='整理笔记', instructions='先列出要点。',
               key=None, wid=None, **kw):
        key = key or ('agent-create-key-' + name.encode('utf-8').hex()[:16]).ljust(20, 'x')[:64]
        return client.call(
            'POST', f'/v1/workspaces/{wid or self.wid}/agents',
            {'name': name, 'summary': summary, 'instructions': instructions},
            {'HTTP_IDEMPOTENCY_KEY': key}, **kw)

    def test_create_list_get_and_update_persist(self):
        created = self.create(self.alice)
        self.assertEqual(created['status'], 201, created)
        item = created['body']['agent']
        self.assertEqual(item['name'], '文档助手')
        self.assertEqual(item['summary'], '整理笔记')
        self.assertEqual(item['instructions'], '先列出要点。')
        self.assertEqual(item['revision'], 1)
        self.assertEqual(item['archived'], 0)
        self.assertNotIn('token', item)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['name'] for row in listed['body']['items']], ['文档助手'])
        self.assertIsNone(listed['body']['cursor'])
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['agent'], item)
        updated = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
            {'revision': 1, 'instructions': '先核对事实，再写摘要。'})
        self.assertEqual(updated['status'], 200, updated)
        self.assertEqual(updated['body']['agent']['revision'], 2)
        self.assertEqual(updated['body']['agent']['instructions'], '先核对事实，再写摘要。')
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        alice = Client(restarted)
        alice.cookies = dict(self.alice.cookies)
        stored = alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(stored['body']['agent']['instructions'], '先核对事实，再写摘要。')
        self.assertEqual(stored['body']['agent']['revision'], 2)

    def test_idempotent_create_and_name_conflict(self):
        first = self.create(self.alice, key='agent-idempotency-01')
        again = self.create(self.alice, key='agent-idempotency-01')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['agent'], first['body']['agent'])
        clash = self.create(self.alice, name='文档助手', key='agent-idempotency-02')
        self.assertEqual(clash['status'], 409)
        other = self.create(self.alice, name='文档助手', summary='另一份说明', key='agent-idempotency-01')
        self.assertEqual(other['status'], 409)

    def test_members_can_read_but_not_write_and_outsiders_get_404(self):
        item = self.create(self.alice)['body']['agent']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents')['status'], 404)
        self.assertEqual(self.create(self.bob, key='agent-outsider-key-01')['status'], 404)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents')['status'], 200)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['status'], 200)
        denied = self.create(self.bob, name='成员新建', key='agent-member-create-01')
        self.assertEqual(denied['status'], 403)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
                          {'revision': 1, 'summary': '改掉'})['status'], 403)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive',
                          {'revision': 1})['status'], 403)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/agents')['status'], 404)
        self.assertEqual(
            self.carol.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['status'], 404)

    def test_admin_can_create_and_directory_does_not_leak(self):
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'admin'})
        created = self.create(self.bob, name='管理员助手', key='agent-admin-create-01')
        self.assertEqual(created['status'], 201, created)
        other = self.alice.workspace('第二个工作区', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other}/agents')['status'], 404)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual([row['workspace_id'] for row in listed['body']['items']], [self.wid])

    def test_archive_hides_from_default_list_and_members(self):
        item = self.create(self.alice)['body']['agent']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200)
        self.assertEqual(archived['body']['agent']['archived'], 1)
        self.assertEqual(archived['body']['agent']['revision'], 2)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual(listed['body']['items'], [])
        self.assertEqual(
            self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['status'], 200)
        self.assertEqual(
            self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['status'], 404)
        hidden = self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents?include_archived=1')
        self.assertEqual(hidden['status'], 403)
        shown = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents?include_archived=1')
        self.assertEqual([row['id'] for row in shown['body']['items']], [item['id']])
        again = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 2})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['agent']['revision'], 2)
        # Archived names still occupy the unique name.
        self.assertEqual(self.create(self.alice, key='agent-reuse-name-0001')['status'], 409)

    def test_restore_puts_an_archived_agent_back_in_the_default_list(self):
        item = self.create(self.alice)['body']['agent']
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 1})
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.assertEqual(self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/restore', {'revision': 2})['status'], 403)
        restored = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/restore', {'revision': 2})
        self.assertEqual(restored['status'], 200, restored)
        self.assertEqual(restored['body']['agent']['archived'], 0)
        self.assertEqual(restored['body']['agent']['revision'], 3)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual([row['id'] for row in listed['body']['items']], [item['id']])
        again = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/restore', {'revision': 3})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['agent']['revision'], 3)
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 2})
        self.assertEqual(stale['status'], 409)

    def test_stale_revision_and_validation(self):
        item = self.create(self.alice)['body']['agent']
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
            {'revision': 1, 'summary': '一次'})
        self.assertEqual(stale['status'], 200)
        conflict = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
            {'revision': 1, 'summary': '二次'})
        self.assertEqual(conflict['status'], 409)
        self.assertEqual(self.create(self.alice, name=' ', key='agent-invalid-name-01')['status'], 400)
        self.assertEqual(
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents',
                            {'name': '缺键', 'summary': 'x'})['status'], 400)
        self.assertEqual(
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
                            {'revision': 2})['status'], 400)
        self.assertEqual(
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
                            {'revision': 2, 'owner_id': 'x', 'summary': 'nope'})['status'], 400)

    def test_requires_session_csrf_origin_and_idempotency_key(self):
        anonymous = Client(self.app)
        self.assertEqual(anonymous.call('GET', f'/v1/workspaces/{self.wid}/agents')['status'], 401)
        self.assertEqual(self.create(anonymous, key='agent-anon-create-01')['status'], 401)
        self.assertEqual(self.create(self.alice, csrf=False, key='agent-csrf-missing-01')['status'], 403)
        self.assertEqual(
            self.create(self.alice, origin='https://evil.test', key='agent-evil-origin-01')['status'], 403)
        missing = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents',
                                  {'name': '无幂等键', 'summary': '', 'instructions': ''})
        self.assertEqual(missing['status'], 400)

    def test_pagination_quota_and_existing_v1_database(self):
        ids = []
        for index in range(3):
            name = f'助手{index}'
            item = self.create(self.alice, name=name, key=f'agent-page-key-{index:04}')
            self.assertEqual(item['status'], 201, item)
            ids.append(item['body']['agent']['id'])
        page = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents?limit=2')
        self.assertEqual(len(page['body']['items']), 2)
        self.assertEqual(page['body']['cursor'], page['body']['items'][-1]['id'])
        rest = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/agents?limit=2&cursor={page["body"]["cursor"]}')
        self.assertEqual(len(rest['body']['items']), 1)
        self.assertIsNone(rest['body']['cursor'])
        self.assertEqual({row['id'] for row in page['body']['items'] + rest['body']['items']}, set(ids))
        self.app.config = replace(self.app.config, max_agents_per_workspace=3)
        self.assertEqual(self.create(self.alice, name='超额', key='agent-quota-key-0001')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_agents')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(
                db.execute("SELECT name FROM sqlite_master WHERE name='workspace_agents'").fetchone())


if __name__ == '__main__':
    unittest.main()
