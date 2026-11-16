"""Evaluate due automations and record dispatch hooks (issue #6, slice 2).

The Web process does not start a background timer. An operator or test calls
tick explicitly. The hook talks to a runtime backend interface; the bundled
fake backend records the dispatch and never starts Docker. Real container
execution is left to a later Compose wiring slice. Not Teamily parity.
"""
import json
from uuid import uuid4

from . import automations, model_api


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


def sanitize_dispatch(result):
    result = result or {}
    status = result.get('status')
    if status not in ('succeeded', 'failed', 'skipped'):
        status = 'failed'
    error = result.get('error_code')
    if error is not None and (not isinstance(error, str) or not 1 <= len(error) <= 64 or any(c < ' ' for c in error)):
        error = 'runtime_failure'
    ids = result.get('instance_ids') or []
    if not isinstance(ids, list):
        ids = []
    clean = [item for item in ids if isinstance(item, str) and len(item) == 32]
    return status, error, {'instance_ids': clean[:32], 'backend': 'recorded'}


class Scheduler:
    def __init__(self, store, backend=None, clock=None, max_runs=200):
        self.store, self.backend, self.clock = store, backend or NullAutomationBackend(), clock
        self.max_runs = max_runs

    def tick_workspace(self, db, workspace_id, now):
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

    def tick_all(self, now=None):
        now = int(self.clock() if now is None else now)
        with self.store.transaction() as db:
            ids = [item[0] for item in db.execute('SELECT id FROM workspaces ORDER BY id')]
            fired = []
            for workspace_id in ids:
                fired.extend(self.tick_workspace(db, workspace_id, now))
            return fired

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
        if existing is None:
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
        else:
            run_id = existing['id']
        public, secret, source = model_api.resolve(db, self.store, workspace_id=row['workspace_id'])
        hook = payload(row, run_id, due, model_api.effective_view(public, source))
        try:
            result = self.backend.dispatch_automation(hook, db=db, model_api_key=secret)
        except Exception:
            result = {'status': 'failed', 'error_code': 'runtime_failure', 'instance_ids': []}
        status, error, dispatch = sanitize_dispatch(result)
        finished = int(now)
        db.execute(
            'UPDATE automation_runs SET finished=?, status=?, error_code=?, dispatch=? WHERE id=?',
            (finished, status, error, json.dumps(dispatch, sort_keys=True, separators=(',', ':')), run_id),
        )
        return automations.run_view(db.execute('SELECT * FROM automation_runs WHERE id=?', (run_id,)).fetchone())
