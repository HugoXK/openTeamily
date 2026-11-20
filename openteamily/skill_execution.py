"""Skills execution/readiness, never an executable package or external-tool grant."""
import json
import re
from urllib.parse import parse_qs

from . import agent_runtime, members, model_api, runtime_connect, skill_packages
from .security import digest


def readiness(app, db, uid, scope, now):
    context = skill_packages.scope_context(db, uid, scope)
    if context is None:
        return {'ready': False, 'code': 'scope_forbidden', 'scope': scope}
    target = None
    wid = context['workspace_id']
    if context['kind'] == 'agent':
        binding = agent_runtime.load_binding(db, wid, context['id'])
        if binding:
            snapshot = app.workspace_instance(db, wid, binding['instance_id'])
            if agent_runtime.instance_usable(snapshot):
                target = agent_runtime.online_instance_connection(db, binding['instance_id'], now, app.config.runtime_heartbeat_seconds)
                if target and target['user_id'] != uid:
                    return {'ready': False, 'code': 'delegated_runtime', 'scope': scope}
    if target is None:
        target = runtime_connect.online_connection(db, uid, now, app.config.runtime_heartbeat_seconds, personal=True)
    result = {'scope': scope, 'ready': False, 'upgrade_url': '/install/flybot.pyz',
              'runtime_url': '/runtimes', 'model_url': '/settings#model-api-form'}
    if not target:
        return result | {'code': 'runtime_offline'}
    result['connection_id'] = target['id']
    result['hostname'] = target['hostname']
    if not skill_packages.supports(db, target['id'], skill_packages.required_formats(db,uid,scope)):
        return result | {'code': 'runtime_upgrade_required'}
    owner = db.execute('SELECT owner_id FROM workspaces WHERE id=?', (wid,)).fetchone() if wid else None
    public, secret, source = model_api.resolve(db, app.store, workspace_id=wid, user_id=owner['owner_id'] if owner else uid)
    result['model_source'] = source
    if not secret or not all(public.get(k) for k in ('provider', 'base_url', 'model')):
        return result | {'code': 'model_missing'}
    if public['provider'] not in ('openai', 'custom'):
        return result | {'code': 'provider_unsupported'}
    return result | {'ready': True, 'code': 'ready', 'model': public['model']}


def run_view(db, row, now):
    task = runtime_connect.expire_task(db, runtime_connect.load_task(db, row['task_id']), now)
    viewed = runtime_connect.view_with_meta(db, task)
    material = db.execute('SELECT * FROM skill_task_material WHERE task_id=?', (task['id'],)).fetchone()
    expected = skill_packages.selection(db, task['id']) or []
    loaded = bool(material and material['acknowledged'] and json.loads(material['manifest']) == expected and expected)
    text = (viewed.get('result') or {}).get('text')
    return {'task': viewed, 'scope': row['scope'], 'skill_id': row['skill_id'], 'loaded': loaded,
            'skills': [{'id':i['id'],'version':i['version'],'digest':i['digest']} for i in expected],
            'verified': bool(loaded and viewed['status'] == 'succeeded' and isinstance(text, str) and text.strip())}


def dispatch(app, db, session, method, path, query, now, env, refuse):
    uid = session['user_id']
    if path.endswith('/readiness') and method == 'GET':
        try:
            args = parse_qs(query, strict_parsing=True, keep_blank_values=True, max_num_fields=1) if query else {}
        except ValueError:
            refuse(400, 'invalid', 'Provide only one scope')
        if set(args) - {'scope'} or len(args.get('scope', ['account'])) != 1:
            refuse(400, 'invalid', 'Provide only one scope')
        scope = args.get('scope', ['account'])[0]
        result = readiness(app, db, uid, scope, now)
        if result['code'] == 'scope_forbidden':
            refuse(404, 'not_found', 'Scope not available')
        return 200, result, []
    if query:
        refuse(400, 'invalid', 'Unexpected query')
    if path.endswith('/scopes') and method == 'GET':
        items = [{'scope': 'account', 'kind': 'account', 'label': '我的账户', 'workspace_id': None}]
        for workspace in db.execute('SELECT * FROM workspaces ORDER BY name,id').fetchall():
            if members.load(db, workspace['id'], uid) is None or members.role_of(db, workspace, uid) not in ('owner', 'admin'):
                continue
            for table, prefix in (('workspace_agents', ''), ('automations', 'automation:')):
                for row in db.execute('SELECT * FROM '+table+' WHERE workspace_id=? ORDER BY id', (workspace['id'],)).fetchall():
                    scope = prefix+workspace['id']+':'+row['id']
                    context = skill_packages.scope_context(db, uid, scope)
                    if context:
                        items.append(context | {'scope': scope})
        return 200, {'items': items}, []
    if not path.endswith('/runs'):
        refuse(400, 'invalid', 'Invalid skill operation')
    if method == 'GET':
        rows = db.execute('SELECT * FROM skill_runs WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50', (uid,)).fetchall()
        return 200, {'items': [run_view(db, row, now) for row in rows]}, []
    if method != 'POST':
        refuse(400, 'invalid', 'Invalid skill run method')
    body = app.body(env, ['scope', 'skill_id', 'prompt'])
    key = env.get('HTTP_IDEMPOTENCY_KEY', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', key):
        refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
    scope, ident, prompt = body.get('scope'), body.get('skill_id'), body.get('prompt')
    if not isinstance(scope, str) or not isinstance(ident,str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}',ident) or not runtime_connect.valid_prompt(prompt):
        refuse(400, 'invalid', 'Provide a scope, installed skill and 1–4000 character task')
    key_hash, request_hash = digest('skill-run:'+key), digest(json.dumps(body, sort_keys=True))
    prior = db.execute('SELECT * FROM skill_runs WHERE user_id=? AND key_hash=?', (uid, key_hash)).fetchone()
    if prior:
        if prior['request_hash'] != request_hash:
            refuse(409, 'conflict', 'Idempotency key was used for a different skill run')
        return 200, run_view(db, prior, now), []
    item = skill_packages.resolve(ident,db,uid)
    binding = db.execute('SELECT * FROM skill_bindings WHERE user_id=? AND scope=? AND skill_id=?', (uid, scope, ident)).fetchone()
    if item is None or binding is None or binding['digest'] != item['digest'] or binding['version'] != item['version']:
        refuse(409, 'skill_not_installed', 'Install the current skill version in this scope first')
    ready = readiness(app, db, uid, scope, now)
    if not ready['ready']:
        refuse(409, ready['code'], 'Skill runtime is not ready: '+ready['code'])
    context = skill_packages.scope_context(db, uid, scope)
    try:
        task = runtime_connect.create_task(db, uid, ready['connection_id'], now, 'infer', prompt,
                                           app.config.runtime_task_timeout_seconds, context['workspace_id'])
    except ValueError:
        refuse(429, 'quota', 'Runtime task capacity reached')
    db.execute('INSERT INTO skill_task_owners VALUES(?,?,?)', (task['id'], uid, scope))
    db.execute('INSERT INTO skill_task_selection VALUES(?,?)', (task['id'], json.dumps([item], sort_keys=True)))
    db.execute('INSERT INTO skill_runs VALUES(?,?,?,?,?,?,?)', (task['id'], uid, scope, ident, key_hash, request_hash, now))
    row = db.execute('SELECT * FROM skill_runs WHERE task_id=?', (task['id'],)).fetchone()
    return 201, run_view(db, row, now), []
