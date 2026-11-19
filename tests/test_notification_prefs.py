"""Per-user notification preferences (issue #275): the server stops the category, not the page."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

from openteamily.app import App, Config
from openteamily.store import Store
from tests import test_group_agent_reply as group_tests
from tests.test_management import Client, ORIGIN

ALL_ON = {'mentions': True, 'task_completion': True, 'artifacts': True}


class NotificationPrefTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.carol = Client(self.app, peer='127.0.0.3')
        for client, name in ((self.alice, 'alice'), (self.bob, 'bob'), (self.carol, 'carol')):
            client.register(name)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for name in ('bob', 'carol'):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': name, 'role': 'member'})
        ids = {name: client.call('GET', '/v1/auth/session')['body']['user']['id']
               for name, client in (('alice', self.alice), ('bob', self.bob), ('carol', self.carol))}
        self.ids = ids
        self.base = f'/v1/workspaces/{self.wid}/social/conversations'
        self.conv = self.alice.call('POST', self.base, {'kind': 'group', 'member_ids': [ids['bob'], ids['carol']],
                                                        'title': '项目群'},
                                    {'HTTP_IDEMPOTENCY_KEY': 'prefs-group-00001'})['body']['conversation']['id']
        self.inbox = f'/v1/workspaces/{self.wid}/notifications'
        self.prefs_path = '/v1/notification-prefs'
        self.keys = 0

    def send(self, client, body):
        self.keys += 1
        return client.call('POST', f'{self.base}/{self.conv}/messages', {'body': body},
                           {'HTTP_IDEMPOTENCY_KEY': f'prefs-msg-{self.keys:08d}'})

    def put(self, client, changes):
        return client.call('PUT', self.prefs_path, {'changes': changes})

    def test_defaults_are_all_on_and_unauthenticated_is_401(self):
        anonymous = Client(self.app, peer='127.0.0.9')
        self.assertEqual(anonymous.call('GET', self.prefs_path)['status'], 401)
        self.assertEqual(anonymous.call('PUT', self.prefs_path, {'changes': {'mentions': False}})['status'], 401)
        listed = self.bob.call('GET', self.prefs_path)
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual(listed['body']['prefs'], ALL_ON)
        self.assertEqual([item['key'] for item in listed['body']['categories']],
                         ['mentions', 'task_completion', 'artifacts'])

    def test_turning_off_mentions_stops_the_write_not_the_page(self):
        self.assertEqual(self.put(self.bob, {'mentions': False})['status'], 200)
        self.assertEqual(self.send(self.alice, '@bob @carol 先看这个')['status'], 201)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['items'], [])
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 0)
        # Another member's preference is untouched: carol still gets hers.
        self.assertEqual(self.carol.call('GET', self.inbox)['body']['unread_count'], 1)
        # Turning it back on collects the next mention, not the skipped one.
        self.assertEqual(self.put(self.bob, {'mentions': True})['status'], 200)
        self.send(self.carol, '@bob 现在看这个')
        items = self.bob.call('GET', self.inbox)['body']['items']
        self.assertEqual([item['excerpt'] for item in items], ['@bob 现在看这个'])

    def test_put_validates_and_survives_a_reopen(self):
        for bad in ({}, {'mentions': 'no'}, {'bogus': True}, {'mentions': 1}):
            self.assertEqual(self.put(self.bob, bad)['status'], 400, bad)
        self.assertEqual(self.bob.call('PUT', self.prefs_path, {'prefs': {'mentions': False}})['status'], 400)
        self.assertEqual(self.put(self.bob, {'mentions': False, 'artifacts': False})['status'], 200)
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.bob.app = reopened
        self.assertEqual(self.bob.call('GET', self.prefs_path)['body']['prefs'],
                         {'mentions': False, 'task_completion': True, 'artifacts': False})

    def test_artifact_preference_gates_the_saved_work_notification(self):
        # A chat-sourced artifact is a work another member saved in a shared
        # conversation; bob is a member of this group and did not save it.
        message = self.send(self.carol, '作品正文')['body']['message']
        with self.app.store.transaction() as db:
            artifact_id, title = uuid4().hex, '周报草稿'
            db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
                       (artifact_id, self.wid, title, hashlib.sha256(title.encode()).hexdigest(), 'document',
                        '作品正文', self.now, self.now, self.ids['carol'], self.ids['carol'],
                        hashlib.sha256(artifact_id.encode()).hexdigest(),
                        hashlib.sha256(('req' + artifact_id).encode()).hexdigest()))
            db.execute('INSERT INTO artifact_chat_sources VALUES(?,?,?,?,?,?)',
                       (artifact_id, self.wid, self.conv, message['id'], None, self.now))
        items = self.bob.call('GET', self.inbox)['body']['items']
        self.assertEqual([item['kind'] for item in items], ['artifact'])
        self.assertEqual(items[0]['excerpt'], '保存了作品「周报草稿」')
        self.assertEqual(items[0]['actor_username'], 'carol')
        self.assertEqual(items[0]['id'], artifact_id)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        # The author of the work is not notified about her own save.
        self.assertEqual(self.carol.call('GET', self.inbox)['body']['items'], [])
        self.assertEqual(self.put(self.bob, {'artifacts': False})['status'], 200)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['items'], [])
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 0)
        self.assertEqual(self.put(self.bob, {'artifacts': True})['status'], 200)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        # Reading one artifact notification is a server-side read marker.
        self.assertEqual(self.bob.call('POST', self.inbox + '/read', {'notification_id': artifact_id})['status'], 200)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 0)
        self.assertTrue(self.bob.call('GET', self.inbox)['body']['items'][0]['read'])
        # Another user cannot mark bob's work notification read.
        self.assertEqual(self.carol.call('POST', self.inbox + '/read',
                                         {'notification_id': artifact_id})['status'], 404)


class TaskCompletionPrefTests(unittest.TestCase):
    setUp = group_tests.GroupAgentReplyTests.setUp
    _user_id = group_tests.GroupAgentReplyTests._user_id
    base = group_tests.GroupAgentReplyTests.base
    create = group_tests.GroupAgentReplyTests.create
    make_agent = group_tests.GroupAgentReplyTests.make_agent
    group = group_tests.GroupAgentReplyTests.group
    trigger = group_tests.GroupAgentReplyTests.trigger
    connect = group_tests.GroupAgentReplyTests.connect

    def inbox(self, query=''):
        return self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications' + query)['body']

    def test_turning_off_task_completion_hides_the_derived_reply_item(self):
        path = self.group()
        agent = self.connect()
        tid = self.trigger(path)['body']['reply']['task_id']
        agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        agent.call('POST', f'/v1/agent/tasks/{tid}/result', {'status': 'failed', 'result': {'error': 'boom'}})
        self.assertEqual(self.inbox()['unread_count'], 1)
        self.assertEqual(self.alice.call('PUT', '/v1/notification-prefs', {'changes': {'task_completion': False}})['status'],
                         200)
        self.assertEqual(self.inbox()['items'], [])
        self.assertEqual(self.inbox()['unread_count'], 0)
        self.assertEqual(self.alice.call('PUT', '/v1/notification-prefs', {'changes': {'task_completion': True}})['status'],
                         200)
        self.assertEqual(self.inbox()['unread_count'], 1)


if __name__ == '__main__':
    unittest.main()
