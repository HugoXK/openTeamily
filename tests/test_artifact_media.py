"""Media uploads and whiteboard operations. Deterministic fixtures; not browser E2E."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.artifacts import clean_filename, sniff_mime
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

# 1x1 PNG, generated as a fixed fixture (70 bytes).
PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de'
    '0000000c4944415408d763f8cfc00000000300010005fedc0a0000000049454e44ae426082'
)
# Minimal JPEG (1x1) starting with FF D8 FF.
JPEG = bytes.fromhex(
    'ffd8ffe000104a46494600010100000100010000ffdb00430003020203020203'
    '030303040304050805050404040506070c0a06070b070404080e080b0b0d0d0e'
    '0c0c0d0e1013100e0e0f0e0c0d1112111313130d11151614121214ffc0000b08'
    '0001000101010111ffc40014100100000000000000000000000000000000ffda'
    '00080001000100003f00fbffd9'
)


def header(response, name):
    return {key.lower(): value for key, value in response['headers']}[name.lower()]


def multipart(fields, files, boundary='----OTTestBoundary9f3a'):
    parts = []
    for name, value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, filename, mime, data in files:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f'Content-Type: {mime}\r\n\r\n'.encode() + data + b'\r\n'
        )
    parts.append(f'--{boundary}--\r\n'.encode())
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


class ArtifactMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.assertEqual(
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})['status'],
            201,
        )
        self.other = self.carol.workspace(name='别处', key='request_other_media_01')['body']['workspace']['id']

    def upload(self, client=None, title='Photo', filename='ok_photo.png', mime='image/png', data=PNG, key='artifact-media-create01', wid=None):
        raw, content_type = multipart([('title', title), ('kind', 'media')], [('file', filename, mime, data)])
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{wid or self.wid}/artifacts',
            raw=raw,
            headers={'CONTENT_TYPE': content_type, 'HTTP_IDEMPOTENCY_KEY': key, 'CONTENT_LENGTH': str(len(raw))},
        )

    def test_fixtures_are_deterministic_and_sniffed(self):
        self.assertEqual(len(PNG), 70)
        self.assertEqual(sniff_mime(PNG), 'image/png')
        self.assertEqual(sniff_mime(JPEG), 'image/jpeg')
        self.assertIsNone(sniff_mime(b'<html><script>alert(1)</script></html>'))
        self.assertIsNone(sniff_mime(b'<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'))
        self.assertEqual(clean_filename('../../etc/passwd'), 'file')
        self.assertEqual(clean_filename('ok_photo.png'), 'ok_photo.png')

    def test_media_persists_revisions_permissions_and_isolation(self):
        created = self.upload()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'media')
        self.assertEqual(item['media']['mime'], 'image/png')
        self.assertEqual(item['media']['bytes'], len(PNG))
        self.assertEqual(item['media']['filename'], 'ok_photo.png')
        self.assertNotIn('body', item)
        digest_hex = None
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute(
                'SELECT mime, byte_count, filename, sha256 FROM artifact_media WHERE artifact_id=?',
                (item['id'],),
            ).fetchone()
        self.assertEqual(row[0], 'image/png')
        self.assertEqual(row[1], len(PNG))
        self.assertEqual(row[2], 'ok_photo.png')
        digest_hex = row[3]
        stored = self.path / 'artifact-objects' / self.wid / digest_hex
        self.assertEqual(stored.read_bytes(), PNG)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}')['status'], 200)
        file_get = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/file', parse='raw')
        self.assertEqual(file_get['status'], 200)
        self.assertEqual(file_get['body'], PNG)
        self.assertEqual(header(file_get, 'Content-Type'), 'image/png')
        self.assertEqual(header(file_get, 'X-Content-Type-Options'), 'nosniff')
        self.assertNotIn('script-src', header(file_get, 'Content-Security-Policy'))
        denied = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 1, 'changes': {'title': 'Stolen'}},
        )
        self.assertEqual(denied['status'], 403)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/file', parse='raw')['status'], 404)
        raw, content_type = multipart(
            [('title', 'Photo'), ('revision', '1')],
            [('file', 'ok_photo.jpg', 'image/jpeg', JPEG)],
        )
        replaced = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/file',
            raw=raw,
            headers={'CONTENT_TYPE': content_type, 'CONTENT_LENGTH': str(len(raw))},
        )
        self.assertEqual(replaced['status'], 200, replaced)
        self.assertEqual(replaced['body']['artifact']['revision'], 2)
        self.assertEqual(replaced['body']['artifact']['media']['mime'], 'image/jpeg')
        again = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/file', parse='raw')
        self.assertEqual(again['body'], JPEG)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts')
        self.assertEqual(listed['body']['items'][0]['kind'], 'media')
        self.assertNotIn('body', listed['body']['items'][0])
        shares = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/shares')
        self.assertEqual(shares['body']['items'], [])

    def test_rejects_bad_mime_size_and_path_and_keeps_tenant_files_apart(self):
        html = self.upload(filename='page.html', mime='text/html', data=b'<html><script>alert(1)</script></html>', key='artifact-media-html0001')
        self.assertEqual(html['status'], 400)
        svg = self.upload(filename='img.svg', mime='image/svg+xml', data=b'<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', key='artifact-media-svg00001')
        self.assertEqual(svg['status'], 400)
        disguised = self.upload(filename='trick.png', mime='image/png', data=b'<html><script>alert(1)</script></html>', key='artifact-media-disguise1')
        self.assertEqual(disguised['status'], 400)
        huge = self.upload(data=b'\x89PNG\r\n\x1a\n' + b'A' * (2 * 1024 * 1024), key='artifact-media-huge0001')
        self.assertIn(huge['status'], (400, 413))
        sneaky = self.upload(filename='../../etc/passwd', mime='image/png', data=PNG, key='artifact-media-path0001')
        self.assertEqual(sneaky['status'], 201, sneaky)
        self.assertEqual(sneaky['body']['artifact']['media']['filename'], 'file')
        objects = self.path / 'artifact-objects'
        self.assertFalse((objects / 'etc').exists())
        self.assertFalse((objects / 'passwd').exists())
        alice_id = sneaky['body']['artifact']['id']
        other = self.upload(client=self.carol, title='Carol', key='artifact-media-carol0001', wid=self.other)
        self.assertEqual(other['status'], 201, other)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.other}/artifacts/{other["body"]["artifact"]["id"]}/file', parse='raw')['status'], 404)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{alice_id}/file', parse='raw')['status'], 404)
        shared = self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{alice_id}/shares', {})
        self.assertEqual(shared['status'], 201, shared)
        token = shared['body']['share']['token']
        page = Client(self.app).call('GET', '/share/' + token, parse='raw', csrf=False, origin=None)
        self.assertEqual(page['status'], 200)
        # Public share preview is an HTML wrapper, not a scripted document, and does not include the raw PNG as HTML.
        self.assertIn('text/html', header(page, 'Content-Type'))
        self.assertIn('sandbox', header(page, 'Content-Security-Policy'))
        self.assertNotIn(b'<script', page['body'].lower())
        revoke = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{alice_id}/shares/{shared["body"]["share"]["id"]}/revoke', {}
        )
        self.assertEqual(revoke['status'], 200)
        self.assertEqual(Client(self.app).call('GET', '/share/' + token, parse='raw', csrf=False, origin=None)['status'], 404)

    def test_whiteboard_operations_revisions_and_escaped_text(self):
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': 'Sketch', 'kind': 'whiteboard', 'board': {
                'width': 400, 'height': 300,
                'strokes': [{'id': 'stroke001', 'type': 'path', 'color': '#112233', 'width': 2, 'points': [[10, 10], [20, 25]]}],
            }},
            {'HTTP_IDEMPOTENCY_KEY': 'artifact-board-create01'},
        )
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'whiteboard')
        self.assertEqual(len(item['board']['strokes']), 1)
        added = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 1, 'changes': {'operations': [
                {'op': 'add', 'stroke': {'id': 'stroke002', 'type': 'text', 'color': '#000000', 'x': 12, 'y': 40, 'size': 16, 'text': '<script>alert(1)</script>'}},
            ]}},
        )
        self.assertEqual(added['status'], 200, added)
        self.assertEqual(added['body']['artifact']['revision'], 2)
        self.assertEqual([s['type'] for s in added['body']['artifact']['board']['strokes']], ['path', 'text'])
        preview = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/preview', parse='raw')
        self.assertEqual(preview['status'], 200)
        html = preview['body'].decode()
        self.assertIn('sandbox', header(preview, 'Content-Security-Policy'))
        self.assertNotIn('<script', html.lower())
        self.assertIn('&lt;script&gt;', html)
        bad = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 2, 'changes': {'operations': [{'op': 'add', 'stroke': {'id': 'x', 'type': 'path', 'points': [[0, 0]]}}]}},
        )
        self.assertEqual(bad['status'], 400)
        removed = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 2, 'changes': {'operations': [{'op': 'remove', 'id': 'stroke002'}]}},
        )
        self.assertEqual(removed['status'], 200, removed)
        self.assertEqual([s['id'] for s in removed['body']['artifact']['board']['strokes']], ['stroke001'])
        self.assertEqual(self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 3, 'changes': {'operations': [{'op': 'remove', 'id': 'stroke001'}]}},
        )['status'], 403)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}')['status'], 404)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            raw = db.execute('SELECT board FROM artifact_boards WHERE artifact_id=?', (item['id'],)).fetchone()[0]
        self.assertIn('stroke001', raw)
        self.assertNotIn('stroke002', raw)

    def test_schema_stays_v1_and_json_media_is_rejected(self):
        refused = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': 'Nope', 'kind': 'media', 'body': 'not a file'},
            {'HTTP_IDEMPOTENCY_KEY': 'artifact-media-json0001'},
        )
        self.assertEqual(refused['status'], 400)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            version = db.execute('PRAGMA user_version').fetchone()[0]
        self.assertEqual(version, 1)
        self.assertTrue({'artifact_media', 'artifact_boards'} <= names)


if __name__ == '__main__':
    unittest.main()
