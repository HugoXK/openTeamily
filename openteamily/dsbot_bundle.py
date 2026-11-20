"""Per-user, per-feature import bundles for the DS-Bot plugin (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5).

The platform exports only the rows of one account (workspaces that account
owns) for one moved feature. Each table is serialised as one canonical JSON
string and its SHA-256 is recorded in the manifest, so the plugin importer
(runtime/openteamily-web/src/features/importer.js) verifies exactly the bytes
the platform hashed. Delivery into the user's volume is the manager job's
concern; this module never writes into any runtime and never includes secrets.
Legacy rows are not modified.
"""
import hashlib
import json
import time

FORMAT = 'openteamily-dsbot-import'

# feature -> ordered [(table, SQL selecting that user's rows; one ? = user id)].
# Parents come before children; the plugin imports in its own declared order.
FEATURE_TABLES = {
    'meetings': [
        ('meetings', 'SELECT m.* FROM meetings m JOIN workspaces w ON w.id = m.workspace_id '
                     'WHERE w.owner_id = ? ORDER BY m.id'),
    ],
}


def canonical(rows):
    return json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def build(db, user_id, feature, now=None):
    """Return the bundle dict for one user and one feature."""
    if feature not in FEATURE_TABLES:
        raise ValueError('unknown feature')
    if not isinstance(user_id, str) or not user_id:
        raise ValueError('user id required')
    tables, manifest = {}, {}
    for table, sql in FEATURE_TABLES[feature]:
        cursor = db.execute(sql, (user_id,))
        names = [column[0] for column in cursor.description]
        rows = [dict(zip(names, tuple(row))) for row in cursor.fetchall()]
        text = canonical(rows)
        tables[table] = text
        manifest[table] = {'rows': len(rows), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    return {'format': FORMAT, 'version': 1, 'feature': feature,
            'created': int(time.time() if now is None else now), 'tables': tables, 'manifest': manifest}


def dumps(bundle):
    return json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
