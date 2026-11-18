"""Work-context onboarding (industry/role). In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class OnboardingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def test_create_read_update_and_industries(self):
        before = self.alice.call('GET', '/v1/onboarding')
        self.assertEqual(before['status'], 200)
        self.assertIsNone(before['body']['onboarding'])
        names = [row['name'] for row in before['body']['industries']]
        self.assertEqual(len(names), 16)
        self.assertIn('科技与软件', names)
        tech = [row for row in before['body']['industries'] if row['name'] == '科技与软件'][0]
        self.assertIn('产品经理', tech['roles'])
        created = self.alice.call('POST', '/v1/onboarding', {
            'industry': '科技与软件', 'role': '产品经理', 'completed': True})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['onboarding']['industry'], '科技与软件')
        self.assertEqual(created['body']['onboarding']['role'], '产品经理')
        self.assertTrue(created['body']['onboarding']['completed'])
        updated = self.alice.call('POST', '/v1/onboarding', {
            'industry': '教育', 'role': '老师', 'completed': True})
        self.assertEqual(updated['status'], 200)
        self.assertEqual(updated['body']['onboarding']['revision'], 2)
        seen = self.alice.call('GET', '/v1/onboarding')['body']['onboarding']
        self.assertEqual(seen['industry'], '教育')
        skip = self.alice.call('POST', '/v1/onboarding', {
            'industry': '', 'role': '', 'completed': True})
        self.assertEqual(skip['status'], 200)
        self.assertTrue(skip['body']['onboarding']['completed'])

    def test_validation_isolation_and_csrf(self):
        for body in (
            {'industry': 'x' * 41, 'role': '', 'completed': True},
            {'industry': '科技与软件', 'role': 'x' * 41, 'completed': True},
            {'industry': '科技与软件', 'role': '', 'completed': 'yes'},
            {'industry': '科技与软件', 'role': ''},
        ):
            self.assertEqual(self.alice.call('POST', '/v1/onboarding', body)['status'], 400, body)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding', {
            'industry': '科技与软件', 'role': '产品经理', 'completed': True}, csrf=False)['status'], 403)
        self.alice.call('POST', '/v1/onboarding', {
            'industry': '科技与软件', 'role': '产品经理', 'completed': True})
        self.assertIsNone(self.bob.call('GET', '/v1/onboarding')['body']['onboarding'])


    def test_personal_agent_and_onboarding_coexist_across_v1_reopen(self):
        self.assertIsNone(self.alice.call('GET', '/v1/personal-agent')['body']['personal_agent'])
        self.assertIsNone(self.alice.call('GET', '/v1/onboarding')['body']['onboarding'])
        personal = self.alice.call('POST', '/v1/personal-agent', {})
        self.assertEqual(personal['status'], 201, personal)
        saved = self.alice.call('POST', '/v1/onboarding', {
            'industry': '独立研究', 'role': '分析顾问', 'completed': True})
        self.assertEqual(saved['status'], 201, saved)
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True))
        self.alice.app = reopened
        self.assertEqual(self.alice.call('GET', '/v1/onboarding')['body']['onboarding'], saved['body']['onboarding'])
        self.assertEqual(self.alice.call('GET', '/v1/personal-agent')['body'], personal['body'])
        self.assertEqual(self.alice.call('POST', '/v1/personal-agent', {})['status'], 200)
        with reopened.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertIsNone(self.bob.call('GET', '/v1/onboarding')['body']['onboarding'])

    def test_origin_unknown_fields_and_read_only_get(self):
        valid = {'industry': '科技与软件', 'role': '产品经理', 'completed': True}
        self.assertEqual(self.alice.call('POST', '/v1/onboarding', valid,
                                         {'HTTP_ORIGIN': 'https://evil.invalid'})['status'], 403)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding', {**valid, 'user_id': 'another'})['status'], 400)
        self.assertEqual(Client(self.app).call('GET', '/v1/onboarding')['status'], 401)
        self.assertIsNone(self.alice.call('GET', '/v1/onboarding')['body']['onboarding'])


if __name__ == '__main__':
    unittest.main()
