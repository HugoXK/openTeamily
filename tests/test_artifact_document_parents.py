"""The platform schema carries the Space document tree (issue 24).

The artifacts bundle exports ``artifact_document_parents`` and the DS-Bot runtime
creates that table, so a database the platform itself creates has to hold it:
otherwise a Space that leaves a platform-created DS-Bot keeps every document and
loses the tree, and the legacy "no such table" branch in ``dsbot_bundle`` becomes
the only path such a database can take.
"""
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest

from openteamily import dsbot_bundle
from openteamily.security import digest
from openteamily.store import Store

NOW = 1800000000
OWNER = '1' * 32
WORKSPACE = 'a' * 32
PARENT = 'c' * 32
CHILD = 'd' * 32
LOOSE = 'e' * 32
TABLE = 'artifact_document_parents'
INDEX = 'artifact_document_parent'


class DocumentParentsSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.store = Store(self.path)

    def artifact(self, db, artifact_id, title):
        db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (artifact_id, WORKSPACE, title, digest(title), 'document', '正文', 1,
                    NOW, NOW, OWNER, OWNER, digest('key:' + artifact_id),
                    digest('request:' + artifact_id)))

    def seed(self, tree=True):
        """Fill one workspace the way the platform writes it, tree link included."""
        with self.store.transaction() as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (OWNER, 'alice', 'x', NOW))
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (WORKSPACE, OWNER, 'alice', NOW, digest('workspace-key:' + WORKSPACE),
                        digest('workspace-request:' + WORKSPACE)))
            self.artifact(db, PARENT, '项目')
            self.artifact(db, CHILD, '子文档')
            self.artifact(db, LOOSE, '单独的文档')
            if tree:
                db.execute('INSERT INTO ' + TABLE + ' VALUES(?,?)', (CHILD, PARENT))

    def bundle(self):
        with self.store.connect() as db:
            return dsbot_bundle.build(db, OWNER, 'artifacts', now=1)

    def test_a_platform_created_database_holds_the_document_tree(self):
        with self.store.connect() as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master")}
        self.assertIn(TABLE, names)
        self.assertIn(INDEX, names)

    def test_the_bundle_reports_the_tree_the_platform_created(self):
        self.seed()
        bundle = self.bundle()
        self.assertEqual(bundle['manifest'][TABLE]['rows'], 1)
        self.assertEqual(json.loads(bundle['tables'][TABLE]),
                         [{'artifact_id': CHILD, 'parent_id': PARENT}])
        self.assertEqual(bundle['manifest']['artifacts']['rows'], 3)

    def test_the_tree_refuses_a_document_that_is_its_own_parent(self):
        self.seed(tree=False)
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.transaction() as db:
                db.execute('INSERT INTO ' + TABLE + ' VALUES(?,?)', (CHILD, CHILD))

    def test_a_database_that_predates_the_tree_still_exports_flat(self):
        self.seed()
        with self.store.transaction() as db:
            db.execute('DROP TABLE IF EXISTS ' + TABLE)
        bundle = self.bundle()
        self.assertEqual(bundle['manifest'][TABLE]['rows'], 0)
        self.assertEqual(json.loads(bundle['tables'][TABLE]), [])
        self.assertEqual(bundle['manifest']['artifacts']['rows'], 3)

    def test_an_existing_database_gains_the_table_on_the_next_boot(self):
        self.seed()
        with self.store.transaction() as db:
            db.execute('DROP TABLE IF EXISTS ' + TABLE)
        reopened = Store(self.path)
        with reopened.transaction() as db:
            db.execute('INSERT INTO ' + TABLE + ' VALUES(?,?)', (CHILD, PARENT))
        with reopened.connect() as db:
            self.assertEqual(json.loads(dsbot_bundle.build(db, OWNER, 'artifacts', now=1)
                                        ['tables'][TABLE]),
                             [{'artifact_id': CHILD, 'parent_id': PARENT}])


if __name__ == '__main__':
    unittest.main()
