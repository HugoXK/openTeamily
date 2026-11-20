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

# feature -> ordered [(table, SQL selecting that user's rows; every ? = user id)].
_OWNED = 'SELECT id FROM workspaces WHERE owner_id = ?'
_MEMORY_USERS = (
    "SELECT u.id, u.username, CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_owner FROM users u WHERE u.id = ? "
    "OR u.id IN (SELECT created_by FROM memory_pages WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT updated_by FROM memory_pages WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_page_versions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_actions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT updated_by FROM memory_actions WHERE workspace_id IN (" + _OWNED + ")) "
    "OR u.id IN (SELECT created_by FROM memory_links WHERE workspace_id IN (" + _OWNED + ")) ORDER BY u.id")


def _scoped(table, order='id'):
    return 'SELECT * FROM ' + table + ' WHERE workspace_id IN (' + _OWNED + ') ORDER BY ' + order

# Parents come before children; the plugin imports in its own declared order.
FEATURE_TABLES = {
    'meetings': [
        ('meetings', 'SELECT m.* FROM meetings m JOIN workspaces w ON w.id = m.workspace_id '
                     'WHERE w.owner_id = ? ORDER BY m.id'),
    ],
    'memory': [
        ('ot_users', _MEMORY_USERS),
        ('memory_pages', _scoped('memory_pages')),
        ('memory_page_versions', _scoped('memory_page_versions', 'page_id, revision')),
        ('memory_page_topics', _scoped('memory_page_topics', 'page_id, name_hash')),
        ('memory_links', _scoped('memory_links')),
        ('memory_actions', _scoped('memory_actions')),
        ('memory_suggestions', _scoped('memory_suggestions')),
        # Profile and preferences are personal: only this account's own rows.
        ('memory_profiles', 'SELECT * FROM memory_profiles WHERE user_id = ? ORDER BY workspace_id'),
        ('memory_preferences', 'SELECT * FROM memory_preferences WHERE user_id = ? ORDER BY workspace_id, position, id'),
    ],
}

# Stream B4 (settings, model-api, connectors). Secret columns are never
# selected here: key blobs travel only through sealed_secrets() below.
FEATURE_TABLES.update({
    'settings': [
        ('user_settings', 'SELECT user_id, document, revision, updated FROM user_settings WHERE user_id = ?'),
        ('user_onboarding', 'SELECT * FROM user_onboarding WHERE user_id = ?'),
        ('user_onboarding_steps', 'SELECT * FROM user_onboarding_steps WHERE user_id = ?'),
    ],
    'model-api': [
        ('model_api_configs', "SELECT id, provider, base_url, model, revision, updated, "
                              "CASE WHEN key_blob IS NULL OR key_blob = '' THEN 0 ELSE 1 END AS key_set "
                              "FROM model_api_configs WHERE scope = 'account' AND account_id = ?"),
    ],
    'connectors': [
        ('composio_user', "SELECT 'openteamily-' || id AS user_ref FROM users WHERE id = ?"),
        ('composio_keys', 'SELECT user_id, key_hint, revision, updated FROM composio_keys WHERE user_id = ?'),
        ('composio_connections', 'SELECT id, toolkit, account_id, status, status_reason, created, updated '
                                 'FROM composio_connections WHERE user_id = ? ORDER BY created, id'),
        ('custom_mcp_servers', 'SELECT id, name, origin, revision, created, updated '
                               'FROM custom_mcp_servers WHERE user_id = ? ORDER BY created, id'),
    ],
})


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
        cursor = db.execute(sql, (user_id,) * sql.count('?'))
        names = [column[0] for column in cursor.description]
        rows = [dict(zip(names, tuple(row))) for row in cursor.fetchall()]
        text = canonical(rows)
        tables[table] = text
        manifest[table] = {'rows': len(rows), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    return {'format': FORMAT, 'version': 1, 'feature': feature,
            'created': int(time.time() if now is None else now), 'tables': tables, 'manifest': manifest}


def dumps(bundle):
    return json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sealed_secrets(db, store, user_id, feature, seal_key):
    """B4 secrets of one account, re-wrapped for one target runtime.

    seal_key is the 32-byte key the manager delivers to that runtime as
    OPENTEAMILY_SEAL_KEY_FILE; values use the model_api.wrap format that the
    plugin's lib/b4/seal.js unwrapLegacy() reads, then re-seals on its volume.
    Plain values exist only in this process. Composio keys stay per-user: only
    this account's own key is ever exported.
    """
    from . import composio, custom_mcp, model_api
    if not isinstance(seal_key, (bytes, bytearray)) or len(seal_key) != 32:
        raise ValueError('32-byte runtime seal key required')
    out = {}
    if feature == 'model-api':
        row = model_api.load_account(db, user_id)
        if row is not None and row['key_blob']:
            out['model_api_key'] = model_api.wrap(bytes(seal_key), model_api.secret(store, row))
    elif feature == 'connectors':
        key = composio.user_key(store, db, user_id)
        if key:
            out['composio_key'] = model_api.wrap(bytes(seal_key), key)
        for row in db.execute('SELECT * FROM custom_mcp_servers WHERE user_id = ? ORDER BY created, id', (user_id,)).fetchall():
            out['mcp:' + row['id']] = model_api.wrap(bytes(seal_key), json.dumps(custom_mcp.secret_config(store, row)))
    return out


def build_with_secrets(db, store, user_id, feature, seal_key=None, now=None):
    """build() plus, for B4 features, sealed secrets and their digest."""
    bundle = build(db, user_id, feature, now)
    if seal_key is not None and feature in ('model-api', 'connectors'):
        secrets = sealed_secrets(db, store, user_id, feature, seal_key)
        bundle['secrets'] = secrets
        bundle['secrets_sha256'] = hashlib.sha256(canonical(secrets).encode('utf-8')).hexdigest()
    return bundle
