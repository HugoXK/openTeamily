"""Saved prompt-template persistence and safe rendering. In-process SQLite only."""
from pathlib import Path
import tempfile
import unittest

from openteamily import prompts
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class PromptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        added = self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                                {'username': 'bob', 'role': 'member'})
        self.assertEqual(added['status'], 201, added)
        self.alice_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        with self.app.store.connect() as db:
            prompts.ensure_schema(db)

    def create(self, owner_id=None, wid=None, title='Example prompt',
               body='Hello {{name}}', variables=None, **changes):
        with self.app.store.connect() as db:
            return prompts.create_prompt(
                db, wid or self.wid, owner_id or self.alice_id, title, body, self.now,
                variables=variables, **changes)

    def test_schema_is_idempotent_and_preserves_rows(self):
        with self.app.store.connect() as db:
            prompts.ensure_schema(db)
            names = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
            self.assertIn('prompt_templates', names)
            self.assertIn('prompt_versions', names)
            self.assertIn('prompt_template_workspace', names)
            self.assertIn('prompt_version_prompt', names)
            first = prompts.create_prompt(db, self.wid, self.alice_id, 'Kept', 'Body', self.now)
            prompts.ensure_schema(db)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM prompt_templates').fetchone()[0], 1)
            self.assertEqual(prompts.get_prompt(db, self.wid, first['id'], self.alice_id)['id'],
                             first['id'])

    def test_create_get_and_private_visibility(self):
        made = self.create(title='Greeting', body='Hi {{name}} at {{place}}',
                           tags=['Writing', 'work'])
        self.assertEqual(made['workspace_id'], self.wid)
        self.assertEqual(made['owner_id'], self.alice_id)
        self.assertEqual(made['title'], 'Greeting')
        self.assertEqual(made['body'], 'Hi {{name}} at {{place}}')
        self.assertEqual(made['variables'], ['name', 'place'])
        self.assertEqual(made['tags'], ['Writing', 'work'])
        self.assertEqual(made['scope'], 'private')
        self.assertEqual(made['current_version'], 1)
        self.assertEqual(made['version'], 1)
        self.assertFalse(made['archived'])
        self.assertEqual(made['created'], self.now)
        self.assertEqual(made['updated'], self.now)
        with self.app.store.connect() as db:
            self.assertEqual(prompts.get_prompt(db, self.wid, made['id'], self.alice_id)['body'],
                             'Hi {{name}} at {{place}}')
            self.assertIsNone(prompts.get_prompt(db, self.wid, made['id'], self.bob_id))
            self.assertIsNone(prompts.get_prompt(db, self.wid, 'missing', self.alice_id))
            self.assertIsNone(prompts.get_prompt(db, '0' * 32, made['id'], self.alice_id))

    def test_workspace_scope_is_readable_by_a_member(self):
        made = self.create(scope='workspace', body='Shared {{topic}}')
        with self.app.store.connect() as db:
            self.assertEqual(prompts.get_prompt(db, self.wid, made['id'], self.bob_id)['body'],
                             'Shared {{topic}}')
            self.assertEqual([row['id'] for row in prompts.list_prompts(
                db, self.wid, self.bob_id, limit=10)], [made['id']])

    def test_update_versions_cas_and_write_permissions(self):
        made = self.create(body='Hello {{name}}')
        with self.app.store.connect() as db:
            updated = prompts.update_prompt(
                db, self.wid, made['id'], self.alice_id,
                {'title': 'Renamed', 'body': 'Hi {{name}} at {{place}}',
                 'tags': ['new'], 'scope': 'workspace'},
                self.now + 1, 1)
            self.assertEqual(updated['title'], 'Renamed')
            self.assertEqual(updated['body'], 'Hi {{name}} at {{place}}')
            self.assertEqual(updated['variables'], ['name', 'place'])
            self.assertEqual(updated['tags'], ['new'])
            self.assertEqual(updated['scope'], 'workspace')
            self.assertEqual(updated['current_version'], 2)
            self.assertEqual(updated['updated'], self.now + 1)
            versions = prompts.list_versions(db, self.wid, made['id'], self.alice_id)
            self.assertEqual([row['version'] for row in versions], [1, 2])
            self.assertEqual(versions[0]['body'], 'Hello {{name}}')
            self.assertEqual(versions[1]['body'], 'Hi {{name}} at {{place}}')
            self.assertEqual(versions[1]['created_by'], self.alice_id)
            with self.assertRaises(prompts.PromptVersionConflict):
                prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                      {'title': 'Stale'}, self.now + 2, 1)
            self.assertEqual(prompts.get_prompt(
                db, self.wid, made['id'], self.alice_id)['current_version'], 2)
            with self.assertRaises(prompts.PromptPermissionError):
                prompts.update_prompt(db, self.wid, made['id'], self.bob_id,
                                      {'title': 'Member edit'}, self.now + 2, 2)
            with self.assertRaises(ValueError):
                prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                      {'unknown': 1}, self.now + 2, 2)

    def test_workspace_admin_may_update_a_workspace_prompt(self):
        made = self.create(scope='workspace')
        changed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.bob_id}',
                                  {'role': 'admin'})
        self.assertEqual(changed['status'], 200, changed)
        with self.app.store.connect() as db:
            updated = prompts.update_prompt(db, self.wid, made['id'], self.bob_id,
                                            {'title': 'Admin edit'}, self.now + 1, 1)
            self.assertEqual(updated['title'], 'Admin edit')

    def test_list_filters_tag_query_and_paging(self):
        alpha = self.create(title='Alpha notes', body='About {{topic}}', tags=['Work'])
        beta = self.create(title='Beta brief', body='Meeting agenda', tags=['work', 'urgent'])
        gamma = self.create(title='Gamma', body='unrelated', tags=['life'])
        delta = self.create(owner_id=self.bob_id, scope='workspace',
                            title='Delta shared', body='meeting shared', tags=['Work'])
        secret = self.create(owner_id=self.bob_id, scope='private',
                             title='Epsilon secret', body='meeting secret')
        with self.app.store.connect() as db:
            private = {row['id'] for row in prompts.list_prompts(
                db, self.wid, self.alice_id, scope='private', limit=100)}
            self.assertEqual(private, {alpha['id'], beta['id'], gamma['id']})
            self.assertNotIn(secret['id'], private)
            shared = [row['id'] for row in prompts.list_prompts(
                db, self.wid, self.alice_id, scope='workspace', limit=100)]
            self.assertEqual(shared, [delta['id']])
            tagged = {row['id'] for row in prompts.list_prompts(
                db, self.wid, self.alice_id, tag='WORK', limit=100)}
            self.assertEqual(tagged, {alpha['id'], beta['id'], delta['id']})
            found = {row['id'] for row in prompts.list_prompts(
                db, self.wid, self.alice_id, query='MEETING', limit=100)}
            self.assertEqual(found, {beta['id'], delta['id']})
            everyone = prompts.list_prompts(db, self.wid, self.alice_id, limit=100)
            page = prompts.list_prompts(db, self.wid, self.alice_id, limit=2)
            rest = prompts.list_prompts(db, self.wid, self.alice_id, limit=2,
                                        cursor=page[-1]['id'])
            self.assertEqual(len(page), 2)
            self.assertEqual([row['id'] for row in page + rest],
                             [row['id'] for row in everyone[:4]])
            with self.assertRaises(ValueError):
                prompts.list_prompts(db, self.wid, self.alice_id, scope='public', limit=10)
            with self.assertRaises(ValueError):
                prompts.list_prompts(db, self.wid, self.alice_id, limit=0)

    def test_versions_are_ordered_and_version_access_is_visibility_checked(self):
        made = self.create(body='one {{x}}')
        self.create(owner_id=self.bob_id, scope='workspace', title='Shared',
                    body='shared {{y}}')
        with self.app.store.connect() as db:
            prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                  {'body': 'two'}, self.now + 1, 1)
            prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                  {'body': 'three {{z}}'}, self.now + 2, 2)
            versions = prompts.list_versions(db, self.wid, made['id'], self.alice_id)
            self.assertEqual([row['version'] for row in versions], [1, 2, 3])
            self.assertEqual([row['body'] for row in versions],
                             ['one {{x}}', 'two', 'three {{z}}'])
            self.assertEqual(versions[0]['variables'], ['x'])
            self.assertEqual(versions[2]['variables'], ['z'])
            self.assertEqual(prompts.list_versions(db, self.wid, made['id'], self.bob_id), [])
            self.assertEqual(prompts.list_versions(db, self.wid, 'missing', self.alice_id), [])

    def test_render_substitutes_validates_and_pins_versions(self):
        made = self.create(body='Hi {{name}}, meet {{topic}}.',
                           variables=['name', 'topic'])
        with self.app.store.connect() as db:
            self.assertEqual(prompts.render(db, self.wid, made['id'],
                                            {'name': 'Ada', 'topic': 'SQL', 'extra': 'ignored'},
                                            self.alice_id),
                             {'text': 'Hi Ada, meet SQL.', 'missing': []})
            missing = prompts.render(db, self.wid, made['id'], {'name': 'Ada'},
                                     self.alice_id)
            self.assertEqual(missing['missing'], ['topic'])
            self.assertEqual(missing['text'], 'Hi Ada, meet {{topic}}.')
            with self.assertRaises(ValueError):
                prompts.render(db, self.wid, made['id'], [], self.alice_id)
            with self.assertRaises(ValueError):
                prompts.render(db, self.wid, made['id'],
                               {'name': 1, 'topic': 'SQL'}, self.alice_id)
            prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                  {'body': 'Updated {{name}}'}, self.now + 1, 1)
            self.assertEqual(prompts.render(db, self.wid, made['id'],
                                            {'name': 'Ada', 'topic': 'SQL'},
                                            self.alice_id, version=1)['text'],
                             'Hi Ada, meet SQL.')
            with self.assertRaises(ValueError):
                prompts.render(db, self.wid, made['id'], {'name': 'Ada'},
                               self.alice_id, version=99)
            with self.assertRaises(prompts.PromptNotFound):
                prompts.render(db, self.wid, made['id'], {'name': 'Ada'}, self.bob_id)
        shared = self.create(scope='workspace', body='Shared {{value}}')
        with self.app.store.connect() as db:
            self.assertEqual(prompts.render(db, self.wid, shared['id'],
                                            {'value': 'ok'}, self.bob_id)['text'],
                             'Shared ok')

    def test_malformed_placeholders_and_invalid_variables_are_rejected(self):
        bad_bodies = ['Hello {{name', 'Hello name}}', 'Hello {{}}',
                      'Hello {{1bad}}', 'Hello {{na me}}', 'Hello {{name!}}',
                      'Hello {{{name}}}', 'Hello {name}']
        with self.app.store.connect() as db:
            for body in bad_bodies:
                with self.assertRaises(ValueError, msg=body):
                    prompts.create_prompt(db, self.wid, self.alice_id, 'Bad', body, self.now)
            for variables in (['other'], ['name', 'name'], 'name', ['name', 'extra']):
                with self.assertRaises(ValueError, msg=repr(variables)):
                    prompts.create_prompt(db, self.wid, self.alice_id, 'Bad', 'Hi {{name}}',
                                          self.now, variables=variables)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM prompt_templates').fetchone()[0], 0)

    def test_archive_hides_from_list_but_get_still_returns_record(self):
        made = self.create()
        with self.app.store.connect() as db:
            self.assertEqual(len(prompts.list_prompts(db, self.wid, self.alice_id, limit=10)), 1)
            archived = prompts.archive_prompt(db, self.wid, made['id'], self.alice_id,
                                              self.now + 1)
            self.assertTrue(archived['archived'])
            self.assertEqual(archived['updated'], self.now + 1)
            self.assertEqual(prompts.list_prompts(db, self.wid, self.alice_id, limit=10), [])
            self.assertTrue(prompts.get_prompt(db, self.wid, made['id'], self.alice_id)['archived'])
            with self.assertRaises(prompts.PromptPermissionError):
                prompts.archive_prompt(db, self.wid, made['id'], self.bob_id,
                                       self.now + 2)

    def test_delete_is_owner_only_and_cascades_versions(self):
        made = self.create()
        with self.app.store.connect() as db:
            self.assertFalse(prompts.delete_prompt(db, self.wid, made['id'], self.bob_id))
            self.assertIsNotNone(prompts.get_prompt(db, self.wid, made['id'], self.alice_id))
            self.assertTrue(prompts.delete_prompt(db, self.wid, made['id'], self.alice_id))
            self.assertIsNone(prompts.get_prompt(db, self.wid, made['id'], self.alice_id))
            self.assertEqual(prompts.list_versions(db, self.wid, made['id'], self.alice_id), [])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM prompt_versions WHERE prompt_id=?',
                                        (made['id'],)).fetchone()[0], 0)
            self.assertFalse(prompts.delete_prompt(db, self.wid, made['id'], self.alice_id))
        shared = self.create(scope='workspace')
        changed = self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.bob_id}',
                                  {'role': 'admin'})
        self.assertEqual(changed['status'], 200, changed)
        with self.app.store.connect() as db:
            self.assertFalse(prompts.delete_prompt(db, self.wid, shared['id'], self.bob_id))

    def test_workspace_and_owner_isolation(self):
        other_wid = self.alice.workspace('Second', 'request_example_0002')['body'][
            'workspace']['id']
        made = self.create()
        with self.app.store.connect() as db:
            self.assertIsNone(prompts.get_prompt(db, other_wid, made['id'], self.alice_id))
            self.assertEqual(prompts.list_prompts(db, other_wid, self.alice_id, limit=10), [])
            with self.assertRaises(ValueError):
                prompts.update_prompt(db, other_wid, made['id'], self.alice_id,
                                      {'title': 'Wrong workspace'}, self.now + 1, 1)
            self.assertFalse(prompts.delete_prompt(db, other_wid, made['id'], self.alice_id))
        secret = self.create(owner_id=self.bob_id, scope='private')
        with self.app.store.connect() as db:
            visible = {row['id'] for row in prompts.list_prompts(
                db, self.wid, self.alice_id, limit=100)}
            self.assertNotIn(secret['id'], visible)
            bob_visible = {row['id'] for row in prompts.list_prompts(
                db, self.wid, self.bob_id, limit=100)}
            self.assertIn(secret['id'], bob_visible)
            self.assertNotIn(made['id'], bob_visible)

    def test_oversize_values_and_count_bounds_are_rejected(self):
        with self.app.store.connect() as db:
            cases = [
                {'title': 'x' * (prompts.MAX_TITLE + 1), 'body': 'Body'},
                {'title': 'Title', 'body': 'x' * (prompts.MAX_BODY + 1)},
                {'title': 'Title', 'body': 'Body',
                 'tags': ['tag'] * (prompts.MAX_TAGS + 1)},
                {'title': 'Title', 'body': 'Body', 'tags': ['x' * (prompts.MAX_TAG + 1)]},
                {'title': 'Title', 'body': 'Body', 'tags': 'not-a-list'},
            ]
            for fields in cases:
                with self.assertRaises(ValueError, msg=repr(fields)[:120]):
                    prompts.create_prompt(db, self.wid, self.alice_id, fields['title'],
                                          fields['body'], self.now,
                                          tags=fields.get('tags'))
            many = ' '.join('{{v%d}}' % index for index in range(prompts.MAX_VARIABLES + 1))
            with self.assertRaises(ValueError):
                prompts.create_prompt(db, self.wid, self.alice_id, 'Many', many, self.now)
        with self.app.store.connect() as db:
            original = prompts.MAX_PROMPTS_PER_WORKSPACE
            prompts.MAX_PROMPTS_PER_WORKSPACE = 1
            try:
                prompts.create_prompt(db, self.wid, self.alice_id, 'One', 'Body', self.now)
                with self.assertRaises(ValueError):
                    prompts.create_prompt(db, self.wid, self.alice_id, 'Two', 'Body',
                                          self.now)
            finally:
                prompts.MAX_PROMPTS_PER_WORKSPACE = original
        with self.app.store.connect() as db:
            original = prompts.MAX_VERSIONS
            prompts.MAX_VERSIONS = 2
            try:
                made = prompts.create_prompt(db, self.wid, self.alice_id, 'Versioned',
                                             'Body', self.now)
                prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                      {'body': 'Body v2'}, self.now + 1, 1)
                with self.assertRaises(ValueError):
                    prompts.update_prompt(db, self.wid, made['id'], self.alice_id,
                                          {'body': 'Body v3'}, self.now + 2, 2)
            finally:
                prompts.MAX_VERSIONS = original


if __name__ == '__main__':
    unittest.main()
