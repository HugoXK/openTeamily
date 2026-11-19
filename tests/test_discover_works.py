"""Opt-in public works feed. In-process WSGI only; not Teamily acceptance."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class DiscoverWorksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.anon = Client(self.app, peer='127.0.0.9')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})

    def create(self, title='公开笔记', body='正文请勿出现在列表接口里。', key='discover-work-0001', **fields):
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': title, 'body': body, **fields},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['artifact']

    def publish(self, client, artifact, slug, workspace_id=None):
        return client.call(
            'POST', f'/v1/workspaces/{workspace_id or self.wid}/artifacts/{artifact["id"]}/discover',
            {'slug': slug})

    def test_publish_lists_only_the_public_projection(self):
        empty = self.anon.call('GET', '/v1/discover/works')
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'], [])
        self.assertIsNone(empty['body']['cursor'])
        artifact = self.create()
        unpublished = self.anon.call('GET', '/w/public-note')
        self.assertEqual(unpublished['status'], 404)
        published = self.publish(self.alice, artifact, 'public-note')
        self.assertEqual(published['status'], 201, published)
        self.assertEqual(published['body']['discover']['slug'], 'public-note')
        self.assertTrue(published['body']['discover']['listed'])
        listed = self.anon.call('GET', '/v1/discover/works')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        item = listed['body']['items'][0]
        self.assertEqual({k:v for k,v in item.items() if k not in ('likes','collections','liked','collected','following','own_work')}, {
            'slug': 'public-note',
            'title': '公开笔记',
            'kind': 'document',
            'kind_label': '文档',
            'author': 'alice',
            'updated': self.now,
            'path': '/w/public-note',
        })
        payload = str(listed['body'])
        self.assertNotIn(self.wid, payload)
        self.assertNotIn(artifact['id'], payload)
        self.assertNotIn('正文请勿出现在列表接口里。', payload)
        page = self.anon.call('GET', '/w/public-note', parse='raw')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('公开笔记', html)
        self.assertIn('正文请勿出现在列表接口里。', html)
        self.assertNotIn(self.wid, html)
        self.assertNotIn(artifact['id'], html)
        search = self.anon.call('GET', '/v1/discover/works?q=公开')
        self.assertEqual(len(search['body']['items']), 1)
        author = self.anon.call('GET', '/v1/discover/works?q=alice')
        self.assertEqual(len(author['body']['items']), 1)
        self.assertEqual(self.anon.call('GET', '/v1/discover/works?q=missing')['body']['items'], [])
        read = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}/discover')
        self.assertEqual(read['body']['discover']['slug'], 'public-note')
        again = self.publish(self.alice, artifact, 'public-note')
        self.assertEqual(again['status'], 200)

    def test_public_preview_serves_the_cover_model_for_listed_works_only(self):
        artifact = self.create(body='# 封面标题\n\n第一行正文')
        self.assertEqual(self.anon.call('GET', '/w/cover-note/preview')['status'], 404)
        self.assertEqual(self.publish(self.alice, artifact, 'cover-note')['status'], 201)
        preview = self.anon.call('GET', '/w/cover-note/preview')
        self.assertEqual(preview['status'], 200, preview)
        self.assertEqual(preview['body']['preview']['type'], 'document')
        self.assertIn('第一行正文', str(preview['body']['preview']))
        self.assertNotIn(self.wid, str(preview['body']))
        self.assertNotIn(artifact['id'], str(preview['body']))
        self.assertEqual(self.anon.call('GET', '/w/cover-note/preview?x=1')['status'], 400)
        self.assertEqual(self.anon.call('POST', '/w/cover-note/preview', {})['status'], 400)
        listed = self.anon.call('GET', '/v1/discover/works')
        self.assertNotIn('第一行正文', str(listed['body']))
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}/discover/revoke', {})
        self.assertEqual(self.anon.call('GET', '/w/cover-note/preview')['status'], 404)

    def test_permissions_conflict_validation_and_paging(self):
        first = self.create()
        second = self.create(title='另一篇', body='second', key='discover-work-0002')
        self.assertEqual(self.publish(self.bob, first, 'bob-slug')['status'], 403)
        self.assertEqual(self.publish(self.eve, first, 'eve-slug')['status'], 404)
        self.assertEqual(self.publish(self.alice, first, 'Bad Slug')['status'], 400)
        self.assertEqual(self.publish(self.alice, first, 'settings')['status'], 400)
        self.assertEqual(self.publish(self.alice, first, 'works')['status'], 400)
        self.assertEqual(self.publish(self.alice, first, 'public-note')['status'], 201)
        conflict = self.publish(self.alice, second, 'public-note')
        self.assertEqual(conflict['status'], 409)
        self.now = 1800000001
        published = self.publish(self.alice, second, 'other-note')
        self.assertEqual(published['status'], 201, published)
        page = self.anon.call('GET', '/v1/discover/works?limit=1')
        self.assertEqual(page['status'], 200)
        self.assertEqual([item['slug'] for item in page['body']['items']], ['other-note'])
        self.assertEqual(page['body']['cursor'], '1800000001.other-note')
        rest = self.anon.call('GET', '/v1/discover/works?limit=1&cursor=1800000001.other-note')
        self.assertEqual([item['slug'] for item in rest['body']['items']], ['public-note'])
        self.assertIsNone(rest['body']['cursor'])
        self.assertEqual(self.anon.call('GET', '/v1/discover/works?cursor=nope')['status'], 400)
        member = self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{first["id"]}/discover')
        self.assertEqual(member['status'], 200)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{first["id"]}/discover/revoke', {})
        self.assertEqual(revoked['status'], 200)
        self.assertFalse(revoked['body']['discover']['listed'])
        remaining = self.anon.call('GET', '/v1/discover/works')
        self.assertEqual([item['slug'] for item in remaining['body']['items']], ['other-note'])
        self.assertEqual(self.anon.call('GET', '/w/public-note')['status'], 404)

    def test_csrf_and_anonymous_writes_are_rejected(self):
        artifact = self.create()
        self.assertEqual(self.anon.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}/discover',
            {'slug': 'anon-note'})['status'], 401)
        self.assertEqual(self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}/discover',
            {'slug': 'public-note'}, csrf=False)['status'], 403)

    def test_type_filters_apply_before_search_and_cursor_paging(self):
        from tests.test_artifact_media import multipart, PNG
        for index, kind in enumerate(('document', 'website', 'website')):
            item = self.create(title='Type fixture ' + str(index), body='safe body',
                               key='work-type-create-%04d' % index, kind=kind)
            self.assertEqual(self.publish(self.alice, item, 'type-work-%d' % index)['status'], 201)
        raw, content_type = multipart([('title', 'Type image'), ('kind', 'media')],
                                      [('file', 'fixture.png', 'image/png', PNG)])
        media = self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts', raw=raw,
                                headers={'CONTENT_TYPE': content_type,
                                         'HTTP_IDEMPOTENCY_KEY': 'work-type-image-0001'})
        self.assertEqual(media['status'], 201, media)
        self.assertEqual(self.publish(self.alice, media['body']['artifact'], 'type-photo')['status'], 201)
        first = self.anon.call('GET', '/v1/discover/works?kind=website&limit=1')
        self.assertEqual([x['slug'] for x in first['body']['items']], ['type-work-2'])
        cursor = first['body']['cursor']
        second = self.anon.call('GET', '/v1/discover/works?kind=website&limit=1&cursor=' + cursor)
        self.assertEqual([x['slug'] for x in second['body']['items']], ['type-work-1'])
        self.assertIsNone(second['body']['cursor'])
        self.assertEqual(len(self.anon.call('GET', '/v1/discover/works?kind=website&q=alice')['body']['items']), 2)
        self.assertEqual(self.anon.call('GET', '/v1/discover/works?kind=website&q=missing')['body']['items'], [])
        self.assertEqual([x['slug'] for x in self.anon.call('GET', '/v1/discover/works?kind=image')['body']['items']], ['type-photo'])
        for kind in ('video', 'audio', 'slides'):
            self.assertEqual(self.anon.call('GET', '/v1/discover/works?kind=' + kind)['body']['items'], [])
        for query in ('kind=bogus', 'kind=website&kind=image', 'kind=Website'):
            self.assertEqual(self.anon.call('GET', '/v1/discover/works?' + query)['status'], 400)
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{media["body"]["artifact"]["id"]}/discover/revoke', {})['status'], 200)
        self.assertEqual(self.anon.call('GET', '/v1/discover/works?kind=image')['body']['items'], [])

    def test_creator_filter_lists_only_that_author_and_the_creator_list_names_them(self):
        alice_note = self.create(title='Alice 笔记', key='creator-work-0001')
        self.assertEqual(self.publish(self.alice, alice_note, 'alice-note')['status'], 201)
        bob_wid = self.bob.workspace()['body']['workspace']['id']
        bob_work = self.bob.call(
            'POST', f'/v1/workspaces/{bob_wid}/artifacts',
            {'title': 'Bob 网页', 'body': 'bob body', 'kind': 'website'},
            {'HTTP_IDEMPOTENCY_KEY': 'creator-work-0002'})
        self.assertEqual(bob_work['status'], 201, bob_work)
        self.assertEqual(
            self.publish(self.bob, bob_work['body']['artifact'], 'bob-site', bob_wid)['status'], 201)
        unlisted = self.create(title='未收录的笔记', key='creator-work-0003')

        alice_only = self.anon.call('GET', '/v1/discover/works?creator=alice')
        self.assertEqual(alice_only['status'], 200, alice_only)
        self.assertEqual([item['slug'] for item in alice_only['body']['items']], ['alice-note'])
        bob_only = self.anon.call('GET', '/v1/discover/works?creator=bob')
        self.assertEqual([item['slug'] for item in bob_only['body']['items']], ['bob-site'])
        self.assertEqual(self.anon.call('GET', '/v1/discover/works?creator=nobody')['body']['items'], [])
        self.assertEqual(
            [item['slug'] for item in self.anon.call('GET', '/v1/discover/works?creator=alice&kind=website')['body']['items']],
            [])
        self.assertEqual(
            [item['slug'] for item in self.anon.call('GET', '/v1/discover/works?creator=bob&kind=website')['body']['items']],
            ['bob-site'])

        creators = self.anon.call('GET', '/v1/discover/creators')
        self.assertEqual(creators['status'], 200, creators)
        handles = [item['handle'] for item in creators['body']['items']]
        self.assertEqual(sorted(handles), ['alice', 'bob'])
        self.assertEqual(set(creators['body']['items'][0]), {'handle', 'works'})
        payload = str(creators['body'])
        self.assertNotIn(self.wid, payload)
        self.assertNotIn(alice_note['id'], payload)
        self.assertNotIn(unlisted['title'], payload)

        for query in ('creator=', 'creator=a', 'creator=Al ice', 'creator=alice&creator=bob',
                      'creator=alice&x=1', 'creator=Alice'):
            self.assertEqual(self.anon.call('GET', '/v1/discover/works?' + query)['status'], 400, query)

        from openteamily.settings_page import SettingsPage
        from tests.test_settings_page import RawClient
        pages = RawClient(SettingsPage(self.app))
        self.assertEqual(pages.call('GET', '/discover', query='creator=alice')['status'], 200)
        self.assertEqual(pages.call('GET', '/discover', query='creator=alice&kind=document')['status'], 200)
        for query in ('creator=', 'creator=a', 'creator=alice&x=1', 'creator=alice&creator=bob',
                      'creator=Al%20ice', 'creator=alice&kind=bogus'):
            self.assertEqual(pages.call('GET', '/discover', query=query)['status'], 400, query)
