"""Model API configuration tests. In-process WSGI + temporary SQLite only."""
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.fake_runtime import FakeRuntimeBackend
from openteamily.operator_config import OperatorAdmin
from openteamily.scheduler import Scheduler
from openteamily.security import digest, opaque
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

SECRET = 'sk-test-not-a-real-key-value'
OVERRIDE = 'sk-user-override-key-value'
TOKEN = 'A' * 43
FIELDS = {
    'provider': 'openai',
    'base_url': 'https://example.com/v1',
    'model': 'gpt-4o-mini',
    'api_key': SECRET,
}


class ModelAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.path = Path(self.temp.name) / 'state'
        self.app = App(
            Store(self.path),
            Config(ORIGIN, allow_registration=True),
            clock=lambda: self.now,
            automation_backend=FakeRuntimeBackend(),
            operator_admin=OperatorAdmin(digest(TOKEN)),
        )
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.wid = self.alice.workspace()['body']['workspace']['id']

    def admin(self, method, path, body=None, peer='127.0.0.1', origin=None, **headers):
        client = Client(self.app, peer)
        return client.call(method, path, body, {'HTTP_AUTHORIZATION': 'Bearer ' + TOKEN, **headers},
                           origin=origin, csrf=False)

    def save(self, client, revision, changes, path=None, **kw):
        return client.call('POST', path or '/v1/model-api', {'revision': revision, 'changes': changes}, **kw)

    def test_platform_default_is_used_until_an_override_is_set(self):
        empty = self.alice.call('GET', '/v1/model-api')
        self.assertEqual(empty['status'], 200)
        self.assertFalse(empty['body']['model_api']['api_key_set'])
        self.assertEqual(empty['body']['effective']['source'], 'none')
        created = self.admin('POST', '/v1/admin/model-api', {'revision': 0, 'changes': FIELDS})
        self.assertEqual(created['status'], 200, created)
        self.assertTrue(created['body']['model_api']['api_key_set'])
        self.assertNotIn(SECRET, json.dumps(created))
        seen = self.alice.call('GET', '/v1/model-api')
        self.assertEqual(seen['body']['effective']['source'], 'platform')
        self.assertEqual(seen['body']['effective']['model'], 'gpt-4o-mini')
        self.assertFalse(seen['body']['model_api']['api_key_set'])
        self.assertNotIn(SECRET, json.dumps(seen))
        override = self.save(self.alice, 0, {
            'provider': 'custom', 'base_url': 'https://example.net/v1',
            'model': 'own-model', 'api_key': OVERRIDE,
        })
        self.assertEqual(override['status'], 200)
        again = self.alice.call('GET', '/v1/model-api')
        self.assertEqual(again['body']['effective']['source'], 'account')
        self.assertEqual(again['body']['effective']['model'], 'own-model')
        self.assertTrue(again['body']['model_api']['api_key_set'])
        self.assertNotIn(SECRET, json.dumps(again))
        self.assertNotIn(OVERRIDE, json.dumps(again))

    def test_workspace_override_beats_platform_for_automations(self):
        self.admin('POST', '/v1/admin/model-api', {'revision': 0, 'changes': FIELDS})
        # enable a due daily automation at 09:00 Asia/Shanghai; now is 16:00 that day
        body = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations', {
            'title': 'Morning briefing', 'prompt': 'Summarize overnight activity.', 'template_id': 'custom',
            'schedule': {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'},
            'participants': ['alice'],
        }, {'HTTP_IDEMPOTENCY_KEY': 'automation-model-0001'})
        self.assertEqual(body['status'], 201, body)
        aid = body['body']['automation']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}', {'revision': 1, 'changes': {'enabled': True}})
        workspace = self.save(self.alice, 0, {
            'provider': 'anthropic', 'base_url': 'https://api.anthropic.com',
            'model': 'claude-3-haiku', 'api_key': OVERRIDE,
        }, path=f'/v1/workspaces/{self.wid}/model-api')
        self.assertEqual(workspace['status'], 200, workspace)
        Scheduler(self.app.store, self.app.automation_backend, clock=lambda: self.now).tick_all(self.now)
        hook = self.app.automation_backend.dispatches[0]
        self.assertEqual(hook['model_api']['source'], 'workspace')
        self.assertEqual(hook['model_api']['model'], 'claude-3-haiku')
        self.assertTrue(hook['model_api_key_set'])
        self.assertEqual(hook['model_api_key_digest'], digest(OVERRIDE))
        self.assertNotIn(OVERRIDE, json.dumps(hook))
        runs = self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')
        self.assertNotIn(OVERRIDE, json.dumps(runs))
        self.assertNotIn(SECRET, json.dumps(runs))

    def test_operator_admin_is_loopback_bearer_only(self):
        self.assertEqual(self.admin('GET', '/v1/admin/model-api')['status'], 200)
        self.assertEqual(self.admin('GET', '/v1/admin/model-api', peer='192.0.2.1')['status'], 401)
        self.assertEqual(self.admin('GET', '/v1/admin/model-api', origin=ORIGIN)['status'], 401)
        self.assertEqual(self.alice.call('GET', '/v1/admin/model-api')['status'], 401)
        self.assertEqual(Client(self.app).call(
            'GET', '/v1/admin/model-api', None,
            {'HTTP_AUTHORIZATION': 'Bearer ' + ('B' * 43)}, origin=None, csrf=False,
        )['status'], 401)

    def test_key_is_wrapped_and_write_only(self):
        self.save(self.alice, 0, FIELDS)
        listed = self.alice.call('GET', '/v1/model-api')
        self.assertNotIn('api_key', listed['body']['model_api'])
        self.assertNotIn('api_key', listed['body']['effective'])
        self.assertNotIn(SECRET, json.dumps(listed))
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            blob, document = db.execute('SELECT key_blob, provider FROM model_api_configs').fetchone()
            self.assertNotIn(SECRET, blob)
            self.assertNotIn(SECRET, document)
            dump = '\n'.join(db.iterdump())
        self.assertNotIn(SECRET, dump)
        wrap = (self.path / 'model-api.wrap').read_bytes()
        self.assertNotIn(SECRET.encode(), wrap)

    def test_requires_session_csrf_and_rejects_bad_urls(self):
        self.assertEqual(Client(self.app).call('GET', '/v1/model-api')['status'], 401)
        self.assertEqual(self.save(self.alice, 0, FIELDS, csrf=False)['status'], 403)
        for url in ('http://example.com/v1', 'https://user:pass@example.com/v1', 'file:///etc/passwd', 'javascript:alert(1)'):
            bad = dict(FIELDS, base_url=url)
            self.assertEqual(self.save(self.alice, 0, bad)['status'], 400, url)

    def test_existing_v1_database_gains_table_without_version_bump(self):
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE model_api_configs')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='model_api_configs'").fetchone())


    def test_container_payload_maps_scopes_and_omits_missing_keys(self):
        from openteamily import model_api
        public = {'provider': 'openai', 'base_url': 'https://example.com/v1', 'model': 'gpt-4o-mini'}
        self.assertIsNone(model_api.container_payload(public, None, 'platform'))
        self.assertIsNone(model_api.container_payload(None, SECRET, 'platform'))
        platform = model_api.container_payload(public, SECRET, 'platform')
        self.assertEqual(platform, {**public, 'api_key': SECRET, 'source': 'platform'})
        self.assertEqual(model_api.container_payload(public, OVERRIDE, 'account')['source'], 'user')
        self.assertEqual(model_api.container_payload(public, OVERRIDE, 'workspace')['source'], 'user')
        self.assertEqual(model_api.container_payload(public, OVERRIDE, 'workspace')['api_key'], OVERRIDE)


if __name__ == '__main__':
    unittest.main()
