"""Artifact version history and export. In-process WSGI only; not browser E2E."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_artifact_media import JPEG, PNG, header, multipart
from tests.test_management import Client, ORIGIN


class ArtifactVersionTests(unittest.TestCase):
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
        self.assertEqual(
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})['status'],
            201,
        )

    def create(self, client=None, title='Notes', body='First draft.', key='artifact-version-create01', **fields):
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': title, 'body': body, **fields},
            {'HTTP_IDEMPOTENCY_KEY': key},
        )

    def versions(self, artifact_id, client=None):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/artifacts/{artifact_id}/versions')

    def test_edits_are_listed_and_restored_without_rewriting_history(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['artifact']['id']
        listed = self.versions(aid)
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual([item['revision'] for item in listed['body']['items']], [1])
        self.assertNotIn('body', listed['body']['items'][0])
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision': 1, 'changes': {'body': 'Revised draft.'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['artifact']['revision'], 2)
        listed = self.versions(aid)
        self.assertEqual([item['revision'] for item in listed['body']['items']], [2, 1])
        first = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions/1')
        self.assertEqual(first['status'], 200, first)
        self.assertEqual(first['body']['version']['body'], 'First draft.')
        self.assertEqual(first['body']['version']['created_by'], 'alice')
        restored = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 2, 'to': 1},
        )
        self.assertEqual(restored['status'], 200, restored)
        item = restored['body']['artifact']
        self.assertEqual(item['revision'], 3)
        self.assertEqual(item['body'], 'First draft.')
        second = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions/2')
        self.assertEqual(second['body']['version']['body'], 'Revised draft.')
        current = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}')
        self.assertEqual(current['body']['artifact']['body'], 'First draft.')
        self.assertEqual(current['body']['artifact']['revision'], 3)
        same = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 3, 'to': 1},
        )
        self.assertEqual(same['status'], 200, same)
        self.assertEqual(same['body']['artifact']['revision'], 3)
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 2, 'to': 1},
        )
        self.assertEqual(stale['status'], 409)
        missing = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 3, 'to': 99},
        )
        self.assertEqual(missing['status'], 404)

    def test_export_is_an_attachment_and_website_html_is_sanitized(self):
        doc = self.create(body='Export me.')
        aid = doc['body']['artifact']['id']
        exported = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/export', parse='raw'
        )
        self.assertEqual(exported['status'], 200, exported)
        self.assertEqual(exported['body'], b'Export me.')
        self.assertEqual(header(exported, 'Content-Type'), 'text/plain; charset=utf-8')
        self.assertIn('attachment', header(exported, 'Content-Disposition'))
        self.assertIn('filename="document-1.txt"', header(exported, 'Content-Disposition'))
        self.assertEqual(header(exported, 'X-Content-Type-Options'), 'nosniff')
        site = self.create(
            title='Page', body='<p>ok</p><script>alert(1)</script>', kind='website',
            key='artifact-version-site-0001',
        )
        self.assertEqual(site['status'], 201, site)
        sid = site['body']['artifact']['id']
        html = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{sid}/export', parse='raw'
        )
        self.assertEqual(html['status'], 200, html)
        self.assertIn(b'<p>ok</p>', html['body'])
        self.assertNotIn(b'<script>', html['body'])
        self.assertEqual(header(html, 'Content-Type'), 'text/html; charset=utf-8')
        self.assertIn('filename="website-1.html"', header(html, 'Content-Disposition'))
        self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision': 1, 'changes': {'body': 'Second'}},
        )
        old = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions/1/export', parse='raw'
        )
        self.assertEqual(old['status'], 200)
        self.assertEqual(old['body'], b'Export me.')
        self.assertIn('filename="document-1.txt"', header(old, 'Content-Disposition'))

    def test_permissions_csrf_quota_and_schema_v1(self):
        created = self.create()
        aid = created['body']['artifact']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions')['status'], 200)
        self.assertEqual(
            self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/export', parse='raw')['status'],
            200,
        )
        denied = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 1, 'to': 1},
        )
        self.assertEqual(denied['status'], 403)
        self.assertEqual(
            self.alice.call(
                'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
                {'revision': 1, 'to': 1}, csrf=False,
            )['status'],
            403,
        )
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions')['status'], 404)
        self.assertEqual(
            outsider.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/export', parse='raw')['status'],
            404,
        )
        self.app.config = replace(self.app.config, max_versions_per_artifact=2)
        self.assertEqual(
            self.alice.call(
                'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
                {'revision': 1, 'changes': {'body': 'two'}},
            )['status'],
            200,
        )
        capped = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision': 2, 'changes': {'body': 'three'}},
        )
        self.assertEqual(capped['status'], 429, capped)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(
                db.execute("SELECT name FROM sqlite_master WHERE name='artifact_versions'").fetchone()
            )

    def test_media_replace_keeps_previous_bytes_and_restore_works(self):
        raw, content_type = multipart(
            [('title', 'Photo'), ('kind', 'media')], [('file', 'ok_photo.png', 'image/png', PNG)]
        )
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            raw=raw,
            headers={'CONTENT_TYPE': content_type, 'HTTP_IDEMPOTENCY_KEY': 'artifact-version-media-01',
                     'CONTENT_LENGTH': str(len(raw))},
        )
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['artifact']['id']
        later, later_type = multipart(
            [('title', 'Photo'), ('revision', '1')], [('file', 'ok_photo.jpg', 'image/jpeg', JPEG)]
        )
        replaced = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/file',
            raw=later,
            headers={'CONTENT_TYPE': later_type, 'CONTENT_LENGTH': str(len(later))},
        )
        self.assertEqual(replaced['status'], 200, replaced)
        self.assertEqual(replaced['body']['artifact']['revision'], 2)
        self.assertEqual(replaced['body']['artifact']['media']['mime'], 'image/jpeg')
        old = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions/1/export', parse='raw'
        )
        self.assertEqual(old['status'], 200, old)
        self.assertEqual(old['body'], PNG)
        self.assertEqual(header(old, 'Content-Type'), 'image/png')
        self.assertIn('attachment', header(old, 'Content-Disposition'))
        restored = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/restore',
            {'revision': 2, 'to': 1},
        )
        self.assertEqual(restored['status'], 200, restored)
        self.assertEqual(restored['body']['artifact']['revision'], 3)
        self.assertEqual(restored['body']['artifact']['media']['mime'], 'image/png')
        current = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/file', parse='raw'
        )
        self.assertEqual(current['body'], PNG)
        removed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/remove', {})
        self.assertEqual(removed['status'], 200, removed)
        objects = list((self.path / 'artifact-objects' / self.wid).glob('*'))
        self.assertEqual(objects, [])

    def test_legacy_artifact_is_backfilled_on_first_history_read(self):
        created = self.create(title='Legacy', body='only current', key='artifact-version-legacy01')
        aid = created['body']['artifact']['id']
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DELETE FROM artifact_versions WHERE artifact_id=?', (aid,))
            db.commit()
        listed = self.versions(aid)
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual([item['revision'] for item in listed['body']['items']], [1])
        first = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/versions/1')
        self.assertEqual(first['body']['version']['body'], 'only current')


if __name__ == '__main__':
    unittest.main()
