"""Workspace automations persistence (issue #6, slice 1).

Self-written for OpenTeamily; no FlyBot Project plugin, Bot Social, DS-Bot or
Teamily source. Observed Teamily automation config included a template, a
prompt, a time and participating members, but no automation was created or
run. Schedule shapes, the custom template and role defaults below are
OpenTeamily assumptions and are not Teamily parity. Scheduling and run
records live in scheduler.py; this module still does not execute containers.
"""
import json
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SCHEMA = '''
CREATE TABLE IF NOT EXISTS automations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 prompt TEXT NOT NULL,
 template_id TEXT NOT NULL,
 schedule TEXT NOT NULL,
 participants TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS automation_workspace ON automations(workspace_id, id);
'''

TEMPLATES = {
    'custom': {'id': 'custom', 'title': 'Custom', 'prompt': ''},
}

TIME = re.compile(r'(?:[01]\d|2[0-3]):[0-5]\d')
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
TITLE = re.compile(r'.*')  # length/control checks are applied separately


def templates():
    return [dict(item) for item in TEMPLATES.values()]


def valid_title(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= 80
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)
            and _unicode(value))


def valid_prompt(value):
    return isinstance(value, str) and 1 <= len(value) <= 4000 and '\x00' not in value and _unicode(value)


def _unicode(value):
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def valid_schedule(value):
    if not isinstance(value, dict):
        return False
    kind, time, zone = value.get('kind'), value.get('time'), value.get('time_zone')
    if kind not in ('once', 'daily', 'weekly') or not isinstance(time, str) or not TIME.fullmatch(time):
        return False
    if not isinstance(zone, str) or not 1 <= len(zone) <= 64:
        return False
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return False
    keys = {'kind', 'time', 'time_zone'}
    if kind == 'once':
        day = value.get('date')
        if not isinstance(day, str) or not DATE.fullmatch(day):
            return False
        try:
            date.fromisoformat(day)
        except ValueError:
            return False
        keys.add('date')
    if kind == 'weekly':
        weekday = value.get('weekday')
        if type(weekday) is not int or not 1 <= weekday <= 7:
            return False
        keys.add('weekday')
    return set(value) == keys


def normalize_schedule(value):
    schedule = {'kind': value['kind'], 'time': value['time'], 'time_zone': value['time_zone']}
    if value['kind'] == 'once':
        schedule['date'] = value['date']
    if value['kind'] == 'weekly':
        schedule['weekday'] = value['weekday']
    return schedule


def valid_usernames(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        return False
    seen = set()
    for name in value:
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', name)
                or name.lower() in seen):
            return False
        seen.add(name.lower())
    return True


def view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'prompt': row['prompt'],
        'template_id': row['template_id'],
        'schedule': json.loads(row['schedule']),
        'participants': json.loads(row['participants']),
        'enabled': bool(row['enabled']),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
    }


RUN_SCHEMA = '''
CREATE TABLE IF NOT EXISTS automation_runs (
 id TEXT PRIMARY KEY,
 automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 due_at INTEGER NOT NULL,
 started INTEGER NOT NULL,
 finished INTEGER,
 status TEXT NOT NULL CHECK(status IN ('queued','succeeded','failed','skipped')),
 error_code TEXT,
 dispatch TEXT NOT NULL,
 UNIQUE(automation_id, due_at));
CREATE INDEX IF NOT EXISTS automation_run_list ON automation_runs(automation_id, id);
'''

SCHEMA = SCHEMA + RUN_SCHEMA


def due_at(schedule, now_ts):
    """Return the current slot's unix time if it is due, otherwise None.

    Only the latest slot is considered; missed earlier days are not backfilled.
    """
    try:
        zone = ZoneInfo(schedule['time_zone'])
        hour, minute = (int(part) for part in schedule['time'].split(':'))
        now = datetime.fromtimestamp(int(now_ts), zone)
    except (KeyError, TypeError, ValueError, ZoneInfoNotFoundError, OSError):
        return None
    kind = schedule.get('kind')
    if kind == 'once':
        try:
            year, month, day = (int(part) for part in schedule['date'].split('-'))
            moment = datetime(year, month, day, hour, minute, tzinfo=zone)
        except (KeyError, TypeError, ValueError, OSError):
            return None
        ts = int(moment.timestamp())
        return ts if int(now_ts) >= ts else None
    if kind == 'weekly' and now.isoweekday() != schedule.get('weekday'):
        return None
    if kind not in ('daily', 'weekly'):
        return None
    moment = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    ts = int(moment.timestamp())
    return ts if int(now_ts) >= ts else None


def run_view(row):
    try:
        dispatch = json.loads(row['dispatch'])
    except ValueError:
        dispatch = {}
    if not isinstance(dispatch, dict):
        dispatch = {}
    return {
        'id': row['id'],
        'automation_id': row['automation_id'],
        'workspace_id': row['workspace_id'],
        'due_at': row['due_at'],
        'started': row['started'],
        'finished': row['finished'],
        'status': row['status'],
        'error_code': row['error_code'],
        'dispatch': {key: dispatch[key] for key in ('instance_ids', 'backend') if key in dispatch},
    }
