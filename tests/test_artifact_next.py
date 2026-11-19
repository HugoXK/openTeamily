"""Shares, provenance, isolation, and sandboxed website renders. Not browser E2E."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.artifacts import sanitize_html, SHARE_CSP
from openteamily.security import digest
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD
from tests.test_runtime_connect import AgentClient

PAYLOAD = (
    '<script>alert(1)</script><p>Hello <b>there</b></p>'
    '<img src=x onerror="alert(2)">'
    '<a href="javascript:alert(3)">bad</a>'
    '<a href="https://example.com">ok</a>'
    '<iframe src="https://evil.example"></iframe>'
    '<div onclick="alert(4)">click</div>'
)


def header(response, name):
    return {key.lower(): value for key, value in response['headers']}[name.lower()]


class ArtifactNextTests(unittest.TestCase):
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
        invited = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'}
        )
        self.assertEqual(invited['status'], 201, invited)
        self.other = self.carol.workspace(name='别处', key='request_other_ws_0001')['body']['workspace']['id']

    def create(self, client=None, title='Notes', body='First draft.', kind='document', key='artifact-next-create01'):
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': title, 'body': body, 'kind': kind},
            {'HTTP_IDEMPOTENCY_KEY': key},
        )

    def add_run(self, title='Morning briefing', prompt='Summarize overnight activity.', text='brief from run', status='succeeded'):
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/automations',
            {'title': title, 'prompt': prompt, 'template_id': 'custom',
             'schedule': {'kind': 'now', 'time_zone': 'Asia/Shanghai'}, 'participants': ['alice']},
            {'HTTP_IDEMPOTENCY_KEY': 'auto-next-' + title.replace(' ', '-')[:24].ljust(16, 'x')},
        )
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['automation']['id']
        run_id = digest('run:' + aid + text + status)[:32]
        dispatch = json.dumps({'result': {'text': text}, 'backend': 'agent'})
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute(
                'INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?,?,?)',
                (run_id, aid, self.wid, 0, self.now, self.now, status, None, dispatch),
            )
            db.commit()
        return aid, run_id

    def test_sanitizer_strips_active_content(self):
        html = sanitize_html(PAYLOAD)
        lowered = html.lower()
        self.assertIn('<p>Hello <b>there</b></p>', html)
        self.assertIn('https://example.com', html)
        self.assertNotIn('<script', lowered)
        self.assertNotIn('onerror', lowered)
        self.assertNotIn('onclick', lowered)
        self.assertNotIn('<iframe', lowered)
        self.assertNotIn('javascript:', lowered)
        self.assertIn("sandbox", SHARE_CSP)
        self.assertNotIn("script-src", SHARE_CSP)

    def test_save_run_persists_provenance_revisions_and_isolation(self):
        aid, run_id = self.add_run()
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/artifact', {}
        )
        self.assertEqual(saved['status'], 201, saved)
        item = saved['body']['artifact']
        self.assertEqual(item['kind'], 'document')
        self.assertEqual(item['body'], 'brief from run')
        self.assertEqual(item['source']['kind'], 'automation_run')
        self.assertEqual(item['source']['id'], run_id)
        self.assertEqual(item['source']['automation_id'], aid)
        self.assertEqual(item['source']['automation_title'], 'Morning briefing')
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute(
                'SELECT body, revision FROM artifacts WHERE id=?', (item['id'],)
            ).fetchone()
            source = db.execute(
                'SELECT source_kind, source_id FROM artifact_sources WHERE artifact_id=?', (item['id'],)
            ).fetchone()
            shares = db.execute('SELECT COUNT(*) FROM artifact_shares WHERE artifact_id=?', (item['id'],)).fetchone()[0]
        self.assertEqual(row, ('brief from run', 1))
        self.assertEqual(tuple(source), ('automation_run', run_id))
        self.assertEqual(shares, 0)
        again = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/artifact', {}
        )
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['artifact']['id'], item['id'])
        edited = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 1, 'changes': {'body': 'edited brief'}},
        )
        self.assertEqual(edited['status'], 200, edited)
        self.assertEqual(edited['body']['artifact']['revision'], 2)
        self.assertEqual(edited['body']['artifact']['source']['id'], run_id)
        self.assertEqual(self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/artifact', {}
        )['status'], 200)
        self.assertEqual(self.carol.call(
            'POST', f'/v1/workspaces/{self.other}/automations/{aid}/runs/{run_id}/artifact', {}
        )['status'], 404)
        self.assertEqual(self.carol.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}'
        )['status'], 404)

    def test_failed_run_cannot_be_saved(self):
        aid, run_id = self.add_run(title='Broken briefing', status='failed')
        refused = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/automations/{aid}/runs/{run_id}/artifact', {}
        )
        self.assertEqual(refused['status'], 409, refused)

    def test_share_is_explicit_revocable_and_isolated(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['artifact']['id']
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(listed['body']['items'], [])
        denied = self.bob.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares', {})
        self.assertEqual(denied['status'], 403)
        shared = self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares', {})
        self.assertEqual(shared['status'], 201, shared)
        token = shared['body']['share']['token']
        path = shared['body']['share']['path']
        self.assertTrue(path.startswith('/share/'))
        self.assertEqual(path, '/share/' + token)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares')
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertNotIn('token', listed['body']['items'][0])
        self.assertEqual(listed['body']['items'][0]['prefix'], token[:8])
        dumped = (self.path / 'management.sqlite3').read_bytes()
        self.assertNotIn(token.encode(), dumped)
        anon = Client(self.app)
        page = anon.call('GET', path, parse='raw', csrf=False, origin=None)
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('First draft.', html)
        self.assertIn('Notes', html)
        self.assertIn('sandbox', header(page, 'Content-Security-Policy'))
        self.assertEqual(header(page, 'Content-Type').split(';')[0], 'text/html')
        self.assertEqual(anon.call('GET', path, parse='raw', csrf=False, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares')['status'], 404)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares/{shared["body"]["share"]["id"]}/revoke', {}
        )
        self.assertEqual(revoked['status'], 200, revoked)
        self.assertTrue(revoked['body']['share']['revoked'])
        self.assertEqual(anon.call('GET', path, parse='raw', csrf=False, origin=None)['status'], 404)
        expired = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/shares', {'expires_in': 1}
        )
        self.assertEqual(expired['status'], 201, expired)
        self.now += 2
        self.assertEqual(
            anon.call('GET', expired['body']['share']['path'], parse='raw', csrf=False, origin=None)['status'],
            404,
        )

    def test_website_preview_and_share_drop_active_content(self):
        created = self.create(title='Landing', body=PAYLOAD, kind='website', key='artifact-next-site-0001')
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'website')
        self.assertIn('<script>', item['body'])
        stored = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}')
        self.assertEqual(stored['body']['artifact']['body'], PAYLOAD)
        preview = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/preview', parse='raw'
        )
        self.assertEqual(preview['status'], 200)
        html = preview['body'].decode()
        csp = header(preview, 'Content-Security-Policy')
        self.assertIn('sandbox', csp)
        self.assertNotIn('script-src', csp)
        self.assertNotIn('<script', html.lower())
        self.assertNotIn('onerror', html.lower())
        self.assertNotIn('onclick', html.lower())
        self.assertNotIn('<iframe', html.lower())
        self.assertNotIn('javascript:', html.lower())
        self.assertIn('Hello', html)
        self.assertIn('https://example.com', html)
        self.assertEqual(self.carol.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/preview', parse='raw'
        )['status'], 404)
        shared = self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/shares', {})
        self.assertEqual(shared['status'], 201, shared)
        page = Client(self.app).call(
            'GET', shared['body']['share']['path'], parse='raw', csrf=False, origin=None
        )
        self.assertEqual(page['status'], 200)
        rendered = page['body'].decode().lower()
        self.assertNotIn('<script', rendered)
        self.assertNotIn('onerror', rendered)
        self.assertIn('sandbox', header(page, 'Content-Security-Policy'))

    def test_agent_echo_result_saves_into_workspace_library(self):
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'desk'})['body']['token']
        agent = AgentClient(self.app, token)
        connected = agent.call('POST', '/v1/agent/connect', {'hostname': 'desk-one'})
        self.assertIn(connected['status'], (200, 201), connected)
        task = self.alice.call(
            'POST', '/v1/runtime/tasks',
            {'kind': 'echo', 'prompt': 'hello desk', 'workspace_id': self.wid},
        )
        self.assertEqual(task['status'], 201, task)
        task_id = task['body']['task']['id']
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})['status'], 200)
        done = agent.call(
            'POST', f'/v1/agent/tasks/{task_id}/result',
            {'status': 'succeeded', 'result': {'echo': 'hello desk'}},
        )
        self.assertEqual(done['status'], 200, done)
        saved = self.alice.call('POST', f'/v1/runtime/tasks/{task_id}/artifact', {'workspace_id': self.wid})
        self.assertEqual(saved['status'], 201, saved)
        item = saved['body']['artifact']
        self.assertEqual(item['body'], 'hello desk')
        self.assertEqual(item['source']['kind'], 'agent_task')
        self.assertEqual(item['source']['id'], task_id)
        self.assertEqual(item['workspace_id'], self.wid)
        self.assertEqual(
            self.bob.call('POST', f'/v1/runtime/tasks/{task_id}/artifact', {'workspace_id': self.wid})['status'],
            404,
        )
        again = self.alice.call('POST', f'/v1/runtime/tasks/{task_id}/artifact', {})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['artifact']['id'], item['id'])

    def test_existing_v1_database_gains_share_tables_without_version_bump(self):
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.executescript(
                'DROP TABLE IF EXISTS artifact_shares;'
                'DROP TABLE IF EXISTS artifact_sources;'
                'DROP TABLE IF EXISTS artifact_meta;'
            )
            db.execute('PRAGMA user_version=1')
            version = db.execute('PRAGMA user_version').fetchone()[0]
        self.assertEqual(version, 1)
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertTrue({'artifact_shares', 'artifact_sources', 'artifact_meta'} <= names)
        self.assertEqual(self.create(key='artifact-next-after-v1x')['status'], 201)


if __name__ == '__main__':
    unittest.main()
