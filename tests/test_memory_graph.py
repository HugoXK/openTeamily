"""Workspace memory graph, topics and links. In-process WSGI only; not browser E2E."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.memory import mention_titles
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MemoryGraphTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def create(self, client=None, title='Notes', body='', topics=None, key='memory-graph-create01'):
        payload = {'title': title, 'body': body}
        if topics is not None:
            payload['topics'] = topics
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/memory', payload,
            {'HTTP_IDEMPOTENCY_KEY': key},
        )

    def link(self, source, target, client=None, key='memory-link-create001', csrf=True, origin=None):
        kw = {'csrf': csrf}
        if origin is not None:
            kw['origin'] = origin
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/memory/links',
            {'source': source, 'target': target},
            {'HTTP_IDEMPOTENCY_KEY': key}, **kw
        )

    def graph(self, client=None):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/memory/graph')

    def test_topics_mentions_and_manual_links_build_a_graph(self):
        self.assertEqual(mention_titles('See [[Welcome]] and [[Welcome]] and [[ Missing ]]'), ['Welcome', 'Missing'])
        empty = self.graph()
        self.assertEqual(empty['status'], 200, empty)
        self.assertEqual(empty['body']['nodes'], [])
        self.assertEqual(empty['body']['edges'], [])
        self.assertEqual(empty['body']['topics'], [])
        self.assertEqual(empty['body']['counts'], {'nodes': 0, 'edges': 0, 'topics': 0})

        first = self.create(title='Welcome to Teamily', body='Intro', topics=['Getting Started'],
                            key='memory-graph-create-a1')
        second = self.create(title='Teamily Wiki', body='See [[Welcome to Teamily]]',
                             topics=['Getting Started', 'getting started'],
                             key='memory-graph-create-b1')
        third = self.create(title='Welcome to my wiki', body='Home', topics=['Getting Started'],
                            key='memory-graph-create-c1')
        for item in (first, second, third):
            self.assertEqual(item['status'], 201, item)
        self.assertEqual(second['body']['page']['topics'], ['Getting Started'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/memory')
        self.assertEqual(listed['status'], 200)
        self.assertTrue(all('topics' in item and 'body' not in item for item in listed['body']['items']))

        seen = self.graph()
        self.assertEqual(seen['status'], 200, seen)
        self.assertEqual(seen['body']['counts']['nodes'], 3)
        self.assertEqual(seen['body']['counts']['topics'], 1)
        self.assertEqual(seen['body']['counts']['edges'], 1)
        self.assertEqual(seen['body']['topics'][0]['name'], 'Getting Started')
        self.assertEqual(seen['body']['topics'][0]['page_count'], 3)
        mention = seen['body']['edges'][0]
        self.assertEqual(mention['kind'], 'mention')
        self.assertIsNone(mention['id'])
        ends = {mention['source'], mention['target']}
        self.assertEqual(ends, {first['body']['page']['id'], second['body']['page']['id']})

        linked = self.link(first['body']['page']['id'], third['body']['page']['id'])
        self.assertEqual(linked['status'], 201, linked)
        self.assertEqual(linked['body']['link']['kind'], 'manual')
        self.assertEqual(linked['body']['link']['created_by'], 'alice')
        again = self.link(first['body']['page']['id'], third['body']['page']['id'])
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['link']['id'], linked['body']['link']['id'])
        duplicate = self.link(third['body']['page']['id'], first['body']['page']['id'],
                              key='memory-link-create002')
        self.assertEqual(duplicate['status'], 409)

        merged = self.graph()
        self.assertEqual(merged['status'], 200, merged)
        self.assertEqual(merged['body']['counts']['edges'], 2)
        kinds = {edge['kind'] for edge in merged['body']['edges']}
        self.assertEqual(kinds, {'mention', 'manual'})
        manual = [edge for edge in merged['body']['edges'] if edge['kind'] == 'manual'][0]
        self.assertEqual(manual['id'], linked['body']['link']['id'])

        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{second["body"]["page"]["id"]}',
            {'revision': 1, 'changes': {'topics': ['Wiki']}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['page']['topics'], ['Wiki'])
        self.assertEqual(saved['body']['page']['revision'], 2)
        after = self.graph()
        names = {item['name']: item['page_count'] for item in after['body']['topics']}
        self.assertEqual(names, {'Getting Started': 2, 'Wiki': 1})

        removed_page = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{first["body"]["page"]["id"]}/remove', {}
        )
        self.assertEqual(removed_page['status'], 200, removed_page)
        leftover = self.graph()
        self.assertEqual(leftover['status'], 200, leftover)
        self.assertEqual(leftover['body']['counts']['nodes'], 2)
        self.assertEqual(leftover['body']['counts']['edges'], 0)
        self.assertEqual(
            self.alice.call(
                'GET', f'/v1/workspaces/{self.wid}/memory/links/{linked["body"]["link"]["id"]}/remove'
            )['status'],
            404,
        )

    def test_permissions_csrf_quota_and_schema_v1(self):
        first = self.create(title='Alpha', key='memory-graph-create-p1')
        second = self.create(title='Beta', key='memory-graph-create-p2')
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(second['status'], 201, second)
        source, target = first['body']['page']['id'], second['body']['page']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/memory/graph')['status'], 200)
        created = self.link(source, target, self.bob, key='memory-link-bob-000001')
        self.assertEqual(created['status'], 201, created)
        denied = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/links/{created["body"]["link"]["id"]}/remove', {}
        )
        # alice is owner, so she can remove bob's link
        self.assertEqual(denied['status'], 200, denied)
        restored = self.link(source, target, self.bob, key='memory-link-bob-000002')
        self.assertEqual(restored['status'], 201, restored)
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/memory/graph')['status'], 404)
        self.assertEqual(
            outsider.call(
                'POST', f'/v1/workspaces/{self.wid}/memory/links',
                {'source': source, 'target': target},
                {'HTTP_IDEMPOTENCY_KEY': 'memory-link-carol-0001'},
            )['status'],
            404,
        )
        self.assertEqual(self.link(source, target, csrf=False, key='memory-link-csrf-00001')['status'], 403)
        self.assertEqual(
            self.link(source, target, origin='https://evil.test', key='memory-link-csrf-00002')['status'], 403
        )
        self.assertEqual(self.create(title='Bad', topics=[''] , key='memory-graph-create-bad')['status'], 400)
        self.assertEqual(self.create(title='Self', body='See [[Self]]', key='memory-graph-create-slf')['status'], 201)
        isolated = self.graph()
        self.assertFalse(any(edge['source'] == edge['target'] for edge in isolated['body']['edges']))
        self.assertIn('Self', [node['title'] for node in isolated['body']['nodes']])

        bob_edit = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{first["body"]["page"]["id"]}',
            {'revision': 1, 'changes': {'topics': ['Nope']}},
        )
        self.assertEqual(bob_edit['status'], 403)
        owned = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/memory/{first["body"]["page"]["id"]}',
            {'revision': 1, 'changes': {'topics': ['Only alice']}},
        )
        self.assertEqual(owned['status'], 200, owned)

        other = self.alice.workspace(name='Other', key='request_example_0002')
        other_id = other['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other_id}/memory/graph')['status'], 404)

        self.app.config = replace(self.app.config, max_memory_links_per_workspace=1)
        # one link already exists from bob
        extra = self.create(title='Gamma', key='memory-graph-create-p3')
        self.assertEqual(extra['status'], 201, extra)
        self.assertEqual(
            self.link(source, extra['body']['page']['id'], key='memory-link-quota-0001')['status'], 429
        )
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE memory_links')
            db.execute('DROP TABLE memory_page_topics')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            names = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE name IN ('memory_links', 'memory_page_topics')"
            )}
            self.assertEqual(names, {'memory_links', 'memory_page_topics'})


if __name__ == '__main__':
    unittest.main()
