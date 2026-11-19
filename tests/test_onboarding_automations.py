"""Onboarding automation recommendations and creation (issue #148)."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class OnboardingAutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def onboard(self, role='产品经理', industry='科技与软件'):
        return self.alice.call('POST', '/v1/onboarding',
                               {'industry': industry, 'role': role, 'completed': True})

    def test_recommendations_and_creation(self):
        generic = self.alice.call('GET', '/v1/onboarding/recommendations')
        self.assertEqual(generic['status'], 200)
        self.assertIn('daily_brief', [item['template_id'] for item in generic['body']['items']])
        self.assertEqual(self.onboard()['status'], 201)
        tailored = self.alice.call('GET', '/v1/onboarding/recommendations')
        ids = [item['template_id'] for item in tailored['body']['items']]
        self.assertIn('deck_report', ids)
        created = self.alice.call('POST', '/v1/onboarding/automations',
                                  {'template_ids': ['deck_report', 'task_breakdown']})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['workspace']['name'], '个人空间')
        self.assertEqual(len(created['body']['created']), 2)
        wid = created['body']['workspace']['id']
        listed = self.alice.call('GET', f'/v1/workspaces/{wid}/automations')
        self.assertEqual(listed['status'], 200)
        templates = sorted(item['template_id'] for item in listed['body']['items'])
        self.assertEqual(templates, ['deck_report', 'task_breakdown'])
        self.assertTrue(all(item['enabled'] is False for item in listed['body']['items']))
        replay = self.alice.call('POST', '/v1/onboarding/automations',
                                 {'template_ids': ['deck_report', 'task_breakdown']})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['created'], [])
        self.assertEqual(len(replay['body']['skipped']), 2)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_existing_owned_workspace_is_reused(self):
        self.onboard()
        wid = self.alice.workspace('我的空间', 'request_example_0001')['body']['workspace']['id']
        created = self.alice.call('POST', '/v1/onboarding/automations',
                                  {'template_ids': ['daily_brief']})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['workspace']['id'], wid)
        listed = self.alice.call('GET', f'/v1/workspaces/{wid}/automations')
        self.assertEqual(len(listed['body']['items']), 1)

    def test_validation_csrf_and_capacity(self):
        for body in (
            {'template_ids': []},
            {'template_ids': ['custom']},
            {'template_ids': ['daily_brief', 'daily_brief']},
            {'template_ids': ['daily_brief'] * 7},
            {'template_ids': ['unknown']},
        ):
            self.assertEqual(self.alice.call('POST', '/v1/onboarding/automations', body)['status'], 400, body)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/automations',
                                         {'template_ids': ['daily_brief']}, csrf=False)['status'], 403)
        limited = App(Store(Path(self.temp.name) / 'limited'), Config(
            ORIGIN, allow_registration=True, max_automations_per_workspace=1), clock=lambda: 1800000000)
        client = Client(limited)
        client.register('alice')
        self.assertEqual(client.call('POST', '/v1/onboarding/automations',
                                     {'template_ids': ['daily_brief', 'task_breakdown']})['status'], 429)


if __name__ == '__main__':
    unittest.main()
