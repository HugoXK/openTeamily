"""Artifact notifications: saving a work tells the other workspace members.

Write side only; the disabled notification button on /artifacts is a later slice.
No agent, vendor or push service is contacted.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import notifications
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class ArtifactNotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.carol, self.eve = Client(self.app, peer='127.0.0.3'), Client(self.app, peer='127.0.0.4')
        for client, name in ((self.alice, 'alice'), (self.bob, 'bob'), (self.carol, 'carol'), (self.eve, 'eve')):
            client.register(name)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.members = f'/v1/workspaces/{self.wid}/members'
        for name in ('bob', 'carol'):
            self.alice.call('POST', self.members, {'username': name, 'role': 'member'})
        self.ids = {name: client.call('GET', '/v1/auth/session')['body']['user']['id']
                    for name, client in (('alice', self.alice), ('bob', self.bob),
                                         ('carol', self.carol), ('eve', self.eve))}
        self.inbox = f'/v1/workspaces/{self.wid}/notifications'
        self.artifacts = f'/v1/workspaces/{self.wid}/artifacts'
        self.keys = 0

    def save(self, client, title='方案 A', body='正文', key=None):
        self.keys += 1
        return client.call('POST', self.artifacts, {'title': title, 'body': body},
                           {'HTTP_IDEMPOTENCY_KEY': key or f'artifact-notify-{self.keys:06d}'})

    def edit(self, client, artifact, revision, body):
        return client.call('POST', f"{self.artifacts}/{artifact['id']}",
                           {'revision': revision, 'changes': {'body': body}})

    def inbox_items(self, client):
        listed = client.call('GET', self.inbox)
        self.assertEqual(listed['status'], 200, listed)
        return listed['body']

    def artifact_items(self, body):
        return [item for item in body['items'] if item['kind'] == 'artifact']

    def test_a_save_notifies_the_other_members_but_never_the_saver(self):
        saved = self.save(self.alice)
        self.assertEqual(saved['status'], 201, saved)
        artifact = saved['body']['artifact']

        bob = self.inbox_items(self.bob)
        self.assertEqual(bob['unread_count'], 1)
        items = self.artifact_items(bob)
        self.assertEqual(len(items), 1, bob)
        item = items[0]
        self.assertEqual((item['artifact_id'], item['artifact_title'], item['actor_username'], item['read']),
                         (artifact['id'], '方案 A', 'alice', False))
        self.assertEqual(item['actor_id'], self.ids['alice'])

        carol = self.inbox_items(self.carol)
        self.assertEqual([row['artifact_id'] for row in self.artifact_items(carol)], [artifact['id']])

        # The saver never gets a notification for their own save, and neither does an outsider.
        self.assertEqual(self.inbox_items(self.alice)['unread_count'], 0)
        self.assertEqual(self.inbox_items(self.alice)['items'], [])
        self.assertEqual(self.eve.call('GET', self.inbox)['status'], 404)

    def test_repeated_saves_of_one_artifact_do_not_pile_up_rows(self):
        artifact = self.save(self.alice)['body']['artifact']
        second = self.edit(self.alice, artifact, 1, '改过的正文')
        self.assertEqual(second['status'], 200, second)
        third = self.edit(self.alice, artifact, 2, '再改一次')
        self.assertEqual(third['status'], 200, third)

        # Replaying the same create with the same idempotency key must not add a row either.
        self.save(self.alice, key='artifact-notify-000001')

        bob = self.inbox_items(self.bob)
        items = self.artifact_items(bob)
        self.assertEqual(len(items), 1, bob)
        self.assertEqual(items[0]['artifact_id'], artifact['id'])
        self.assertEqual(bob['unread_count'], 1)

    def test_a_read_artifact_notice_stays_read_and_clears_the_badge(self):
        self.save(self.alice)
        self.assertEqual(self.inbox_items(self.bob)['unread_count'], 1)
        marked = self.bob.call('POST', self.inbox + '/read', {'all': True})
        self.assertEqual(marked['status'], 200, marked)
        self.assertEqual(marked['body']['unread_count'], 0)
        after = self.inbox_items(self.bob)
        self.assertEqual(after['unread_count'], 0)
        self.assertTrue(self.artifact_items(after)[0]['read'])

    def test_a_suspended_member_stops_seeing_the_notice_and_a_new_member_never_got_it(self):
        self.save(self.alice)
        self.assertEqual(self.inbox_items(self.bob)['unread_count'], 1)
        suspended = self.alice.call('POST', f'{self.members}/{self.ids["bob"]}/suspend', {})
        self.assertEqual(suspended['status'], 200, suspended)
        self.assertEqual(self.bob.call('GET', self.inbox)['status'], 404)

        self.alice.call('POST', self.members, {'username': 'eve', 'role': 'member'})
        self.assertEqual(self.inbox_items(self.eve)['unread_count'], 0)
        self.assertEqual(self.inbox_items(self.eve)['items'], [])

    def test_the_artifact_preference_hook_is_consulted(self):
        """#284 的 notification_prefs 还没合入；接上之前这里必须只有一个可插拔的判断。"""
        original = notifications.wants_artifact
        notifications.wants_artifact = lambda db, workspace_id, user_id: user_id == self.ids['carol']
        self.addCleanup(setattr, notifications, 'wants_artifact', original)
        self.save(self.alice)
        self.assertEqual(self.inbox_items(self.bob)['unread_count'], 0)
        self.assertEqual(len(self.artifact_items(self.inbox_items(self.carol))), 1)
