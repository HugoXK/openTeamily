"""Message reminders: a reminder typed on a chat message is a real once automation,
and its due time reaches the notification panel (issue #336). No agent or runtime is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

# 1800000000 = 2027-01-15T08:00:00Z = 2027-01-15 16:00 in Asia/Shanghai.
NOW = 1800000000
DUE = {'kind': 'once', 'date': '2027-01-15', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
FUTURE = {'kind': 'once', 'date': '2027-01-16', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
MESSAGE_ID = 'a' * 32
TITLE = '提醒：周五前把方案发给客户'


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: NOW)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.automations = f'/v1/workspaces/{self.wid}/automations'
        self.inbox = f'/v1/workspaces/{self.wid}/notifications'

    def remind(self, schedule=DUE, key='remind-' + MESSAGE_ID, title=TITLE, client=None,
               participants=('alice',)):
        return (client or self.alice).call('POST', self.automations, {
            'title': title, 'prompt': '提醒我回看这条消息：周五前把方案发给客户',
            'template_id': 'reminder', 'schedule': schedule,
            'participants': list(participants), 'scope': 'once', 'intent': '', 'agents': [],
        }, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_a_chat_reminder_is_a_real_enabled_once_automation(self):
        created = self.remind()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['automation']
        self.assertEqual(item['template_id'], 'reminder')
        self.assertEqual(item['schedule'], DUE)
        self.assertTrue(item['enabled'], 'a reminder that is not enabled never fires')
        self.assertEqual([row['username'] for row in item['participants']], ['alice'])
        listed = self.alice.call('GET', self.automations)
        self.assertEqual([row['id'] for row in listed['body']['items']], [item['id']])

    def test_repeating_the_same_message_keeps_one_reminder_and_is_not_a_conflict(self):
        first = self.remind()
        self.assertEqual(first['status'], 201, first)
        second = self.remind(schedule=FUTURE)
        self.assertEqual(second['status'], 200, second)
        self.assertEqual(second['body']['automation']['id'], first['body']['automation']['id'])
        listed = self.alice.call('GET', self.automations)['body']['items']
        self.assertEqual(len(listed), 1, 'a second reminder for the same message must not be stored')
        other = self.remind(key='remind-' + 'b' * 32, title='提醒：另一条消息')
        self.assertEqual(other['status'], 201, other)

    def test_a_due_reminder_reaches_its_owner_in_the_notification_panel(self):
        created = self.remind()
        self.assertEqual(created['status'], 201, created)
        fired = self.alice.call('POST', f'{self.automations}/tick')
        self.assertEqual(fired['status'], 200, fired)
        self.assertEqual(len(fired['body']['items']), 1, fired)
        inbox = self.alice.call('GET', self.inbox)
        self.assertEqual(inbox['status'], 200, inbox)
        self.assertEqual(inbox['body']['unread_count'], 1, inbox)
        item = inbox['body']['items'][0]
        self.assertEqual(item['kind'], 'automation_reminder')
        self.assertEqual(item['title'], TITLE)
        self.assertEqual(item['automation_id'], created['body']['automation']['id'])
        self.assertFalse(item['read'])
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['items'], [])
        self.alice.call('POST', f'{self.automations}/tick')
        self.assertEqual(self.alice.call('GET', self.inbox)['body']['unread_count'], 1)
        marked = self.alice.call('POST', f'{self.inbox}/read', {'notification_id': item['id']})
        self.assertEqual(marked['body']['unread_count'], 0, marked)
        self.assertTrue(self.alice.call('GET', self.inbox)['body']['items'][0]['read'])
        self.alice.call('POST', f'{self.inbox}/read', {'all': True})
        self.assertEqual(self.alice.call('GET', self.inbox)['body']['unread_count'], 0)

    def test_a_future_reminder_is_not_a_notification_yet(self):
        self.assertEqual(self.remind(schedule=FUTURE)['status'], 201)
        self.alice.call('POST', f'{self.automations}/tick')
        self.assertEqual(self.alice.call('GET', self.inbox)['body']['items'], [])

    def test_only_the_owner_or_admin_can_set_a_reminder(self):
        refused = self.remind(client=self.bob)
        self.assertEqual(refused['status'], 403, refused)
        self.assertEqual(refused['body']['error']['code'], 'forbidden')


if __name__ == '__main__':
    unittest.main()
