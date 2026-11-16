"""Automation persistence tests (issue #6). In-process WSGI + temporary SQLite only. No execution."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


SCHEDULE = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}


class AutomationTests(unittest.TestCase):
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
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'admin'})

    def create(self, client, title='Morning briefing', key='automation-create-0001', wid=None, **kw):
        fields = {name: kw.pop(name) for name in list(kw) if name in ('prompt', 'template_id', 'schedule', 'participants')}
        body = {'title': title, 'prompt': 'Summarize overnight activity.', 'template_id': 'custom',
                'schedule': SCHEDULE, 'participants': ['alice'], **fields}
        return client.call('POST', f'/v1/workspaces/{wid or self.wid}/automations', body,
                           {'HTTP_IDEMPOTENCY_KEY': key}, **kw)

    def test_template_catalog_is_custom_only(self):
        response = self.alice.call('GET', '/v1/automation-templates')
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['items'], [{'id': 'custom', 'title': 'Custom', 'prompt': ''}])
        self.assertEqual(Client(self.app).call('GET', '/v1/automation-templates')['status'], 401)

    def test_create_list_get_persist_and_do_not_enable(self):
        created = self.create(self.alice)
        self.assertEqual(created['status'], 201)
        item = created['body']['automation']
        self.assertEqual(item['enabled'], False)
        self.assertEqual(item['revision'], 1)
        self.assertEqual(item['template_id'], 'custom')
        self.assertEqual(item['schedule'], SCHEDULE)
        self.assertEqual(item['participants'][0]['username'], 'alice')
        restarted = App(Store(self.path), self.app.config, clock=lambda: 1800000000)
        alice = Client(restarted)
        alice.cookies = dict(self.alice.cookies)
        listed = alice.call('GET', f'/v1/workspaces/{self.wid}/automations')
        self.assertEqual(len(listed['body']['items']), 1)
        fetched = alice.call('GET', f'/v1/workspaces/{self.wid}/automations/{item["id"]}')
        self.assertEqual(fetched['body']['automation'], item)

    def test_idempotent_replay_and_title_conflict(self):
        first = self.create(self.alice)
        replay = self.create(self.alice)
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body'], first['body'])
        conflict = self.create(self.alice, title='Other', key='automation-create-0001')
        self.assertEqual(conflict['status'], 409)
        self.assertEqual(self.create(self.alice, title='Morning briefing', key='automation-create-0002')['status'], 409)

    def test_member_can_read_but_only_owner_or_admin_can_write(self):
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'carol', 'role': 'member'})
        created = self.create(self.bob, title='Admin note', key='automation-create-0002', participants=['bob'])
        self.assertEqual(created['status'], 201)
        aid = created['body']['automation']['id']
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/automations')['status'], 200)
        self.assertEqual(self.create(self.carol, title='Member note', key='automation-create-0003')['status'], 403)
        self.assertEqual(self.carol.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                                         {'revision': 1, 'changes': {'enabled': True}})['status'], 403)

    def test_strangers_and_non_members_cannot_see_or_add_participants(self):
        other = Client(self.app, peer='127.0.0.4')
        other.register('dave')
        self.assertEqual(other.call('GET', f'/v1/workspaces/{self.wid}/automations')['status'], 404)
        self.assertEqual(self.create(self.alice, participants=['dave'])['status'], 404)
        self.assertEqual(self.create(self.alice, participants=['missing-user'])['status'], 404)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/automations')['status'], 404)

    def test_update_revision_enable_and_remove_do_not_execute(self):
        aid = self.create(self.alice)['body']['automation']['id']
        stale = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                                {'revision': 99, 'changes': {'enabled': True}})
        self.assertEqual(stale['status'], 409)
        saved = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                                {'revision': 1, 'changes': {
                                    'enabled': True,
                                    'schedule': {'kind': 'weekly', 'time': '18:30', 'time_zone': 'UTC', 'weekday': 1},
                                    'participants': ['Alice', 'bob'],
                                }})
        self.assertEqual(saved['status'], 200)
        item = saved['body']['automation']
        self.assertTrue(item['enabled'])
        self.assertEqual(item['revision'], 2)
        self.assertEqual(item['schedule']['kind'], 'weekly')
        self.assertEqual([row['username'] for row in item['participants']], ['alice', 'bob'])
        removed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}/remove', {})
        self.assertEqual(removed['status'], 200)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}')['status'], 404)

    def test_requires_session_csrf_origin_and_rejects_invalid_payloads(self):
        self.assertEqual(self.create(self.alice, csrf=False)['status'], 403)
        self.assertEqual(self.create(self.alice, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.create(Client(self.app), key='automation-anon-0000001')['status'], 401)
        self.assertEqual(self.create(self.alice, title='', key='automation-create-0002')['status'], 400)
        self.assertEqual(self.create(self.alice, key='automation-create-0003',
                                     schedule={'kind': 'daily', 'time': '09:00', 'time_zone': 'Not/AZone'})['status'], 400)
        self.assertEqual(self.create(self.alice, key='automation-create-0004',
                                     schedule={'kind': 'once', 'time': '09:00', 'time_zone': 'UTC',
                                               'date': '2026-02-31'})['status'], 400)
        self.assertEqual(self.create(self.alice, key='automation-create-0005', template_id='daily-standup')['status'], 400)
        self.assertEqual(len(self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations')['body']['items']), 0)

    def test_quota_and_existing_v1_database(self):
        self.app.config = replace(self.app.config, max_automations_per_workspace=1)
        self.assertEqual(self.create(self.alice)['status'], 201)
        self.assertEqual(self.create(self.alice, title='Second', key='automation-create-0002')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE automations')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='automations'").fetchone())


if __name__ == '__main__':
    unittest.main()
