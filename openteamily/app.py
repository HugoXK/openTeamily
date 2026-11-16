"""WSGI management API. No Docker, subprocess, host mounts, or runtime credentials."""
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
import hmac
import json
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from .security import digest, dummy_verify, opaque, password_hash, password_matches
from .lifecycle import RuntimeFault, UNSUPPORTED


class APIError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def refuse(status, code, message):
    raise APIError(status, code, message)


@dataclass(frozen=True)
class Config:
    origin: str
    insecure_local: bool = False
    allow_registration: bool = False
    session_seconds: int = 43200
    max_users: int = 1000
    max_sessions_per_user: int = 8
    max_sessions: int = 8192
    max_workspaces_per_user: int = 20
    max_workspaces: int = 10000
    auth_peer_limit: int = 20
    auth_name_limit: int = 10
    auth_global_limit: int = 100
    auth_window: int = 600
    max_rate_buckets: int = 4096

    def __post_init__(self):
        parsed = urlsplit(self.origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or parsed.netloc != parsed.netloc.lower()):
            raise ValueError('Use an exact lowercase HTTP(S) origin without path or credentials')
        if parsed.scheme != 'https' and not (self.insecure_local and parsed.hostname in ('127.0.0.1', 'localhost', '::1')):
            raise ValueError('HTTP is allowed only for explicit insecure loopback development')
        if self.insecure_local and (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')):
            raise ValueError('Insecure cookies are restricted to HTTP loopback development')
        for name in self.__dataclass_fields__:
            if name not in ('origin', 'insecure_local', 'allow_registration'):
                value = getattr(self, name)
                if type(value) is not int or not 1 <= value <= (604800 if name == 'session_seconds' else 100000):
                    raise ValueError('Limits must be bounded positive integers')
        if self.session_seconds > 604800:
            raise ValueError('Session lifetime cannot exceed seven days')

    @property
    def cookie_names(self):
        prefix = 'ot_dev_' if self.insecure_local else '__Host-ot_'
        return prefix + 'session', prefix + 'csrf'


def object_only(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


class App:
    def __init__(self, store, config, clock=time.time, lifecycle=None, manager_auth=None):
        self.store, self.config, self.clock = store, config, clock
        self.lifecycle, self.manager_auth = lifecycle, manager_auth

    def __call__(self, env, start_response):
        headers = [('Content-Type', 'application/json; charset=utf-8'), ('Cache-Control', 'no-store'),
                   ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'),
                   ('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")]
        try:
            status, body, extra = self.dispatch(env)
            headers += extra
        except (APIError, RuntimeFault) as error:
            status, body = error.status, {'error': {'code': error.code, 'message': error.message}}
            if isinstance(error, RuntimeFault) and error.current is not None:
                body['error']['current'] = error.current
            if status == 429:
                headers.append(('Retry-After', str(self.config.auth_window)))
        except (sqlite3.Error, OSError):
            status, body = 503, {'error': {'code': 'unavailable', 'message': 'Storage is temporarily unavailable'}}
        except Exception:
            status, body = 500, {'error': {'code': 'internal', 'message': 'Internal service error'}}
        data = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        headers.append(('Content-Length', str(len(data))))
        reasons = {200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
                   404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 411: 'Length Required',
                   413: 'Content Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
                   500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable'}
        start_response(f'{status} {reasons[status]}', headers)
        return [data]

    def cookies(self, env):
        raw = env.get('HTTP_COOKIE', '')
        if len(raw) > 4096:
            refuse(400, 'invalid', 'Cookie header is too large')
        try:
            names = [part.split('=', 1)[0].strip() for part in raw.split(';') if '=' in part]
            if len(names) != len(set(names)):
                raise ValueError()
            result = SimpleCookie()
            result.load(raw)
            return {key: value.value for key, value in result.items()}
        except (CookieError, ValueError):
            refuse(400, 'invalid', 'Malformed cookies')

    def body(self, env, allowed):
        if env.get('HTTP_TRANSFER_ENCODING'):
            refuse(400, 'invalid', 'Transfer encoding is not supported')
        length = env.get('CONTENT_LENGTH', '')
        if not re.fullmatch(r'[0-9]{1,6}', length):
            refuse(411, 'invalid', 'A bounded Content-Length is required')
        length = int(length)
        if length > 16384:
            refuse(413, 'invalid', 'Request body is too large')
        if env.get('CONTENT_TYPE', '').split(';', 1)[0].strip().lower() != 'application/json':
            refuse(415, 'invalid', 'Use application/json')
        raw = env['wsgi.input'].read(length)
        try:
            if len(raw) != length:
                raise ValueError()
            body = json.loads(raw.decode('utf-8'), object_pairs_hook=object_only,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(body, dict) or set(body) - set(allowed):
                raise ValueError()
            return body
        except (ValueError, UnicodeError, RecursionError):
            refuse(400, 'invalid', 'Malformed JSON or unexpected fields')

    def origin_check(self, env):
        if (env.get('HTTP_ORIGIN') != self.config.origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            refuse(403, 'origin', 'A same-origin request is required')

    def csrf_check(self, env, session):
        self.origin_check(env)
        csrf = env.get('HTTP_X_CSRF_TOKEN', '')
        cookie = self.cookies(env).get(self.config.cookie_names[1], '')
        if (not re.fullmatch(r'[A-Za-z0-9_-]{43}', csrf) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', cookie) or not hmac.compare_digest(csrf, cookie)
                or not hmac.compare_digest(digest(csrf), session['csrf_hash'])):
            refuse(403, 'csrf', 'A valid CSRF token is required')

    def authenticated(self, db, env, now):
        token = self.cookies(env).get(self.config.cookie_names[0], '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            refuse(401, 'unauthorized', 'Sign in first')
        session = db.execute('SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id '
                             'WHERE s.token_hash=? AND s.expires>?', (digest(token), now)).fetchone()
        if session is None:
            refuse(401, 'unauthorized', 'Sign in first')
        return session

    def rate_limit(self, env, username, now):
        peer = env.get('REMOTE_ADDR', '')
        if len(peer) > 128:
            refuse(400, 'invalid', 'Invalid client address')
        limits = [('peer:' + peer, self.config.auth_peer_limit),
                  ('name:' + username, self.config.auth_name_limit), ('global', self.config.auth_global_limit)]
        blocked = False
        with self.store.transaction() as db:
            db.execute('DELETE FROM rate_limits WHERE expires<=?', (now,))
            for key, limit in limits:
                key = digest(key)
                row = db.execute('SELECT count FROM rate_limits WHERE key=?', (key,)).fetchone()
                if row is None:
                    if db.execute('SELECT COUNT(*) FROM rate_limits').fetchone()[0] >= self.config.max_rate_buckets:
                        blocked = True
                        break
                    db.execute('INSERT INTO rate_limits VALUES(?,1,?)', (key, now + self.config.auth_window))
                else:
                    if row['count'] >= limit:
                        blocked = True
                    else:
                        db.execute('UPDATE rate_limits SET count=count+1 WHERE key=?', (key,))
        if blocked:
            refuse(429, 'rate_limited', 'Authentication request limit reached; try later')

    def session_headers(self, token, csrf, expires=False):
        headers = []
        for name, value, http_only in zip(self.config.cookie_names, [token, csrf], [True, False]):
            cookie = SimpleCookie()
            cookie[name] = value
            item = cookie[name]
            item['path'], item['samesite'] = '/', 'Strict'
            item['max-age'] = 0 if expires else self.config.session_seconds
            if not self.config.insecure_local:
                item['secure'] = True
            if http_only:
                item['httponly'] = True
            headers.append(('Set-Cookie', item.OutputString()))
        return headers

    def new_session(self, db, user_id, now):
        db.execute('DELETE FROM sessions WHERE expires<=?', (now,))
        count = db.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?', (user_id,)).fetchone()[0]
        if count >= self.config.max_sessions_per_user:
            db.execute('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? '
                       'ORDER BY created,rowid LIMIT ?)', (user_id, count - self.config.max_sessions_per_user + 1))
        if db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] >= self.config.max_sessions:
            refuse(429, 'quota', 'Session capacity reached')
        token, csrf = opaque(), opaque()
        db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',
                   (digest(token), digest(csrf), user_id, now + self.config.session_seconds, now))
        return self.session_headers(token, csrf)

    def credentials(self, body):
        username, password = body.get('username'), body.get('password')
        if (not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', username)
                or not isinstance(password, str) or not 12 <= len(password) <= 256):
            refuse(400, 'invalid', 'Use a 3–64 character username and a 12–256 character password')
        try:
            if len(password.encode('utf-8')) > 256:
                raise ValueError()
        except (UnicodeError, ValueError):
            refuse(400, 'invalid', 'Password exceeds the UTF-8 byte limit')
        return username.lower(), password

    def dispatch(self, env):
        if env.get('HTTP_HOST', '').lower() != urlsplit(self.config.origin).netloc:
            refuse(403, 'host', 'Unrecognized host')
        if env.get('HTTP_ORIGIN') and env['HTTP_ORIGIN'] != self.config.origin:
            refuse(403, 'origin', 'A same-origin request is required')
        method, path, query = env.get('REQUEST_METHOD'), env.get('PATH_INFO', ''), env.get('QUERY_STRING', '')
        if len(path) > 256 or len(query) > 512:
            refuse(400, 'invalid', 'Request target is too long')
        if method not in ('GET', 'POST'):
            refuse(405, 'method', 'Only GET and POST are supported')
        if method == 'POST' and query:
            refuse(400, 'invalid', 'Query parameters are not accepted for writes')
        now = int(self.clock())
        if path in ('/v1/auth/register', '/v1/auth/login') and method == 'POST':
            self.origin_check(env)  # Login/registration CSRF protection before a session exists.
            body = self.body(env, ['username', 'password'])
            username, password = self.credentials(body)
            self.rate_limit(env, username, now)  # Separate committed transaction: failures count too.
            if path.endswith('register'):
                if not self.config.allow_registration:
                    refuse(403, 'registration_closed', 'Public registration is disabled')
                with self.store.transaction() as db:
                    if db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
                        refuse(409, 'conflict', 'Registration is unavailable for this username')
                    if db.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= self.config.max_users:
                        refuse(429, 'quota', 'Account capacity reached')
                    user_id = uuid4().hex
                    db.execute('INSERT INTO users VALUES(?,?,?,?)', (user_id, username, password_hash(password), now))
                    headers = self.new_session(db, user_id, now)
                return 201, {'user': {'id': user_id, 'username': username}}, headers
            with self.store.connect() as db:
                user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            if user is None:
                dummy_verify(password)
                refuse(401, 'unauthorized', 'Invalid username or password')
            if not password_matches(password, user['password_hash']):
                refuse(401, 'unauthorized', 'Invalid username or password')
            with self.store.transaction() as db:
                headers = self.new_session(db, user['id'], now)
            return 200, {'user': {'id': user['id'], 'username': user['username']}}, headers
        runtime_path = re.fullmatch(r'/v1/workspaces/[0-9a-f]{32}/instances|/v1/instances/[0-9a-f]{32}(?:/[a-z]+)?|/v1/jobs/[0-9a-f]{32}', path)
        if self.lifecycle is not None and (runtime_path or path.startswith('/v1/internal/')):
            if path.startswith('/v1/internal/'):
                if self.manager_auth is None:
                    refuse(401, 'manager_auth', 'Manager access is not configured')
                manager = self.manager_auth.authenticate(env)
                return self.manager_dispatch(env, manager, method, path, query)
            with self.store.connect() as db:
                session = self.authenticated(db, env, now)
            if method == 'POST':
                self.csrf_check(env, session)
            return self.runtime_dispatch(env, session['user_id'], method, path, query)
        with self.store.transaction() as db:
            session = self.authenticated(db, env, now)
            if method == 'POST':
                self.csrf_check(env, session)
            if path == '/v1/auth/session' and method == 'GET' and not query:
                return 200, {'user': {'id': session['user_id'], 'username': session['username']},
                             'expires_at': session['expires']}, []
            if path == '/v1/auth/logout' and method == 'POST':
                self.body(env, [])
                db.execute('DELETE FROM sessions WHERE token_hash=?', (session['token_hash'],))
                return 200, {'logged_out': True}, self.session_headers('', '', expires=True)
            if path == '/v1/workspaces' and method == 'POST':
                body = self.body(env, ['name'])
                name = body.get('name')
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in name):
                    refuse(400, 'invalid', 'Workspace name must be 1–80 characters without controls')
                name = name.strip()
                try:
                    name.encode('utf-8')
                except UnicodeError:
                    refuse(400, 'invalid', 'Workspace name must be valid Unicode')
                key = env.get('HTTP_IDEMPOTENCY_KEY', '')
                if not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', key):
                    refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
                key_hash, request_hash = digest(key), digest(name)
                existing = db.execute('SELECT * FROM workspaces WHERE owner_id=? AND key_hash=?',
                                      (session['user_id'], key_hash)).fetchone()
                if existing:
                    if existing['request_hash'] != request_hash:
                        refuse(409, 'conflict', 'Idempotency key was used for a different request')
                    return 200, {'workspace': self.workspace(existing)}, []
                if (db.execute('SELECT COUNT(*) FROM workspaces WHERE owner_id=?', (session['user_id'],)).fetchone()[0] >= self.config.max_workspaces_per_user
                        or db.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0] >= self.config.max_workspaces):
                    refuse(429, 'quota', 'Workspace capacity reached')
                workspace_id = uuid4().hex
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                           (workspace_id, session['user_id'], name, now, key_hash, request_hash))
                row = db.execute('SELECT * FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
                return 201, {'workspace': self.workspace(row)}, []
            if path == '/v1/workspaces' and method == 'GET':
                try:
                    args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=2) if query else {}
                    if set(args) - {'limit', 'cursor'} or any(len(v) != 1 for v in args.values()):
                        raise ValueError()
                    limit, cursor = args.get('limit', ['20'])[0], args.get('cursor', [''])[0]
                    if not re.fullmatch(r'[0-9]{1,3}', limit) or not 1 <= int(limit) <= 100:
                        raise ValueError()
                    if cursor and not re.fullmatch(r'[0-9a-f]{32}', cursor):
                        raise ValueError()
                except ValueError:
                    refuse(400, 'invalid', 'Invalid pagination parameters')
                rows = db.execute('SELECT * FROM workspaces WHERE owner_id=? AND id>? ORDER BY id LIMIT ?',
                                  (session['user_id'], cursor, int(limit) + 1)).fetchall()
                return 200, {'items': [self.workspace(row) for row in rows[:int(limit)]],
                             'cursor': rows[int(limit) - 1]['id'] if len(rows) > int(limit) else None}, []
            match = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})(/instances)?', path)
            if match:
                row = db.execute('SELECT * FROM workspaces WHERE id=? AND owner_id=?',
                                 (match[1], session['user_id'])).fetchone()
                if row is None:
                    refuse(404, 'not_found', 'Workspace not found')
                if match[2]:
                    refuse(501, 'unsupported', 'Runtime lifecycle is not implemented in this slice')
                if method == 'GET' and not query:
                    return 200, {'workspace': self.workspace(row)}, []
            if path.startswith(('/v1/instances/', '/v1/internal/')):
                refuse(501, 'unsupported', 'Runtime lifecycle and manager authentication are not implemented in this slice')
        refuse(404, 'not_found', 'Route not found')

    @staticmethod
    def workspace(row):
        return {key: row[key] for key in ('id', 'owner_id', 'name', 'created')}

    @staticmethod
    def pagination(query, allowed=()):
        try:
            args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=3) if query else {}
            if set(args) - {'limit', 'cursor', *allowed} or any(len(v) != 1 for v in args.values()):
                raise ValueError()
            limit, cursor = args.get('limit', ['20'])[0], args.get('cursor', [''])[0]
            if not re.fullmatch(r'[0-9]{1,3}', limit) or not 1 <= int(limit) <= 100 or (cursor and not re.fullmatch(r'[0-9a-f]{32}', cursor)):
                raise ValueError()
            return int(limit), cursor, args
        except ValueError:
            refuse(400, 'invalid', 'Invalid pagination parameters')

    def runtime_dispatch(self, env, owner, method, path, query):
        runtime = self.lifecycle
        match = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})/instances', path)
        if match:
            if method == 'POST':
                self.body(env, [])
                created, result = runtime.create(owner, match[1], env.get('HTTP_IDEMPOTENCY_KEY', ''))
                return 201 if created else 200, result, []
            limit, cursor, _ = self.pagination(query)
            return 200, runtime.listing(owner, match[1], limit, cursor), []
        match = re.fullmatch(r'/v1/jobs/([0-9a-f]{32})', path)
        if match and method == 'GET' and not query:
            return 200, {'job': runtime.get_job(owner, match[1])}, []
        match = re.fullmatch(r'/v1/instances/([0-9a-f]{32})(?:/([a-z]+))?', path)
        if match:
            iid, action = match.groups()
            # Authorization precedes even unsupported operation disclosure.
            instance = runtime.inspect(owner, iid)
            if method == 'GET' and action is None and not query:
                return 200, {'instance': instance}, []
            if method == 'POST' and action in UNSUPPORTED:
                self.body(env, [])
                refuse(501, 'unsupported', 'This runtime operation is not implemented')
            if method == 'POST' and action in ('start', 'stop', 'restart'):
                body = self.body(env, ['expected_revision', 'operation_id'] if action == 'restart' else ['expected_revision'])
                changed, result = getattr(runtime, action)(owner, iid, **body)
                return 202 if changed else 200, result, []
            if method == 'GET' and action == 'logs':
                try:
                    args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=1) if query else {}
                    if set(args) - {'tail'} or any(len(v) != 1 for v in args.values()):
                        raise ValueError()
                    tail = args.get('tail', ['100'])[0]
                    if not re.fullmatch(r'[0-9]{1,3}', tail):
                        raise ValueError()
                except ValueError:
                    refuse(400, 'invalid', 'Invalid log options')
                return 200, runtime.logs(owner, iid, int(tail)), []
        refuse(404, 'not_found', 'Route not found')

    def manager_dispatch(self, env, manager, method, path, query):
        runtime = self.lifecycle
        if path == '/v1/internal/instances' and method == 'GET':
            limit, cursor, args = self.pagination(query, ('desired',))
            desired = args.get('desired', [None])[0]
            if desired not in (None, 'running', 'stopped'):
                refuse(400, 'invalid', 'Invalid desired filter')
            return 200, runtime.manager_list(manager, desired, limit, cursor), []
        if path == '/v1/internal/jobs/claim' and method == 'POST':
            body = self.body(env, ['instance_id'])
            iid = body.get('instance_id')
            if not isinstance(iid, str) or not re.fullmatch(r'[0-9a-f]{32}', iid):
                refuse(400, 'invalid', 'Invalid instance_id')
            return 200, {'claim': runtime.claim(manager, iid)}, []
        match = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/(observe|heartbeat)', path)
        if match and method == 'POST':
            allowed = ['job_id', 'observed_revision', 'lease']
            if match[2] == 'observe':
                allowed += ['observed', 'process_ref', 'error_code']
            body = self.body(env, allowed)
            required = {'job_id', 'observed_revision', 'lease'} | ({'observed'} if match[2] == 'observe' else set())
            if not required <= body.keys() or not isinstance(body['job_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['job_id']):
                refuse(400, 'invalid', 'Incomplete or invalid manager observation')
            body['jid'], body['revision'] = body.pop('job_id'), body.pop('observed_revision')
            handler = runtime.observe if match[2] == 'observe' else runtime.heartbeat
            return 200, handler(manager, match[1], **body), []
        refuse(404, 'not_found', 'Route not found')
