"""Evaluate due automations and run them on connected FlyBot agents (issue #6).

An explicit tick still works. The Web runner also starts a background worker
that periodically ticks and reconciles, and recovers in-flight runs after a
restart. Default execution creates an allowlisted infer task on an online
own-machine agent; results are stored on the run row. A caller may still
inject a container dispatch hook (see FakeRuntimeBackend); that hook is not
agent execution. Fake providers in tests are not real vendor proof. Not
Teamily parity.
"""
import json
import re
import threading
import time
from uuid import uuid4

from . import automations, members, model_api, runtime_connect, skill_packages


class NullAutomationBackend:
    def dispatch_automation(self, payload, db=None, model_api_key=None):
        return {'status': 'skipped', 'error_code': 'no_backend', 'instance_ids': []}


def payload(row, run_id, due, model=None):
    view = automations.view(row)
    body = {
        'automation_id': view['id'],
        'workspace_id': view['workspace_id'],
        'run_id': run_id,
        'due_at': due,
        'title': view['title'],
        'template_id': view['template_id'],
        'prompt': view['prompt'],
        'participants': view['participants'],
    }
    if model:
        body['model_api'] = {key: model[key] for key in ('provider', 'base_url', 'model', 'api_key_set', 'scope', 'source') if key in model}
    return body


def editor_agents(db, automation_id):
    row = db.execute('SELECT agents FROM automation_editors WHERE automation_id=?', (automation_id,)).fetchone()
    if row is None:
        return []
    try:
        value = json.loads(row['agents'])
    except ValueError:
        return []
    return value if isinstance(value, list) else []


