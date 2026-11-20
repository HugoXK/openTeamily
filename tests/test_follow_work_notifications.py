"""Follower 作品通知 for a followed creator's newly listed public work.

Reuses discover_follows and the notifications inbox; no push, no second pipeline.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class FollowWorkNotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.bob = Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.bwid = self.bob.workspace()['body']['workspace']['id']
        self.alice_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.inbox = f'/v1/workspaces/{self.bwid}/notifications'
        self.switches = '/v1/profile/follow-work'

    def publish(self, slug, title='公开笔记', key='follow-work-0001'):
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': title, 'body': '正文'}, {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        artifact = created['body']['artifact']
        listed = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}/discover', {'slug': slug})
        self.assertEqual(listed['status'], 201, listed)
        return artifact

    def follow(self, slug, enabled=True):
        result = self.bob.call('POST', f'/v1/discover/works/{slug}/engagement',
                               {'action': 'follow', 'enabled': enabled})
        self.assertEqual(result['status'], 200, result)
        return result

    def switch(self, creator_id, enabled):
        return self.bob.call('POST', self.switches, {'creator_id': creator_id, 'enabled': enabled})

    def test_the_switch_only_exists_for_a_creator_you_already_follow(self):
        self.publish('alice-note-1')
        self.assertEqual(self.bob.call('GET', self.switches)['body']['items'], [])
        refused = self.switch(self.alice_id, True)
        self.assertEqual(refused['status'], 400, refused)
        self.follow('alice-note-1')
        items = self.bob.call('GET', self.switches)['body']['items']
        self.assertEqual(len(items), 1, items)
        self.assertEqual((items[0]['creator_id'], items[0]['username'], items[0]['enabled']),
                         (self.alice_id, 'alice', False))
        turned = self.switch(self.alice_id, True)
        self.assertEqual(turned['status'], 200, turned)
        self.assertTrue(turned['body']['item']['enabled'])
        self.assertTrue(self.bob.call('GET', self.switches)['body']['items'][0]['enabled'])
        self.assertEqual(self.alice.call('GET', self.switches)['body']['items'], [])

    def test_a_new_public_work_reaches_the_follower_inbox_with_title_and_link(self):
        self.publish('alice-note-1')
        self.follow('alice-note-1')
        self.assertEqual(self.switch(self.alice_id, True)['status'], 200)
        self.publish('alice-note-2', title='第二篇公开笔记', key='follow-work-0002')
        inbox = self.bob.call('GET', self.inbox)
        self.assertEqual(inbox['status'], 200, inbox)
        self.assertEqual(inbox['body']['unread_count'], 1)
        item = inbox['body']['items'][0]
        self.assertEqual((item['kind'], item['actor_username'], item['title'], item['slug'], item['path']),
                         ('follow_work', 'alice', '第二篇公开笔记', 'alice-note-2', '/w/alice-note-2'))
        self.assertFalse(item['read'])
        # Re-listing the same work is not a second notification.
        again = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{inbox["body"]["items"][0]["artifact_id"]}/discover',
            {'slug': 'alice-note-2'})
        self.assertEqual(again['status'], 200, again)
        self.assertEqual(len(self.bob.call('GET', self.inbox)['body']['items']), 1)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')['body']['items'], [])
        read = self.bob.call('POST', self.inbox + '/read', {'notification_id': item['id']})
        self.assertEqual(read['status'], 200, read)
        self.assertEqual(read['body']['unread_count'], 0)

    def test_turning_the_switch_off_stops_new_notifications(self):
        self.publish('alice-note-1')
        self.follow('alice-note-1')
        self.assertEqual(self.switch(self.alice_id, True)['status'], 200)
        self.publish('alice-note-2', title='开启时的作品', key='follow-work-0002')
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        self.assertEqual(self.switch(self.alice_id, False)['status'], 200)
        self.publish('alice-note-3', title='关闭后的作品', key='follow-work-0003')
        after = self.bob.call('GET', self.inbox)
        self.assertEqual(after['body']['unread_count'], 1)
        self.assertEqual([item['title'] for item in after['body']['items']], ['开启时的作品'])

    def test_unfollowing_and_unlisting_never_leave_a_dangling_item(self):
        self.publish('alice-note-1')
        self.follow('alice-note-1')
        self.assertEqual(self.switch(self.alice_id, True)['status'], 200)
        self.publish('alice-note-2', title='会被撤回的作品', key='follow-work-0002')
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/'
                               + self.bob.call('GET', self.inbox)['body']['items'][0]['artifact_id']
                               + '/discover/revoke')
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['items'], [])

    def test_the_switch_requires_a_signed_in_user(self):
        anon = Client(self.app, peer='127.0.0.9')
        self.assertEqual(anon.call('GET', self.switches)['status'], 401)
        self.assertEqual(anon.call('POST', self.switches, {'creator_id': self.alice_id, 'enabled': True})['status'], 401)

    def test_switch_csrf_rejection_leaves_follow_work_disabled(self):
        self.publish('csrf-follow-note')
        self.follow('csrf-follow-note')
        denied = self.bob.call('POST', self.switches,
                               {'creator_id': self.alice_id, 'enabled': True}, csrf=False)
        self.assertEqual(denied['status'], 403, denied)
        self.assertFalse(self.bob.call('GET', self.switches)['body']['items'][0]['enabled'])
        self.assertEqual(self.alice.call('GET', self.inbox)['status'], 404)

    def test_unfollowing_stops_delivery_even_if_subscription_was_enabled(self):
        self.publish('before-unfollow')
        self.follow('before-unfollow')
        self.assertEqual(self.switch(self.alice_id, True)['status'], 200)
        self.follow('before-unfollow', enabled=False)
        self.publish('after-unfollow', title='Post-unfollow work', key='after-unfollow-0001')
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['items'], [])

    def test_unfollowing_hides_previously_delivered_work_and_unread_count(self):
        self.publish('follow-visibility-first')
        self.follow('follow-visibility-first')
        self.assertEqual(self.switch(self.alice_id, True)['status'], 200)
        self.publish('follow-visibility-second', title='Previously delivered', key='follow-visibility-0002')
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        self.follow('follow-visibility-first', enabled=False)
        inbox = self.bob.call('GET', self.inbox)['body']
        self.assertEqual(inbox['items'], [])
        self.assertEqual(inbox['unread_count'], 0)
