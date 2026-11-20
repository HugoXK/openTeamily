"""Account avatar upload, storage and serving. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_artifact_media import JPEG, PNG, multipart
from tests.test_management import Client, ORIGIN


def header(response, name):
    return {key.lower(): value for key, value in response['headers']}[name.lower()]


class ProfileAvatarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')

    def upload(self, client=None, data=PNG, filename='me.png', mime='image/png'):
        raw, content_type = multipart([], [('file', filename, mime, data)])
        return (client or self.alice).call(
            'POST', '/v1/profile/avatar', raw=raw,
            headers={'CONTENT_TYPE': content_type, 'CONTENT_LENGTH': str(len(raw))},
        )

    def test_avatar_upload_updates_the_profile_and_survives_a_reload(self):
        self.assertIsNone(self.alice.call('GET', '/v1/profile')['body']['avatar'])
        self.assertEqual(self.alice.call('GET', '/v1/profile/avatar')['status'], 404)
        saved = self.upload()
        self.assertEqual(saved['status'], 200, saved)
        avatar = saved['body']['avatar']
        self.assertEqual(avatar['mime'], 'image/png')
        self.assertEqual(avatar['bytes'], len(PNG))
        self.assertTrue(avatar['url'].startswith('/v1/profile/avatar?v='), avatar)
        # A page refresh reads the same avatar back, and the bytes really are served.
        reloaded = self.alice.call('GET', '/v1/profile')['body']['avatar']
        self.assertEqual(reloaded, avatar)
        served = self.alice.call('GET', avatar['url'], parse='raw')
        self.assertEqual(served['status'], 200)
        self.assertEqual(served['body'], PNG)
        self.assertEqual(header(served, 'content-type'), 'image/png')
        self.assertEqual(header(served, 'x-content-type-options'), 'nosniff')
        self.assertEqual(header(served, 'cross-origin-resource-policy'), 'same-origin')
        # Replacing the image keeps exactly one object on disk and a new URL.
        replaced = self.upload(data=JPEG, filename='me.jpg', mime='image/jpeg')['body']['avatar']
        self.assertEqual(replaced['mime'], 'image/jpeg')
        self.assertNotEqual(replaced['url'], avatar['url'])
        self.assertEqual(self.alice.call('GET', replaced['url'], parse='raw')['body'], JPEG)
        objects = [item for item in (self.path / 'artifact-objects').rglob('*') if item.is_file()]
        self.assertEqual(len(objects), 1, objects)
        self.assertEqual(objects[0].read_bytes(), JPEG)
        self.assertEqual(objects[0].stat().st_mode & 0o777, 0o600)

    def test_a_restarted_process_still_serves_the_saved_avatar(self):
        avatar = self.upload()['body']['avatar']
        second = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        client = Client(second)
        client.cookies = dict(self.alice.cookies)
        self.assertEqual(client.call('GET', '/v1/profile/avatar', parse='raw')['body'], PNG)
        self.assertEqual(client.call('GET', '/v1/profile')['body']['avatar'], avatar)

    def test_an_oversized_avatar_is_refused_and_nothing_is_stored(self):
        oversized = PNG + b'\x00' * (2 * 1024 * 1024)
        refused = self.upload(data=oversized)
        self.assertEqual(refused['status'], 413, refused)
        self.assertEqual(refused['body']['error']['message'], 'Request body is too large')
        self.assertIsNone(self.alice.call('GET', '/v1/profile')['body']['avatar'])

    def test_a_non_image_is_refused_with_415(self):
        refused = self.upload(data=b'<html><body>not an image</body></html>', filename='page.html', mime='text/html')
        self.assertEqual(refused['status'], 415, refused)
        self.assertEqual(refused['body']['error']['message'], 'Unsupported or unrecognizable media type')
        self.assertIsNone(self.alice.call('GET', '/v1/profile')['body']['avatar'])

    def test_avatar_routes_require_a_session(self):
        anonymous = Client(self.app, peer='127.0.0.2')
        self.assertEqual(self.upload(client=anonymous)['status'], 401)
        self.assertEqual(anonymous.call('GET', '/v1/profile/avatar')['status'], 401)

    def test_avatar_upload_requires_the_csrf_token(self):
        raw, content_type = multipart([], [('file', 'me.png', 'image/png', PNG)])
        refused = self.alice.call(
            'POST', '/v1/profile/avatar', raw=raw, csrf=False,
            headers={'CONTENT_TYPE': content_type, 'CONTENT_LENGTH': str(len(raw))},
        )
        self.assertEqual(refused['status'], 403, refused)


if __name__ == '__main__':
    unittest.main()
