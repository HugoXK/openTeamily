"""Export an artifacts bundle that carries a document tree, the way the platform does.

Run from the repository root; prints one JSON object holding the exported bundle
and the ids it used, so a test can import it into a fresh DS-Bot and compare.

The platform schema creates ``artifact_document_parents`` with the bundle
contract (``openteamily/artifacts.py``), so this fixture only fills it in: it
would fail, rather than quietly create the table, on a platform that does not
ship that migration.
"""
import json
import tempfile
from pathlib import Path

from openteamily import dsbot_bundle
from openteamily.security import digest
from openteamily.store import Store

OWNER = '1' * 32
OTHER = '2' * 32
WORKSPACE = 'a' * 32
PARENT = 'c' * 32
CHILD = 'd' * 32
ORPHAN = 'e' * 32
NOW = 1800000000


def artifact(db, artifact_id, workspace, title):
    db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
               (artifact_id, workspace, title, digest(title), 'document', '正文', 1,
                NOW, NOW, OWNER, OWNER, digest('key:' + artifact_id), digest('request:' + artifact_id)))


def main():
    with tempfile.TemporaryDirectory() as temp:
        store = Store(Path(temp) / 'state')
        with store.transaction() as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (OWNER, 'alice', 'x', NOW))
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (OTHER, 'bob', 'x', NOW))
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (WORKSPACE, OWNER, 'alice', NOW, digest('workspace-key:' + WORKSPACE),
                        digest('workspace-request:' + WORKSPACE)))
            artifact(db, PARENT, WORKSPACE, '项目')
            artifact(db, CHILD, WORKSPACE, '子文档')
            artifact(db, ORPHAN, WORKSPACE, '单独的文档')
            db.execute('INSERT INTO artifact_document_parents VALUES(?,?)', (CHILD, PARENT))
        with store.connect() as db:
            bundle = dsbot_bundle.build(db, OWNER, 'artifacts', now=1)
    print(json.dumps({'owner': OWNER, 'workspace': WORKSPACE, 'parent': PARENT, 'child': CHILD,
                      'orphan': ORPHAN, 'bundle': bundle}, ensure_ascii=False))


if __name__ == '__main__':
    main()
