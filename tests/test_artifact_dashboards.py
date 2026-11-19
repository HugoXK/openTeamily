"""Structured dashboards in the works library (issue #90, dashboard slice). In-process WSGI."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


def dashboard():
    return {'schema': 'openteamily.dashboard.v1', 'widgets': [
        {'type': 'metric', 'title': '预算', 'value': '2400 元', 'note': '三人两天'},
        {'type': 'table', 'title': '行程', 'columns': ['时间', '安排'],
         'rows': [['周六上午', '西湖'], ['周日下午', '返程']]},
        {'type': 'bar', 'title': '花费', 'labels': ['住宿', '餐饮', '门票'], 'values': [1200, 600, 600]},
    ]}


class ArtifactDashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def base(self, artifact_id=''):
        return f'/v1/workspaces/{self.wid}/artifacts{("/" + artifact_id) if artifact_id else ""}'

    def create(self, client=None, title='旅行看板', value=None, key='artifact-dash-0001'):
        return (client or self.alice).call(
            'POST', self.base(),
            {'title': title, 'kind': 'dashboard', 'dashboard': value if value is not None else dashboard()},
            {'HTTP_IDEMPOTENCY_KEY': key})

    def test_create_read_update_and_export(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'dashboard')
        self.assertEqual([w['type'] for w in item['dashboard']['widgets']], ['metric', 'table', 'bar'])
        self.assertEqual(item['dashboard']['widgets'][0]['value'], '2400 元')
        seen = self.alice.call('GET', self.base(item['id']))
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['artifact']['dashboard']['widgets'][1]['rows'][0], ['周六上午', '西湖'])
        listed = self.alice.call('GET', self.base())
        self.assertEqual(listed['body']['items'][0]['kind'], 'dashboard')
        self.assertNotIn('dashboard', listed['body']['items'][0])
        saved = self.alice.call('POST', self.base(item['id']), {
            'revision': 1,
            'changes': {'title': '旅行看板 v2', 'dashboard': {
                'schema': 'openteamily.dashboard.v1',
                'widgets': [{'type': 'metric', 'title': '预算', 'value': '2600 元'}]}},
        })
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['artifact']['revision'], 2)
        self.assertEqual(saved['body']['artifact']['dashboard']['widgets'][0]['value'], '2600 元')
        stale = self.alice.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'dashboard': dashboard()},
        })
        self.assertEqual(stale['status'], 409)
        exported = self.alice.call('GET', self.base(item['id']) + '/export', parse='raw')
        self.assertEqual(exported['status'], 200)
        html = exported['body'].decode()
        self.assertIn('旅行看板 v2', html)
        self.assertIn('2600 元', html)
        self.assertIn('text/html', dict(exported['headers'])['Content-Type'])
        preview = self.alice.call('GET', self.base(item['id']) + '/preview', parse='raw')
        self.assertEqual(preview['status'], 200)
        self.assertIn('2600 元', preview['body'].decode())

    def test_versions_restore_and_share(self):
        created = self.create()
        item = created['body']['artifact']
        self.alice.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'dashboard': {
                'schema': 'openteamily.dashboard.v1',
                'widgets': [{'type': 'metric', 'title': '新', 'value': '1'}]}},
        })
        versions = self.alice.call('GET', self.base(item['id']) + '/versions')
        self.assertEqual([row['kind'] for row in versions['body']['items']], ['dashboard', 'dashboard'])
        first = self.alice.call('GET', self.base(item['id']) + '/versions/1')
        self.assertEqual(first['body']['version']['kind'], 'dashboard')
        self.assertEqual(first['body']['version']['dashboard']['widgets'][0]['value'], '2400 元')
        version_export = self.alice.call('GET', self.base(item['id']) + '/versions/1/export', parse='raw')
        self.assertIn('三人两天', version_export['body'].decode())
        restored = self.alice.call('POST', self.base(item['id']) + '/restore', {'revision': 2, 'to': 1})
        self.assertEqual(restored['status'], 200, restored)
        self.assertEqual(restored['body']['artifact']['dashboard']['widgets'][0]['value'], '2400 元')
        same = self.alice.call('POST', self.base(item['id']) + '/restore', {'revision': 3, 'to': 1})
        self.assertEqual(same['status'], 200)
        self.assertEqual(same['body']['artifact']['revision'], 3)
        shared = self.alice.call('POST', self.base(item['id']) + '/shares', {})
        self.assertEqual(shared['status'], 201, shared)
        anon = Client(self.app, peer='127.0.0.9')
        page = anon.call('GET', shared['body']['share']['path'], parse='raw', csrf=False, origin=None)
        self.assertEqual(page['status'], 200)
        self.assertIn('西湖', page['body'].decode())

    def test_validation_and_permissions(self):
        bad = [
            {'schema': 'openteamily.dashboard.v1', 'widgets': []},
            {'schema': 'openteamily.dashboard.v1', 'widgets': [{'type': 'pie', 'title': 'x'}]},
            {'schema': 'openteamily.dashboard.v1', 'widgets': [
                {'type': 'table', 'title': 'x', 'columns': ['a', 'b'], 'rows': [['only-one']]}]},
            {'schema': 'openteamily.dashboard.v1', 'widgets': [
                {'type': 'bar', 'title': 'x', 'labels': ['a', 'b'], 'values': [1]}]},
            {'schema': 'openteamily.dashboard.v1', 'widgets': [
                {'type': 'bar', 'title': 'x', 'labels': ['a'], 'values': ['not-a-number']}]},
            {'schema': 'openteamily.dashboard.v1', 'widgets': [
                {'type': 'metric', 'title': 'x', 'value': 'v'} for _ in range(21)]},
            {'schema': 'other', 'widgets': [{'type': 'metric', 'title': 'x', 'value': 'v'}]},
        ]
        for value in bad:
            result = self.alice.call('POST', self.base(),
                                     {'title': '坏看板', 'kind': 'dashboard', 'dashboard': value},
                                     {'HTTP_IDEMPOTENCY_KEY': 'artifact-dash-bad-01'})
            self.assertEqual(result['status'], 400, (value, result))
        created = self.create()
        item = created['body']['artifact']
        self.assertEqual(self.bob.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'dashboard': dashboard()},
        })['status'], 403)
        self.assertEqual(self.eve.call('GET', self.base(item['id']))['status'], 404)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
