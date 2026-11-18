"""Editable slide decks in the works library (issue #90, first slice). In-process WSGI."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


def deck(*slides):
    return {'schema': 'openteamily.slides.v1', 'slides': [
        {'title': title, 'bullets': list(bullets)} for title, bullets in slides
    ]}


class ArtifactSlideTests(unittest.TestCase):
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

    def create(self, client=None, title='路线图', slides=None, key='artifact-slides-0001'):
        return (client or self.alice).call(
            'POST', self.base(),
            {'title': title, 'kind': 'slides',
             'slides': slides if slides is not None else deck(('目标', ['统一入口', '更快的回复']), ('下一步', ['接入运行时']))},
            {'HTTP_IDEMPOTENCY_KEY': key})

    def test_create_read_update_and_export(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'slides')
        self.assertEqual(len(item['slides']['slides']), 2)
        self.assertEqual(item['slides']['slides'][0]['title'], '目标')
        seen = self.alice.call('GET', self.base(item['id']))
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['artifact']['slides']['slides'][1]['bullets'], ['接入运行时'])
        listed = self.alice.call('GET', self.base())
        self.assertEqual(listed['body']['items'][0]['kind'], 'slides')
        self.assertNotIn('slides', listed['body']['items'][0])
        saved = self.alice.call('POST', self.base(item['id']), {
            'revision': 1,
            'changes': {'title': '路线图 v2', 'slides': deck(('目标', ['统一入口']), ('风险', ['真实运行时未验收']))},
        })
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['artifact']['revision'], 2)
        self.assertEqual(saved['body']['artifact']['title'], '路线图 v2')
        self.assertEqual(saved['body']['artifact']['slides']['slides'][1]['title'], '风险')
        stale = self.alice.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'slides': deck(('旧', []))},
        })
        self.assertEqual(stale['status'], 409)
        exported = self.alice.call('GET', self.base(item['id']) + '/export', parse='raw')
        self.assertEqual(exported['status'], 200)
        html = exported['body'].decode()
        self.assertIn('路线图 v2', html)
        self.assertIn('真实运行时未验收', html)
        self.assertIn('text/html', dict(exported['headers'])['Content-Type'])
        preview = self.alice.call('GET', self.base(item['id']) + '/preview', parse='raw')
        self.assertEqual(preview['status'], 200)
        self.assertIn('统一入口', preview['body'].decode())

    def test_version_history_restore_and_share(self):
        created = self.create()
        item = created['body']['artifact']
        self.alice.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'slides': deck(('改版', ['新内容']))},
        })
        versions = self.alice.call('GET', self.base(item['id']) + '/versions')
        self.assertEqual(versions['status'], 200)
        self.assertEqual([row['kind'] for row in versions['body']['items']], ['slides', 'slides'])
        first = self.alice.call('GET', self.base(item['id']) + '/versions/1')
        self.assertEqual(first['status'], 200)
        self.assertEqual(first['body']['version']['kind'], 'slides')
        self.assertEqual(first['body']['version']['slides']['slides'][0]['title'], '目标')
        version_export = self.alice.call('GET', self.base(item['id']) + '/versions/1/export', parse='raw')
        self.assertEqual(version_export['status'], 200)
        self.assertIn('统一入口', version_export['body'].decode())
        restored = self.alice.call('POST', self.base(item['id']) + '/restore', {'revision': 2, 'to': 1})
        self.assertEqual(restored['status'], 200, restored)
        self.assertEqual(restored['body']['artifact']['revision'], 3)
        self.assertEqual(restored['body']['artifact']['slides']['slides'][0]['title'], '目标')
        same = self.alice.call('POST', self.base(item['id']) + '/restore', {'revision': 3, 'to': 1})
        self.assertEqual(same['status'], 200)
        self.assertEqual(same['body']['artifact']['revision'], 3)
        shared = self.alice.call('POST', self.base(item['id']) + '/shares', {})
        self.assertEqual(shared['status'], 201, shared)
        anon = Client(self.app, peer='127.0.0.9')
        page = anon.call('GET', shared['body']['share']['path'], parse='raw', csrf=False, origin=None)
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('统一入口', html)
        self.assertIn('sandbox', dict(page['headers'])['Content-Security-Policy'])

    def test_validation_and_permissions(self):
        for bad in (
            {'title': '空', 'kind': 'slides', 'slides': deck()},
            {'title': '空页', 'kind': 'slides', 'slides': deck(('', []))},
            {'title': '太多', 'kind': 'slides', 'slides': deck(*[('页%d' % i, ['x']) for i in range(31)])},
            {'title': '长', 'kind': 'slides', 'slides': deck(('页', ['x' * 201]))},
            {'title': '坏', 'kind': 'slides', 'slides': {'schema': 'other', 'slides': [{'title': 'x'}]}},
        ):
            result = self.alice.call('POST', self.base(), bad, {'HTTP_IDEMPOTENCY_KEY': 'artifact-slides-bad-01'})
            self.assertEqual(result['status'], 400, (bad, result))
        created = self.create()
        item = created['body']['artifact']
        self.assertEqual(self.bob.call('POST', self.base(item['id']), {
            'revision': 1, 'changes': {'slides': deck(('改', ['内容']))},
        })['status'], 403)
        self.assertEqual(self.eve.call('GET', self.base(item['id']))['status'], 404)
        other = self.bob.workspace('bob-space', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call(
            'GET', f'/v1/workspaces/{other}/artifacts/{item["id"]}')['status'], 404)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
