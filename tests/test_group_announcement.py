"""Group announcement card/API. In-process WSGI only; no browser or vendor is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class GroupAnnouncementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.base = f'/v1/workspaces/{self.wid}/social/conversations'
        created = self.alice.call('POST', self.base, {'kind': 'group', 'member_ids': [self.bob_id], 'title': '公告群'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'announce-create-01'})
        self.cid = created['body']['conversation']['id']

    def path(self):
        return f'{self.base}/{self.cid}'

    def test_group_announcement_is_admin_written_and_visible_to_every_member(self):
        self.assertEqual(self.bob.call('POST', f'{self.path()}/announcement', {'body': '周五上线'})['status'], 403)
        saved = self.alice.call('POST', f'{self.path()}/announcement', {'body': '周五上线'})
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['announcement']['body'], '周五上线')
        self.assertEqual(saved['body']['announcement']['author'], 'alice')
        seen = self.bob.call('GET', self.path())['body']['conversation']
        self.assertEqual(seen['announcement']['body'], '周五上线')
        self.assertFalse(seen['can_announce'])
        mine = self.alice.call('GET', self.path())['body']['conversation']
        self.assertEqual(mine['announcement']['body'], '周五上线')
        self.assertTrue(mine['can_announce'])
        self.assertEqual(self.alice.call('POST', f'{self.path()}/announcement', {'body': 'x' * 501})['status'], 400)
        self.assertEqual(self.alice.call('POST', f'{self.path()}/announcement', {'body': '   '})['status'], 400)
        cleared = self.alice.call('POST', f'{self.path()}/announcement', {'body': ''})
        self.assertEqual(cleared['status'], 200)
        self.assertIsNone(cleared['body']['announcement'])
        self.assertIsNone(self.bob.call('GET', self.path())['body']['conversation']['announcement'])

    def test_announcement_is_read_only_for_non_members(self):
        self.alice.call('POST', f'{self.path()}/announcement', {'body': '仅群内可见'})
        eve = Client(self.app, peer='127.0.0.4')
        eve.register('eve')
        self.assertEqual(eve.call('GET', self.path())['status'], 404)
        self.assertEqual(eve.call('POST', f'{self.path()}/announcement', {'body': 'x'})['status'], 404)
