"""Re-run one failed automation run without waiting for the next tick (issue #321).

In-process WSGI + temporary SQLite. No vendor is contacted: with no runtime
online the retried run is queued with `no_agent`, which is the honest state.
"""
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

SCHEDULE = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
KEY = 'automation-retry-key-0001'


class AutomationRunRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.other = self.carol.workspace(name='别处', key='retry_other_ws_0001')['body']['workspace']['id']
        self.automation = self.create()
        self.source = self.add_run('failed', 'runtime_failure')

    def create(self, client=None, wid=None, key='automation-retry-create01', participants=('alice',)):
        created = (client or self.alice).call(
            'POST', f'/v1/workspaces/{wid or self.wid}/automations',
            {'title': '晨会简报', 'prompt': 'Summarize overnight activity.', 'template_id': 'custom',
             'schedule': SCHEDULE, 'participants': list(participants)},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['automation']

    def add_run(self, status='failed', error='runtime_failure', due=0, automation_id=None):
        run_id = '%032x' % (abs(hash((status, error, due, automation_id or self.automation['id']))) % (16 ** 32))
        dispatch = json.dumps({'result': {'text': '上一次运行的结果'}, 'backend': 'agent'})
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute(
                'INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?,?,?)',
                (run_id, automation_id or self.automation['id'], self.wid, due, self.now,
                 self.now, status, error, dispatch),
            )
            db.commit()
        return run_id

    def runs(self, automation_id=None):
        listed = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/automations/{automation_id or self.automation["id"]}/runs?limit=20')
        self.assertEqual(listed['status'], 200, listed)
        return listed['body']['items']

    def retry(self, run_id, key=KEY, client=None, automation_id=None):
        return (client or self.alice).call(
            'POST',
            f'/v1/workspaces/{self.wid}/automations/{automation_id or self.automation["id"]}/runs/{run_id}/retry',
            {}, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_a_failed_run_is_requeued_and_the_source_run_keeps_its_conclusion(self):
        response = self.retry(self.source)
        self.assertEqual(response['status'], 201, response)
        fresh = response['body']['run']
        self.assertNotEqual(fresh['id'], self.source)
        self.assertEqual(fresh['status'], 'queued', fresh)
        self.assertEqual(fresh['automation_id'], self.automation['id'])
        self.assertEqual(response['body']['retried']['status'], 'failed',
                         'the retried run must keep its own conclusion')
        source = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/automations/{self.automation["id"]}/runs/{self.source}')
        self.assertEqual(source['body']['run']['status'], 'failed')
        self.assertEqual(source['body']['run']['error_code'], 'runtime_failure')
        self.assertEqual([item['id'] for item in self.runs()].count(fresh['id']), 1,
                         'the new run shows up in the run list once')

    def test_the_same_idempotency_key_never_queues_a_second_run(self):
        first = self.retry(self.source)
        second = self.retry(self.source)
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(second['status'], 200, second)
        self.assertEqual(second['body']['run']['id'], first['body']['run']['id'])
        self.assertEqual(len(self.runs()), 2, 'a double click must not queue the automation twice')
        third = self.retry(self.source, key='automation-retry-key-0002')
        self.assertEqual(third['status'], 201, third)
        self.assertNotEqual(third['body']['run']['id'], first['body']['run']['id'])
        self.assertEqual(len(self.runs()), 3, 'a deliberate second retry is a new run')

    def test_only_a_failed_run_can_be_retried(self):
        succeeded = self.add_run('succeeded', None, due=10)
        self.assertEqual(self.retry(succeeded)['status'], 409)
        queued = self.add_run('queued', None, due=20)
        self.assertEqual(self.retry(queued)['status'], 409)

    def test_retry_is_bounded_by_workspace_role_and_a_real_run(self):
        self.assertEqual(self.retry(self.source, client=self.bob)['status'], 403)
        self.assertEqual(self.retry('0' * 32)['status'], 404)
        no_key = self.alice.call(
            'POST',
            f'/v1/workspaces/{self.wid}/automations/{self.automation["id"]}/runs/{self.source}/retry', {})
        self.assertEqual(no_key['status'], 400)
        elsewhere = self.create(client=self.carol, wid=self.other, key='automation-retry-create02',
                                participants=('carol',))
        crossed = self.alice.call(
            'POST',
            f'/v1/workspaces/{self.wid}/automations/{elsewhere["id"]}/runs/{self.source}/retry',
            {}, {'HTTP_IDEMPOTENCY_KEY': 'automation-retry-key-0003'})
        self.assertEqual(crossed['status'], 404,
                         'an automation from another workspace cannot be reached through this one')

    def test_a_retry_gets_its_own_run_slot(self):
        # (automation_id, due_at) is unique; a run already sitting on the retry
        # instant must not make the retry fail.
        self.add_run('failed', 'timeout', due=self.now)
        response = self.retry(self.source, key='automation-retry-key-0004')
        self.assertEqual(response['status'], 201, response)
        self.assertNotEqual(response['body']['run']['due_at'], self.now)


if __name__ == '__main__':
    unittest.main()
