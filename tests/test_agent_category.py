"""Agent directory category field (issue #134 remainder). In-process WSGI + temporary SQLite only."""
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

from openteamily import agents
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AgentCategoryTests(unittest.TestCase):
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

    def create(self, name, key, **extra):
        body = {'name': name, 'summary': '', 'instructions': ''}
        body.update(extra)
        return self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents', body,
                               {'HTTP_IDEMPOTENCY_KEY': key})

    def test_categories_match_the_seventeen_directory_slugs(self):
        self.assertEqual(len(agents.CATEGORIES), 17)
        self.assertEqual(len(set(agents.CATEGORIES)), 17)
        self.assertIn('it-security', agents.CATEGORIES)

    def test_create_with_category_lists_it_and_defaults_to_uncategorized(self):
        tagged = self.create('写作助手', 'agent-category-key-01', category='content-creation')
        self.assertEqual(tagged['status'], 201, tagged)
        self.assertEqual(tagged['body']['agent']['category'], 'content-creation')
        plain = self.create('通用助手', 'agent-category-key-02')
        self.assertEqual(plain['status'], 201, plain)
        self.assertIsNone(plain['body']['agent']['category'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual({row['name']: row['category'] for row in listed['body']['items']},
                         {'写作助手': 'content-creation', '通用助手': None})
        again = self.create('写作助手', 'agent-category-key-01', category='content-creation')
        self.assertEqual(again['status'], 200)
        changed = self.create('写作助手', 'agent-category-key-01', category='sales')
        self.assertEqual(changed['status'], 409)

    def test_update_sets_changes_and_clears_category_with_revision(self):
        item = self.create('研究助手', 'agent-category-key-03')['body']['agent']
        url = f'/v1/workspaces/{self.wid}/agents/{item["id"]}'
        set_ = self.alice.call('POST', url, {'revision': 1, 'category': 'research'})
        self.assertEqual(set_['status'], 200, set_)
        self.assertEqual(set_['body']['agent']['category'], 'research')
        self.assertEqual(set_['body']['agent']['revision'], 2)
        kept = self.alice.call('POST', url, {'revision': 2, 'summary': '查资料'})
        self.assertEqual(kept['body']['agent']['category'], 'research')
        stale = self.alice.call('POST', url, {'revision': 2, 'category': 'sales'})
        self.assertEqual(stale['status'], 409)
        self.assertEqual(self.alice.call('GET', url)['body']['agent']['category'], 'research')
        cleared = self.alice.call('POST', url, {'revision': 3, 'category': None})
        self.assertEqual(cleared['status'], 200, cleared)
        self.assertIsNone(cleared['body']['agent']['category'])
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        alice = Client(restarted)
        alice.cookies = dict(self.alice.cookies)
        alice.call('POST', url, {'revision': 4, 'category': 'design'})
        stored = alice.call('GET', url)
        self.assertEqual(stored['body']['agent']['category'], 'design')

    def test_rejects_unknown_or_malformed_categories(self):
        for value in ('', 'Engineering', 'unknown', 3, ['design'], {'slug': 'design'}):
            bad = self.create('坏类目', 'agent-category-key-bad1', category=value)
            self.assertEqual(bad['status'], 400, (value, bad))
        item = self.create('好类目', 'agent-category-key-04')['body']['agent']
        bad = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
                              {'revision': 1, 'category': 'not-a-category'})
        self.assertEqual(bad['status'], 400)
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['body']['agent']['revision'], 1)

    def test_members_read_but_cannot_change_category(self):
        item = self.create('销售助手', 'agent-category-key-05', category='sales')['body']['agent']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        seen = self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(seen['body']['agent']['category'], 'sales')
        denied = self.bob.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}',
                               {'revision': 1, 'category': 'legal'})
        self.assertEqual(denied['status'], 403)
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')['body']['agent']['category'], 'sales')

    def test_existing_v1_database_gains_the_category_table(self):
        item = self.create('旧库助手', 'agent-category-key-06')['body']['agent']
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_agent_categories')
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        alice = Client(restarted)
        alice.cookies = dict(self.alice.cookies)
        url = f'/v1/workspaces/{self.wid}/agents/{item["id"]}'
        self.assertIsNone(alice.call('GET', url)['body']['agent']['category'])
        self.assertEqual(alice.call('POST', url, {'revision': 1, 'category': 'legal'})['body']['agent']['category'],
                         'legal')

    def test_directory_page_filters_by_category(self):
        root = Path(__file__).resolve().parents[1]
        html = (root / 'openteamily/static/agents/index.html').read_text(encoding='utf-8')
        self.assertEqual(html.count('<select name="category"><option value="">未分类</option></select>'), 2)
        self.assertNotIn('所以选中不会缩小下面的工作区目录', html)
        for name in ('tests/agents_category_filter.test.mjs', 'tests/agents_categories.test.mjs'):
            result = subprocess.run(['node', '--test', name], cwd=root, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