def pick_connection(db, workspace_id, now, stale, preferred=None):
    workspace = db.execute('SELECT * FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
    if workspace is None:
        return None
    listing = members.listing(db, workspace)
    by_name = {item['username']: item for item in listing}
    ordered, seen = [], set()
    for name in preferred or []:
        item = by_name.get(name)
        if item and item['user_id'] not in seen:
            ordered.append(item)
            seen.add(item['user_id'])
    for role in ('owner', 'admin', 'member'):
        for item in listing:
            if item['role'] == role and item['user_id'] not in seen:
                ordered.append(item)
                seen.add(item['user_id'])
    for item in ordered:
        connection = runtime_connect.online_connection(db, item['user_id'], now, stale)
        if connection:
            return connection
    return None


def sanitize_result(value):
    if not isinstance(value, dict):
        return {}
    clean = {}
    text = value.get('text')
    if isinstance(text, str):
        clean['text'] = text[:8000]
    if isinstance(value.get('model'), str) and len(value['model']) <= 200:
        clean['model'] = value['model']
    if value.get('source') in ('workspace', 'account', 'platform'):
        clean['source'] = value['source']
    if value.get('cancelled') is True:
        clean['cancelled'] = True
    if isinstance(value.get('error'), str) and 1 <= len(value['error']) <= 200:
        clean['error'] = value['error']
    clean.pop('api_key', None)
    return clean


def sanitize_dispatch(result):
    result = result or {}
    status = result.get('status')
    if status not in ('succeeded', 'failed', 'skipped', 'queued'):
        status = 'failed'
    error = result.get('error_code')
    if error is not None and (not isinstance(error, str) or not 1 <= len(error) <= 64 or any(c < ' ' for c in error)):
        error = 'runtime_failure'
    ids = result.get('instance_ids') or []
    if not isinstance(ids, list):
        ids = []
    clean = [item for item in ids if isinstance(item, str) and len(item) == 32]
    task_id = result.get('task_id')
    backend = 'agent' if isinstance(task_id, str) and re.fullmatch(r'[0-9a-f]{32}', task_id) else 'recorded'
    dispatch = {'instance_ids': clean[:32], 'backend': backend}
    if backend == 'agent':
        dispatch['task_id'] = task_id
    connection_id = result.get('connection_id')
    if isinstance(connection_id, str) and re.fullmatch(r'[0-9a-f]{32}', connection_id):
        dispatch['connection_id'] = connection_id
    payload_result = sanitize_result(result.get('result'))
    if payload_result:
        dispatch['result'] = payload_result
    return status, error, dispatch


def _stored_dispatch(row):
    try:
        data = json.loads(row['dispatch'] or '{}')
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


class AgentAutomationBackend:
    """Dispatch allowlisted infer work to an online FlyBot agent. Never runs a shell."""

    def __init__(self, stale=45, timeout=60):
        self.stale, self.timeout = stale, timeout

    def dispatch_automation(self, payload, db=None, model_api_key=None):
        del model_api_key  # The agent fetches a one-time grant; do not copy the long-lived key.
        if db is None or not isinstance(payload, dict):
            return {'status': 'failed', 'error_code': 'runtime_failure', 'instance_ids': []}
        now = int(payload.get('now') or 0)
        scope = 'automation:'+payload['workspace_id']+':'+payload['automation_id']
        owners = db.execute('SELECT DISTINCT user_id FROM skill_bindings WHERE scope=?',(scope,)).fetchall()
        skill_owner = None
        if owners:
            if len(owners) != 1 or skill_packages.scope_context(db,owners[0]['user_id'],scope) is None:
                return {'status':'failed','error_code':'skill_scope_revoked','instance_ids':[]}
            skill_owner = owners[0]['user_id']
            connection = runtime_connect.online_connection(db,skill_owner,now,self.stale,personal=True)
            if connection and not skill_packages.supports(db,connection['id'],skill_packages.required_formats(db,skill_owner,scope)):
                return {'status':'failed','error_code':'runtime_upgrade_required','instance_ids':[]}
        else:
            connection = pick_connection(
                db, payload['workspace_id'], now, self.stale, payload.get('preferred_agents'),
            )
        if connection is None:
            return {'status': 'queued', 'error_code': 'no_agent', 'instance_ids': []}
        prompt = payload.get('prompt')
        if not runtime_connect.valid_prompt(prompt):
            return {'status': 'failed', 'error_code': 'invalid_prompt', 'instance_ids': []}
        try:
            task = runtime_connect.create_task(
                db, connection['user_id'], connection['id'], now, 'infer', prompt,
                self.timeout, payload['workspace_id'],
            )
        except ValueError:
            return {'status': 'failed', 'error_code': 'quota', 'instance_ids': []}
        if skill_owner:
            db.execute('INSERT INTO skill_task_owners VALUES(?,?,?)',(task['id'],skill_owner,scope))
            material = skill_packages.material(db,task['id'])
            count = db.execute('SELECT COUNT(*) FROM skill_bindings WHERE user_id=? AND scope=?',(skill_owner,scope)).fetchone()[0]
            if not material or len(material) != count:
                runtime_connect.cancel_task(db,task,now)
                return {'status':'failed','error_code':'skill_version_changed','instance_ids':[]}
            db.execute('INSERT INTO skill_task_selection VALUES(?,?)',(task['id'],json.dumps(material,sort_keys=True)))
            db.execute('INSERT INTO skill_runs VALUES(?,?,?,?,?,?,?)',(task['id'],skill_owner,scope,'*','automation:'+task['id'],'',now))
        return {
            'status': 'queued',
            'task_id': task['id'],
            'connection_id': connection['id'],
            'instance_ids': [],
        }


class Scheduler:
    def __init__(self, store, backend=None, clock=None, max_runs=200, stale=45, timeout=60):
        self.store = store
        self.backend = backend or NullAutomationBackend()
        self.clock = clock
        self.max_runs = max_runs
        self.stale, self.timeout = stale, timeout

    def tick_workspace(self, db, workspace_id, now):
        from .dsbot_gateway import workspace_moved_to_dsbot
        if workspace_moved_to_dsbot(db, workspace_id, 'automations'):
            return []
        fired = []
        rows = db.execute(
            'SELECT * FROM automations WHERE workspace_id=? AND enabled=1 ORDER BY id',
            (workspace_id,),
        ).fetchall()
        for row in rows:
            item = self._tick_one(db, row, now)
            if item is not None:
                fired.append(item)
        return fired

    def reconcile_workspace(self, db, workspace_id, now):
        from .dsbot_gateway import workspace_moved_to_dsbot
        if workspace_moved_to_dsbot(db, workspace_id, 'automations'):
            return []
        updated = []
        rows = db.execute(
            "SELECT * FROM automation_runs WHERE workspace_id=? AND status='queued' ORDER BY id",
            (workspace_id,),
        ).fetchall()
        for row in rows:
            item = self._reconcile_one(db, row, now)
            if item is not None and item['status'] != 'queued':
                updated.append(item)
        return updated

    def tick_all(self, now=None):
        now = int(self.clock() if now is None else now)
        with self.store.transaction() as db:
            ids = [item[0] for item in db.execute('SELECT id FROM workspaces ORDER BY id')]
            fired = []
            for workspace_id in ids:
                fired.extend(self.tick_workspace(db, workspace_id, now))
            return fired

    def reconcile_all(self, now=None):
        now = int(self.clock() if now is None else now)
        with self.store.transaction() as db:
            ids = [item[0] for item in db.execute('SELECT id FROM workspaces ORDER BY id')]
            updated = []
            for workspace_id in ids:
                updated.extend(self.reconcile_workspace(db, workspace_id, now))
            return updated

    def recover(self, now=None):
        now = int(self.clock() if now is None else now)
        with self.store.transaction() as db:
            ids = [item[0] for item in db.execute('SELECT id FROM workspaces ORDER BY id')]
            updated = []
            for workspace_id in ids:
                updated.extend(self.reconcile_workspace(db, workspace_id, now))
                updated.extend(self.tick_workspace(db, workspace_id, now))
            return updated

    def cancel_run(self, db, run, now):
        if run['status'] != 'queued':
            return None
        dispatch = _stored_dispatch(run)
        task_id = dispatch.get('task_id')
        if isinstance(task_id, str) and re.fullmatch(r'[0-9a-f]{32}', task_id):
            task = runtime_connect.load_task(db, task_id)
            if task is not None:
                runtime_connect.cancel_task(db, task, now)
        dispatch['result'] = {'cancelled': True}
        self._finish(db, run['id'], now, 'failed', 'cancelled', dispatch)
        return automations.run_view(db.execute('SELECT * FROM automation_runs WHERE id=?', (run['id'],)).fetchone())

    def _tick_one(self, db, row, now):
        due = automations.due_at(automations.view(row)['schedule'], now)
        if due is None:
            return None
        existing = db.execute(
            'SELECT * FROM automation_runs WHERE automation_id=? AND due_at=?',
            (row['id'], due),
        ).fetchone()
        if existing and existing['status'] != 'queued':
            return None
        if existing and existing['status'] == 'queued':
            current = self._reconcile_one(db, existing, now)
            if current is not None and (current['status'] != 'queued' or _stored_dispatch(existing).get('task_id')):
                return current if current['status'] != 'queued' else None
            if _stored_dispatch(
                    db.execute('SELECT * FROM automation_runs WHERE id=?', (existing['id'],)).fetchone()
            ).get('task_id'):
                return None
            run_id = existing['id']
        else:
            count = db.execute(
                'SELECT COUNT(*) FROM automation_runs WHERE automation_id=?', (row['id'],)
            ).fetchone()[0]
            if count >= self.max_runs:
                return None
            run_id = uuid4().hex
            db.execute(
                'INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?,?,?)',
                (run_id, row['id'], row['workspace_id'], due, now, None, 'queued', None, '{}'),
            )
        return self._dispatch(db, row, run_id, due, now)

    def _dispatch(self, db, row, run_id, due, now):
        """Hand one already-inserted queued run to the backend and record the outcome."""
        public, secret, source = model_api.resolve(
            db, self.store, workspace_id=row['workspace_id'],
        )
        hook = payload(row, run_id, due, model_api.effective_view(public, source))
        hook['now'] = int(now)
        hook['preferred_agents'] = editor_agents(db, row['id'])
        try:
            if isinstance(self.backend, AgentAutomationBackend):
                result = self.backend.dispatch_automation(hook, db=db)
            else:
                result = self.backend.dispatch_automation(hook, db=db, model_api_key=secret)
        except Exception:
            result = {'status': 'failed', 'error_code': 'runtime_failure', 'instance_ids': []}
        status, error, dispatch = sanitize_dispatch(result)
        if status == 'queued':
            db.execute(
                'UPDATE automation_runs SET status=?, error_code=?, dispatch=?, finished=? WHERE id=?',
                (status, error, json.dumps(dispatch, sort_keys=True, separators=(',', ':')), None, run_id),
            )
        else:
            self._finish(db, run_id, now, status, error, dispatch)
        return automations.run_view(db.execute('SELECT * FROM automation_runs WHERE id=?', (run_id,)).fetchone())

    def retry_run(self, db, row, source, now):
        """Queue a fresh run for a finished one. The source run is not touched.

        Returns None when the automation already holds the maximum number of
        runs, so the caller can answer 429 instead of silently dropping work.
        Returns 'moved_to_dsbot' when /automations/ already runs on the owner's
        DS-Bot, so Flask cannot start a second infer.
        """
        from .dsbot_gateway import workspace_moved_to_dsbot
        if workspace_moved_to_dsbot(db, row['workspace_id'], 'automations'):
            return 'moved_to_dsbot'
        count = db.execute(
            'SELECT COUNT(*) FROM automation_runs WHERE automation_id=?', (row['id'],)
        ).fetchone()[0]
        if count >= self.max_runs:
            return None
        # (automation_id, due_at) is unique and a retry is its own slot, so the
        # retry gets the first free instant at or after now.
        due = int(now)
        while db.execute('SELECT 1 FROM automation_runs WHERE automation_id=? AND due_at=?',
                         (row['id'], due)).fetchone() is not None:
            due += 1
        run_id = uuid4().hex
        db.execute(
            'INSERT INTO automation_runs VALUES(?,?,?,?,?,?,?,?,?)',
            (run_id, row['id'], row['workspace_id'], due, now, None, 'queued', None, '{}'),
        )
        return self._dispatch(db, row, run_id, due, now), run_id

    def _reconcile_one(self, db, run, now):
        if run['status'] != 'queued':
            return automations.run_view(run)
        dispatch = _stored_dispatch(run)
        task_id = dispatch.get('task_id')
        if not isinstance(task_id, str) or not re.fullmatch(r'[0-9a-f]{32}', task_id):
            return automations.run_view(run)
        task = runtime_connect.load_task(db, task_id)
        if task is None:
            dispatch['result'] = {'error': 'missing_task'}
            self._finish(db, run['id'], now, 'failed', 'missing_task', dispatch)
            return automations.run_view(db.execute('SELECT * FROM automation_runs WHERE id=?', (run['id'],)).fetchone())
        task = runtime_connect.expire_task(db, task, now)
        view = runtime_connect.view_with_meta(db, task)
        status = view['status']
        if status in ('queued', 'claimed'):
            return automations.run_view(run)
        result = sanitize_result(view.get('result') or {})
        dispatch['result'] = result
        if status == 'succeeded':
            self._finish(db, run['id'], now, 'succeeded', None, dispatch)
        elif status == 'cancelled':
            self._finish(db, run['id'], now, 'failed', 'cancelled', dispatch)
        elif status == 'timeout':
            self._finish(db, run['id'], now, 'failed', 'timeout', dispatch)
        else:
            error = result.get('error') if isinstance(result.get('error'), str) else 'infer_failure'
            if not 1 <= len(error) <= 64 or any(c < ' ' for c in error):
                error = 'infer_failure'
            self._finish(db, run['id'], now, 'failed', error, dispatch)
        return automations.run_view(db.execute('SELECT * FROM automation_runs WHERE id=?', (run['id'],)).fetchone())

    def _finish(self, db, run_id, now, status, error, dispatch):
        db.execute(
            'UPDATE automation_runs SET finished=?, status=?, error_code=?, dispatch=? WHERE id=?',
            (int(now), status, error, json.dumps(dispatch, sort_keys=True, separators=(',', ':')), run_id),
        )


class BackgroundWorker:
    """Periodic tick + reconcile in the Web process. Daemon thread, stoppable."""

    def __init__(self, scheduler, interval=5, sleeper=time.sleep):
        if type(interval) is not int or not 1 <= interval <= 100000:
            raise ValueError('interval must be a bounded positive integer')
        self.scheduler, self.interval, self.sleeper = scheduler, interval, sleeper
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name='openteamily-automation-worker', daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout=2):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)

    def run_cycle(self):
        self.scheduler.recover()

    def _loop(self):
        try:
            self.run_cycle()
        except Exception:
            pass
        while not self._stop.is_set():
            if self._stop.wait(self.interval):
                break
            try:
                self.run_cycle()
            except Exception:
                pass
