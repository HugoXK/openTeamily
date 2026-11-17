"""Public agent homepage tests (issue #6). In-process WSGI + temporary SQLite only.

These tests prove share-link access control and the recorded public
profile typography. They are not browser E2E, embeddable conversations,
a live container run, or Teamily parity.
"""
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class AgentHomepageTests(unittest.TestCase):
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
        self.guest = RawClient(self.app)

    def create(self, client=None, name='文档助手', summary='整理笔记', instructions='系统提示请保密。',
               key='agent-home-create-01'):
        client = client or self.alice
        created = client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': name, 'summary': summary, 'instructions': instructions},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def publish(self, client, agent_id, **kw):
        return client.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent_id}/homepage', {}, **kw)

    def test_default_is_restricted_and_unknown_tokens_are_404(self):
        item = self.create()
        self.assertEqual(item['homepage'], {'visibility': 'restricted'})
        self.assertNotIn('token', item)
        self.assertNotIn('token', item['homepage'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual(listed['body']['items'][0]['homepage']['visibility'], 'restricted')
        missing = self.guest.call('GET', '/a/' + ('A' * 43), origin=None)
        self.assertEqual(missing['status'], 404)
        self.assertNotIn('系统提示'.encode(), missing['body'])

    def test_publish_shows_token_once_and_public_page_hides_instructions(self):
        item = self.create()
        published = self.publish(self.alice, item['id'])
        self.assertEqual(published['status'], 201, published)
        home = published['body']['agent']['homepage']
        self.assertEqual(home['visibility'], 'public')
        self.assertEqual(home['prefix'], home['token'][:8])
        self.assertEqual(home['path'], '/a/' + home['token'])
        token = home['token']
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['agent']['homepage']['visibility'], 'public')
        self.assertEqual(seen['body']['agent']['homepage']['prefix'], token[:8])
        self.assertNotIn('token', seen['body']['agent']['homepage'])
        self.assertNotIn('path', seen['body']['agent']['homepage'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')
        self.assertNotIn('token', listed['body']['agent']['homepage'])
        page = self.guest.call('GET', '/a/' + token, origin=None)
        self.assertEqual(page['status'], 200, page)
        html = page['body'].decode()
        self.assertIn('文档助手', html)
        self.assertIn('整理笔记', html)
        self.assertIn('OpenTeamily / FlyBot', html)
        self.assertIn('Agent profile', html)
        self.assertIn('Public page', html)
        self.assertIn('Talk via', html)
        self.assertIn('Web conversation', html)
        self.assertIn('Talk directly with 文档助手.', html)
        self.assertIn('Built with FlyBot', html)
        self.assertIn('Create your own Agent', html)
        self.assertIn('disabled', html)
        self.assertIn('未接通：公开主页不会发送消息。', html)
        self.assertIn('未接通：公开主页不会创建智能体。', html)
        self.assertIn('does not run a conversation', html)
        self.assertNotIn('AVAILABLE NOW', html)
        self.assertNotIn('LIVE', html)
        self.assertIsNone(re.search(r'(?<!Open)Teamily', html))
        self.assertNotIn('系统提示请保密。', html)
        self.assertNotIn(item['id'], html)
        self.assertNotIn(self.wid, html)
        self.assertNotIn(token, html)
        self.assertIn('>文<', html)  # letter avatar, not a copied mark
        self.assertIn('text/html', page['headers']['Content-Type'])
        self.assertIn("frame-ancestors 'none'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['X-Frame-Options'], 'DENY')
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        same_origin = self.guest.call('GET', '/a/' + token)
        self.assertEqual(same_origin['status'], 200)

    def test_members_can_read_but_only_owners_and_admins_publish(self):
        item = self.create()
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'carol', 'role': 'admin'})
        self.assertEqual(self.publish(self.bob, item['id'])['status'], 403)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')['status'], 200)
        outsider = Client(self.app, peer='127.0.0.4')
        outsider.register('drew')
        self.assertEqual(self.publish(outsider, item['id'])['status'], 404)
        self.assertEqual(
            outsider.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')['status'], 404)
        published = self.publish(self.carol, item['id'])
        self.assertEqual(published['status'], 201, published)
        token = published['body']['agent']['homepage']['token']
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 200)
        member_view = self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(member_view['body']['agent']['homepage']['prefix'], token[:8])
        self.assertNotIn('token', member_view['body']['agent']['homepage'])

    def test_revoke_rotate_archive_and_csrf(self):
        item = self.create()
        first = self.publish(self.alice, item['id'])
        token = first['body']['agent']['homepage']['token']
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 200)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage/revoke', {})
        self.assertEqual(revoked['status'], 200, revoked)
        self.assertEqual(revoked['body']['agent']['homepage'], {'visibility': 'restricted'})
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 404)
        rotated = self.publish(self.alice, item['id'])
        self.assertEqual(rotated['status'], 201, rotated)
        new_token = rotated['body']['agent']['homepage']['token']
        self.assertNotEqual(new_token, token)
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 404)
        self.assertEqual(self.guest.call('GET', '/a/' + new_token, origin=None)['status'], 200)
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        self.assertEqual(archived['body']['agent']['homepage'], {'visibility': 'restricted'})
        self.assertEqual(self.guest.call('GET', '/a/' + new_token, origin=None)['status'], 404)
        self.assertEqual(
            self.publish(self.alice, item['id'])['status'], 409)
        fresh = self.create(name='第二个', key='agent-home-create-02')
        self.assertEqual(self.publish(self.alice, fresh['id'], csrf=False)['status'], 403)
        self.assertEqual(
            self.publish(self.alice, fresh['id'], origin='https://evil.test')['status'], 403)
        anonymous = Client(self.app)
        self.assertEqual(self.publish(anonymous, fresh['id'])['status'], 401)
        self.assertEqual(self.guest.call('POST', '/a/' + ('B' * 43), origin=None)['status'], 400)
        self.assertEqual(self.guest.call('GET', '/a/' + ('B' * 43), query='x=1', origin=None)['status'], 400)

    def test_homepage_typography_escapes_name_and_omits_unverified_chrome(self):
        from openteamily.agents import render_homepage
        html = render_homepage({
            'name': '<Script>Bot',
            'summary': 'Hello & goodbye',
        })
        self.assertIn('&lt;Script&gt;Bot', html)
        self.assertIn('Hello &amp; goodbye', html)
        self.assertIn('>S<', html)
        self.assertNotIn('<Script>', html)
        self.assertIsNone(re.search(r'(?<!Open)Teamily', html))
        self.assertNotIn('AVAILABLE NOW', html)
        self.assertIn('placeholder="Message &lt;Script&gt;Bot on the web…"', html)
        self.assertIn('disabled', html)

    def test_existing_v1_database_gains_the_homepage_table(self):
        self.create()
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_agent_homepages')
            db.commit()
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(
                db.execute("SELECT name FROM sqlite_master WHERE name='workspace_agent_homepages'").fetchone())


if __name__ == '__main__':
    unittest.main()
