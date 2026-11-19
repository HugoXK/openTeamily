"""Automation scheduler tests (issue #6 slice 2). In-process only; no Docker or real execution."""
from datetime import datetime
from pathlib import Path
import tempfile
import unittest
from zoneinfo import ZoneInfo

from openteamily.app import App, Config
from openteamily.automations import due_at
from openteamily.fake_runtime import FakeRuntimeBackend
from openteamily.lifecycle import Lifecycle
from openteamily.scheduler import Scheduler
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


NOW = 1800000000  # 2027-01-15 16:00 Asia/Shanghai, Friday
DUE = 1799974800  # 2027-01-15 09:00 Asia/Shanghai
EARLY = int(datetime(2027, 1, 15, 8, 59, tzinfo=ZoneInfo('Asia/Shanghai')).timestamp())
DAILY = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}


class DueAtTests(unittest.TestCase):
    def test_daily_weekly_and_once_slots(self):
        self.assertEqual(due_at(DAILY, NOW), DUE)
        self.assertIsNone(due_at(DAILY, EARLY))
        self.assertIsNone(due_at({'kind': 'daily', 'time': '18:00', 'time_zone': 'Asia/Shanghai'}, NOW))
        self.assertEqual(due_at({'kind': 'weekly', 'time': '09:00', 'time_zone': 'Asia/Shanghai', 'weekday': 5}, NOW), DUE)
        self.assertIsNone(due_at({'kind': 'weekly', 'time': '09:00', 'time_zone': 'Asia/Shanghai', 'weekday': 1}, NOW))
        self.assertEqual(due_at({'kind': 'once', 'date': '2027-01-15', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}, NOW), DUE)
        self.assertIsNone(due_at({'kind': 'once', 'date': '2027-01-16', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}, NOW))


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.store = Store(self.path)
        self.backend = FakeRuntimeBackend(self.store)
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: NOW,
                       lifecycle=Lifecycle(self.store, clock=lambda: NOW), automation_backend=self.backend)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def create(self, enabled=True, **fields):
        body = {'title': 'Morning briefing', 'prompt': 'Summarize overnight activity.', 'template_id': 'custom',
                'schedule': DAILY, 'participants': ['alice'], **fields}
        created = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations', body,
                                  {'HTTP_IDEMPOTENCY_KEY': 'automation-sched-0001'})
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['automation']['id']
        if enabled:
            saved = self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                                    {'revision': 1, 'changes': {'enabled': True}})
            self.assertEqual(saved['status'], 200)
        return aid

    def tick(self, client=None, **kw):
        return (client or self.alice).call('POST', f'/v1/workspaces/{self.wid}/automations/tick', {}, **kw)

    def test_disabled_and_early_clock_do_not_fire(self):
        self.create(enabled=False)
        self.assertEqual(self.tick()['body']['items'], [])
        early = App(self.store, self.app.config, clock=lambda: EARLY, automation_backend=self.backend)
        self.alice.app = early
        aid = self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations')['body']['items'][0]['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/automations/{aid}',
                        {'revision': 1, 'changes': {'enabled': True}})
        self.assertEqual(self.tick()['body']['items'], [])

    def test_due_tick_records_a_single_hook_and_is_idempotent(self):
        aid = self.create()
        first = self.tick()
        self.assertEqual(first['status'], 200)
        self.assertEqual(len(first['body']['items']), 1)
        run = first['body']['items'][0]
        self.assertEqual(run['automation_id'], aid)
        self.assertEqual(run['due_at'], DUE)
        self.assertEqual(run['status'], 'skipped')
        self.assertEqual(run['error_code'], 'no_instance')
        self.assertEqual(self.backend.dispatches[0]['title'], 'Morning briefing')
        second = self.tick()
        self.assertEqual(second['body']['items'], [])
        self.assertEqual(len(self.backend.dispatches), 1)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['id'], run['id'])

    def test_hook_attaches_workspace_instances_without_starting_docker(self):
        self.create()
        created = self.alice.call('POST', f'/v1/workspaces/{self.wid}/instances', {},
                                  {'HTTP_IDEMPOTENCY_KEY': 'instance-create-0001'})
        self.assertIn(created['status'], (200, 201), created)
        iid = created['body']['instance']['id']
        run = self.tick()['body']['items'][0]
        self.assertEqual(run['status'], 'succeeded')
        self.assertEqual(run['dispatch']['instance_ids'], [iid])
        self.assertIsNone(run['error_code'])
        self.assertEqual(self.backend.dispatches[0]['instance_ids'], [iid])

    def test_backend_failure_is_recorded_without_exception_text(self):
        self.create()
        self.backend.fail_next = True
        run = self.tick()['body']['items'][0]
        self.assertEqual(run['status'], 'failed')
        self.assertEqual(run['error_code'], 'runtime_failure')
        self.assertNotIn('Injected', str(run))

    def test_member_can_read_runs_but_cannot_tick(self):
        aid = self.create()
        self.assertEqual(self.tick(self.bob)['status'], 403)
        self.assertEqual(self.tick()['status'], 200)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')['status'], 200)
        other = Client(self.app, peer='127.0.0.3')
        other.register('carol')
        self.assertEqual(other.call('POST', f'/v1/workspaces/{self.wid}/automations/tick', {})['status'], 404)
        self.assertEqual(other.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')['status'], 404)

    def test_tick_requires_csrf_and_origin(self):
        self.create()
        aid = self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations')['body']['items'][0]['id']
        self.assertEqual(self.tick(csrf=False)['status'], 403)
        self.assertEqual(self.tick(origin='https://evil.test')['status'], 403)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/automations/{aid}/runs')['body']['items'], [])

    def test_direct_scheduler_tick_all_does_not_need_http(self):
        self.create()
        fired = Scheduler(self.store, self.backend, clock=lambda: NOW).tick_all(NOW)
        self.assertEqual(len(fired), 1)
        self.assertEqual(fired[0]['due_at'], DUE)


if __name__ == '__main__':
    unittest.main()
