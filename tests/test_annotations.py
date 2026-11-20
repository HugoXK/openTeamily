"""Annotation persistence tests. In-process WSGI + temporary SQLite only.

These tests exercise local threaded annotations directly against the store;
they do not claim HTTP routes, UI, or live collaboration.
"""
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import annotations
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


NOW = 1800000000


class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = (Path(self.temp.name) / 'state').resolve()
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: NOW)
        self.alice = Client(self.app)
        registered = self.alice.register('alice')
        self.alice_id = registered['body']['user']['id']
        self.bob = Client(self.app, peer='127.0.0.2')
        registered = self.bob.register('bob')
        self.bob_id = registered['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.aid = 'artifact-notes-0001'
        with self.app.store.connect() as db:
            annotations.ensure_schema(db)

    def other_workspace(self):
        response = self.alice.workspace(name='Other', key='request_example_0002')
        self.assertEqual(response['status'], 201, response)
        return response['body']['workspace']['id']

    def create(self, db, revision=1, user=None, now=NOW, anchor=None, body=None,
               workspace_id=None, artifact_id=None):
        return annotations.create_thread(
            db, workspace_id or self.wid, artifact_id or self.aid, revision,
            user or self.alice_id, now, anchor=anchor, body=body,
        )

    def test_schema_is_idempotent_and_keeps_v1(self):
        with self.app.store.connect() as db:
            annotations.ensure_schema(db)
            annotations.ensure_schema(db)
            names = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
            self.assertIn('annotation_threads', names)
            self.assertIn('annotation_comments', names)
            self.assertIn('annotation_thread_artifact', names)
            self.assertIn('annotation_comment_thread', names)
            thread_columns = {row['name'] for row in db.execute(
                'PRAGMA table_info(annotation_threads)')}
            comment_columns = {row['name'] for row in db.execute(
                'PRAGMA table_info(annotation_comments)')}
            self.assertTrue({
                'id', 'workspace_id', 'artifact_id', 'artifact_revision', 'anchor',
                'resolved', 'created_by', 'created', 'updated',
            } <= thread_columns)
            self.assertTrue({
                'id', 'thread_id', 'workspace_id', 'author_id', 'body', 'mentions',
                'created', 'updated', 'deleted',
            } <= comment_columns)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_create_list_and_filter_by_revision_and_resolved(self):
        with self.app.store.connect() as db:
            first = self.create(db, revision=0, anchor='paragraph:1')
            second = self.create(db, revision=1, anchor='{"selector":"p"}', body='First @bob')
            third = self.create(db, revision=1, user=self.bob_id, now=NOW + 1)
            self.assertEqual(first['artifact_revision'], 0)
            self.assertEqual(first['anchor'], 'paragraph:1')
            self.assertFalse(first['resolved'])
            self.assertEqual(first['created_by'], self.alice_id)
            self.assertEqual(second['comments'][0]['body'], 'First @bob')
            self.assertEqual(second['comments'][0]['mentions'], ['bob'])
            self.assertEqual(third['comments'], [])

            all_threads = annotations.list_threads(db, self.wid, self.aid, limit=10, cursor=None)
            self.assertEqual({item['id'] for item in all_threads}, {first['id'], second['id'], third['id']})
            revision_zero = annotations.list_threads(
                db, self.wid, self.aid, revision=0, limit=10, cursor=None)
            self.assertEqual([item['id'] for item in revision_zero], [first['id']])
            revision_one = annotations.list_threads(
                db, self.wid, self.aid, revision=1, limit=10, cursor=None)
            self.assertEqual({item['id'] for item in revision_one}, {second['id'], third['id']})

            annotations.resolve_thread(db, self.wid, first['id'], NOW + 2)
            open_threads = annotations.list_threads(
                db, self.wid, self.aid, resolved=False, limit=10, cursor=None)
            resolved_threads = annotations.list_threads(
                db, self.wid, self.aid, resolved=True, limit=10, cursor=None)
            self.assertEqual({item['id'] for item in open_threads}, {second['id'], third['id']})
            self.assertEqual([item['id'] for item in resolved_threads], [first['id']])

    def test_comment_lifecycle_mentions_and_author_only_mutation(self):
        with self.app.store.connect() as db:
            thread = self.create(db, body='root comment')
            comment = annotations.add_comment(
                db, self.wid, thread['id'], self.bob_id,
                '@alice @bob @bob. a@bob.com @a @ab', NOW + 1)
            self.assertEqual(comment['author_id'], self.bob_id)
            self.assertEqual(comment['mentions'], ['alice', 'bob'])
            self.assertFalse(comment['deleted'])

            with self.assertRaises(PermissionError):
                annotations.edit_comment(db, self.wid, comment['id'], self.alice_id, 'not mine', NOW + 2)
            edited = annotations.edit_comment(
                db, self.wid, comment['id'], self.bob_id, 'hello @alice', NOW + 2)
            self.assertEqual(edited['body'], 'hello @alice')
            self.assertEqual(edited['mentions'], ['alice'])
            self.assertEqual(edited['updated'], NOW + 2)

            with self.assertRaises(PermissionError):
                annotations.delete_comment(db, self.wid, comment['id'], self.alice_id, NOW + 3)
            deleted = annotations.delete_comment(
                db, self.wid, comment['id'], self.bob_id, NOW + 3)
            self.assertTrue(deleted['deleted'])
            self.assertEqual(deleted['updated'], NOW + 3)

            viewed = annotations.thread_view(db, self.wid, thread['id'])
            self.assertEqual([item['id'] for item in viewed['comments']], [thread['comments'][0]['id']])
            with db:
                row = db.execute(
                    'SELECT body, deleted FROM annotation_comments WHERE id=?', (comment['id'],)
                ).fetchone()
            self.assertEqual((row['body'], row['deleted']), ('hello @alice', 1))

            with self.assertRaises(LookupError):
                annotations.edit_comment(db, self.wid, comment['id'], self.bob_id, 'again', NOW + 4)

    def test_mentions_are_deduplicated_lowercase_and_bounded(self):
        names = [f'user{index:03d}' for index in range(annotations.MAX_MENTIONS + 5)]
        body = ' '.join('@' + name for name in names) + ' @USER000'
        with self.app.store.connect() as db:
            thread = self.create(db)
            comment = annotations.add_comment(db, self.wid, thread['id'], self.alice_id, body, NOW + 1)
            self.assertEqual(comment['mentions'], names[:annotations.MAX_MENTIONS])
            self.assertEqual(len(comment['mentions']), annotations.MAX_MENTIONS)
            self.assertEqual(len(set(comment['mentions'])), annotations.MAX_MENTIONS)
            with db:
                stored = db.execute(
                    'SELECT mentions FROM annotation_comments WHERE id=?', (comment['id'],)
                ).fetchone()['mentions']
            self.assertEqual(json.loads(stored), names[:annotations.MAX_MENTIONS])

    def test_resolve_unresolve_and_count_open(self):
        with self.app.store.connect() as db:
            first = self.create(db)
            second = self.create(db)
            third = self.create(db)
            self.assertEqual(annotations.count_open(db, self.wid, self.aid), 3)
            resolved = annotations.resolve_thread(db, self.wid, first['id'], NOW + 1)
            self.assertTrue(resolved['resolved'])
            self.assertEqual(resolved['updated'], NOW + 1)
            self.assertEqual(annotations.count_open(db, self.wid, self.aid), 2)
            reopened = annotations.resolve_thread(
                db, self.wid, first['id'], NOW + 2, resolved=False)
            self.assertFalse(reopened['resolved'])
            self.assertEqual(annotations.count_open(db, self.wid, self.aid), 3)
            annotations.resolve_thread(db, self.wid, second['id'], NOW + 3)
            self.assertEqual(annotations.count_open(db, self.wid, self.aid), 2)
            self.assertTrue(annotations.resolve_thread(
                db, self.wid, third['id'], NOW + 4)['resolved'])

    def test_workspace_isolation(self):
        other = self.other_workspace()
        with self.app.store.connect() as db:
            mine = self.create(db)
            theirs = self.create(db, workspace_id=other)
            self.assertEqual([item['id'] for item in annotations.list_threads(
                db, self.wid, self.aid, limit=10, cursor=None)], [mine['id']])
            self.assertEqual([item['id'] for item in annotations.list_threads(
                db, other, self.aid, limit=10, cursor=None)], [theirs['id']])
            self.assertEqual(annotations.count_open(db, other, self.aid), 1)
            with self.assertRaises(LookupError):
                annotations.thread_view(db, other, mine['id'])
            with self.assertRaises(LookupError):
                annotations.add_comment(db, other, mine['id'], self.alice_id, 'leak', NOW + 1)
            with self.assertRaises(LookupError):
                annotations.resolve_thread(db, other, mine['id'], NOW + 1)
            comment = annotations.add_comment(db, self.wid, mine['id'], self.alice_id, 'mine', NOW + 2)
            with self.assertRaises(LookupError):
                annotations.edit_comment(db, other, comment['id'], self.alice_id, 'leak', NOW + 3)
            with self.assertRaises(LookupError):
                annotations.delete_comment(db, other, comment['id'], self.alice_id, NOW + 3)

    def test_oversize_and_invalid_values_are_rejected(self):
        with self.app.store.connect() as db:
            for revision in (-1, '1', 1.0, True, None):
                with self.assertRaises(ValueError):
                    self.create(db, revision=revision)
            with self.assertRaises(ValueError):
                annotations.list_threads(db, self.wid, self.aid, revision=-1, limit=5, cursor=None)
            with self.assertRaises(ValueError):
                self.create(db, anchor='x' * (annotations.ANCHOR_MAX + 1))
            with self.assertRaises(ValueError):
                self.create(db, body='x' * (annotations.BODY_MAX + 1))
            thread = self.create(db, body='root')
            for body in ('', '   ', 'x' * (annotations.BODY_MAX + 1), None):
                with self.assertRaises(ValueError):
                    annotations.add_comment(db, self.wid, thread['id'], self.alice_id, body, NOW + 1)
            with self.assertRaises(ValueError):
                annotations.edit_comment(
                    db, self.wid, thread['comments'][0]['id'],
                    self.alice_id, 'x' * (annotations.BODY_MAX + 1), NOW + 2)

    def test_cursor_paging(self):
        with self.app.store.connect() as db:
            ids = {self.create(db, now=NOW + index)['id'] for index in range(5)}
            first = annotations.list_threads(db, self.wid, self.aid, limit=2, cursor=None)
            second = annotations.list_threads(
                db, self.wid, self.aid, limit=2, cursor=first[-1]['id'])
            third = annotations.list_threads(
                db, self.wid, self.aid, limit=2, cursor=second[-1]['id'])
            fourth = annotations.list_threads(
                db, self.wid, self.aid, limit=2, cursor=third[-1]['id'])
            self.assertEqual((len(first), len(second), len(third), len(fourth)), (2, 2, 1, 0))
            combined = [item['id'] for item in first + second + third]
            self.assertEqual(len(combined), len(set(combined)))
            self.assertEqual(set(combined), ids)
            self.assertTrue(all(combined[index] < combined[index + 1]
                                for index in range(len(combined) - 1)))


if __name__ == '__main__':
    unittest.main()
