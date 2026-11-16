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
from . import automations, invites, members, oidc, settings


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
    max_members_per_workspace: int = 50
    max_invites_per_workspace: int = 20
    max_automations_per_workspace: int = 20
    max_runs_per_automation: int = 200
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
    def __init__(self, store, config, clock=time.time, lifecycle=None, manager_auth=None, automation_backend=None, oidc_registry=None):
        self.store, self.config, self.clock = store, config, clock
        self.lifecycle, self.manager_auth = lifecycle, manager_auth
        self.automation_backend = automation_backend
        self.oidc_registry = oidc_registry

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
            if status == 429 and error.code == 'rate_limited':
                headers.append(('Retry-After', str(self.config.auth_window)))
        except (sqlite3.Error, OSError):
            status, body = 503, {'error': {'code': 'unavailable', 'message': 'Storage is temporarily unavailable'}}
        except Exception:
            status, body = 500, {'error': {'code': 'internal', 'message': 'Internal service error'}}
        data = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        headers.append(('Content-Length', str(len(data))))
        reasons = {200: 'OK', 201: 'Created', 202: 'Accepted', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
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

    def oidc_start(self, env, now, body):
        provider_id = body.get('provider')
        if not isinstance(provider_id, str) or self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        provider = self.oidc_registry.get(provider_id)
        if provider is None:
            refuse(404, 'not_found', 'Provider not found')
        self.rate_limit(env, 'oidc:' + provider.id, now)
        state, nonce = opaque(), opaque()
        verifier, challenge = oidc.pkce_pair()
        redirect_uri = self.config.origin + '/v1/auth/oidc/callback'
        user_id = None
        with self.store.transaction() as db:
            token = self.cookies(env).get(self.config.cookie_names[0], '')
            if re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                session = db.execute(
                    'SELECT user_id FROM sessions WHERE token_hash=? AND expires>?', (digest(token), now)
                ).fetchone()
                user_id = None if session is None else session['user_id']
            db.execute('DELETE FROM oidc_states WHERE expires<=?', (now,))
            if db.execute('SELECT COUNT(*) FROM oidc_states').fetchone()[0] >= oidc.MAX_STATES:
                refuse(429, 'quota', 'Authentication request limit reached; try later')
            db.execute(
                'INSERT INTO oidc_states VALUES(?,?,?,?,?,?,?)',
                (digest(state), provider.id, nonce, oidc.wrap(oidc.wrapping_key(self.store), verifier),
                 user_id, now, now + oidc.STATE_TTL),
            )
        url = self.oidc_registry.authorization_url(
            provider, state=state, nonce=nonce, challenge=challenge, redirect_uri=redirect_uri)
        return 200, {'authorization_url': url, 'provider': provider.id}, []

    def oidc_callback(self, env, now, query):
        if self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        try:
            args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=8) if query else {}
            if any(len(v) != 1 for v in args.values()):
                raise ValueError()
        except ValueError:
            refuse(400, 'invalid', 'Invalid callback parameters')
        if args.get('error'):
            refuse(400, 'invalid', 'Sign-in was cancelled or rejected')
        state, code = args.get('state', [None])[0], args.get('code', [None])[0]
        if (not isinstance(state, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', state)
                or not isinstance(code, str) or not 8 <= len(code) <= 256 or any(c < ' ' for c in code)):
            refuse(400, 'invalid', 'Invalid callback parameters')
        redirect_uri = self.config.origin + '/v1/auth/oidc/callback'
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM oidc_states WHERE state_hash=?', (digest(state),)).fetchone()
            if row is None or row['expires'] <= now:
                refuse(400, 'invalid', 'Sign-in session expired; start again')
            db.execute('DELETE FROM oidc_states WHERE state_hash=?', (row['state_hash'],))
            provider_id, nonce, verifier_blob, session_user = row['provider'], row['nonce'], row['verifier_blob'], row['user_id']
        provider = self.oidc_registry.get(provider_id)
        if provider is None:
            refuse(404, 'not_found', 'Provider not found')
        try:
            verifier = oidc.unwrap(oidc.wrapping_key(self.store), verifier_blob)
            identity = self.oidc_registry.exchange(
                provider, code=code, verifier=verifier, redirect_uri=redirect_uri,
                nonce=nonce, now=now)
        except ValueError:
            refuse(400, 'invalid', 'Sign-in could not be verified')
        with self.store.transaction() as db:
            return self.finish_oidc(db, now, identity, session_user)

    def oidc_link(self, env, now):
        self.origin_check(env)
        if self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        with self.store.transaction() as db:
            session = None
            token_cookie = self.cookies(env).get(self.config.cookie_names[0], '')
            if re.fullmatch(r'[A-Za-z0-9_-]{43}', token_cookie):
                session = db.execute(
                    'SELECT s.*,u.username,u.password_hash FROM sessions s JOIN users u ON u.id=s.user_id '
                    'WHERE s.token_hash=? AND s.expires>?', (digest(token_cookie), now)
                ).fetchone()
            if session is not None:
                self.csrf_check(env, session)
                body = self.body(env, ['token'])
            else:
                body = self.body(env, ['token', 'username', 'password'])
            token = body.get('token')
            if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                refuse(400, 'invalid', 'Provide a valid link token')
            db.execute('DELETE FROM oidc_link_tokens WHERE expires<=?', (now,))
            row = db.execute('SELECT * FROM oidc_link_tokens WHERE token_hash=?', (digest(token),)).fetchone()
            if row is None or row['expires'] <= now:
                refuse(400, 'invalid', 'Link token expired; start again')
            if session is not None:
                if session['user_id'] != row['user_id']:
                    refuse(403, 'forbidden', 'Sign in to the matching account to confirm')
                user_id = session['user_id']
            else:
                try:
                    username, password = self.credentials(body)
                except APIError:
                    raise
                user = db.execute('SELECT * FROM users WHERE id=?', (row['user_id'],)).fetchone()
                if user is None or user['username'] != username or not password_matches(password, user['password_hash']):
                    dummy_verify(body.get('password') if isinstance(body.get('password'), str) else 'x' * 12)
                    refuse(401, 'unauthorized', 'Invalid username or password')
                user_id = user['id']
            db.execute('DELETE FROM oidc_link_tokens WHERE token_hash=?', (row['token_hash'],))
            identity = {'provider': row['provider'], 'subject': row['subject'], 'email': row['email']}
            return self.finish_oidc(db, now, identity, user_id, confirmed=True)

    def finish_oidc(self, db, now, identity, session_user_id, confirmed=False):
        existing = db.execute(
            'SELECT * FROM user_identities WHERE provider=? AND subject=?',
            (identity['provider'], identity['subject']),
        ).fetchone()
        if existing:
            if session_user_id and existing['user_id'] != session_user_id:
                refuse(409, 'conflict', 'This login is already linked to another account')
            return self.oidc_signed_in(db, now, existing['user_id'])
        owner = db.execute('SELECT * FROM user_emails WHERE email=?', (identity['email'],)).fetchone()
        if session_user_id:
            if owner and owner['user_id'] != session_user_id:
                refuse(409, 'conflict', 'This email is already linked to another account')
            self.attach_oidc(db, session_user_id, identity, now)
            return self.oidc_signed_in(db, now, session_user_id)
        if owner and not confirmed:
            token = opaque()
            db.execute(
                'INSERT INTO oidc_link_tokens VALUES(?,?,?,?,?,?)',
                (digest(token), identity['provider'], identity['subject'], identity['email'],
                 owner['user_id'], now + oidc.LINK_TTL),
            )
            hint = identity['email'][0] + '***@' + identity['email'].split('@', 1)[1]
            return 409, {'error': {'code': 'link_required', 'message': 'Confirm linking this login to the existing account'},
                         'link': {'token': token, 'email_hint': hint}}, []
        if owner and confirmed:
            self.attach_oidc(db, owner['user_id'], identity, now)
            return self.oidc_signed_in(db, now, owner['user_id'])
        user_id = uuid4().hex
        base = oidc.username_for(identity['email'], user_id)
        username, suffix = base, 0
        while db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
            suffix += 1
            username = (base[:28] + '-' + str(suffix))[:64]
        if db.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= self.config.max_users:
            refuse(429, 'quota', 'Account capacity reached')
        db.execute(
            'INSERT INTO users VALUES(?,?,?,?)',
            (user_id, username, password_hash(opaque() + opaque()), now),
        )
        self.attach_oidc(db, user_id, identity, now)
        return self.oidc_signed_in(db, now, user_id)

    def attach_oidc(self, db, user_id, identity, now):
        db.execute(
            'INSERT INTO user_identities VALUES(?,?,?,?,?)',
            (identity['provider'], identity['subject'], user_id, identity['email'], now),
        )
        if db.execute('SELECT email FROM user_emails WHERE email=?', (identity['email'],)).fetchone() is None:
            db.execute('INSERT INTO user_emails VALUES(?,?,1,?)', (user_id, identity['email'], now))

    def oidc_signed_in(self, db, now, user_id):
        user = db.execute('SELECT id, username FROM users WHERE id=?', (user_id,)).fetchone()
        headers = self.new_session(db, user['id'], now)
        headers.append(('Location', '/settings'))
        return 302, {'redirect': '/settings', 'user': {'id': user['id'], 'username': user['username']}}, headers

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
        if path == '/v1/auth/providers' and method == 'GET' and not query:
            items = self.oidc_registry.public() if self.oidc_registry else []
            return 200, {'items': items}, []
        if path == '/v1/auth/oidc/start' and method == 'POST' and not query:
            self.origin_check(env)
            return self.oidc_start(env, now, self.body(env, ['provider']))
        if path == '/v1/auth/oidc/callback' and method == 'GET':
            return self.oidc_callback(env, now, query)
        if path == '/v1/auth/oidc/link' and method == 'POST' and not query:
            return self.oidc_link(env, now)
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
            if path == '/v1/settings' and method == 'GET' and not query:
                row = db.execute('SELECT * FROM user_settings WHERE user_id=?', (session['user_id'],)).fetchone()
                return 200, {'settings': settings.view(row)}, []
            if path == '/v1/settings' and method == 'POST':
                body = self.body(env, ['revision', 'changes'])
                revision, changes = body.get('revision'), body.get('changes')
                if type(revision) is not int or not 0 <= revision <= 2 ** 31 or not isinstance(changes, dict) or not changes:
                    refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
                for name, value in changes.items():
                    if name not in settings.FIELDS or not settings.valid_value(name, value):
                        refuse(400, 'invalid', 'Unknown setting or unsupported value')
                row = db.execute('SELECT * FROM user_settings WHERE user_id=?', (session['user_id'],)).fetchone()
                current = settings.view(row)
                if revision != current['revision']:
                    raise RuntimeFault(409, 'conflict', 'Settings changed elsewhere; reload and retry', current)
                values = dict(current['values'], **changes)
                if values == current['values'] and row is not None:
                    return 200, {'settings': current}, []
                document = json.dumps(values, sort_keys=True, separators=(',', ':'))
                db.execute('INSERT INTO user_settings VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET '
                           'document=excluded.document, revision=excluded.revision, updated=excluded.updated',
                           (session['user_id'], document, current['revision'] + 1, now))
                return 200, {'settings': {'values': values, 'revision': current['revision'] + 1}}, []
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
                rows = members.visible(db, session['user_id'], cursor, int(limit) + 1)
                return 200, {'items': [self.workspace(row) for row in rows[:int(limit)]],
                             'cursor': rows[int(limit) - 1]['id'] if len(rows) > int(limit) else None}, []
            if path == '/v1/automation-templates' and method == 'GET' and not query:
                return 200, {'items': automations.templates()}, []
            auto_path = re.fullmatch(
                r'/v1/workspaces/([0-9a-f]{32})/automations(?:/(tick)|(?:/([0-9a-f]{32})(?:/(remove|runs))?))?', path)
            if auto_path:
                return self.automation_dispatch(db, session, method, query, now, env, *auto_path.groups())
            if path == '/v1/invites/accept' and method == 'POST' and not query:
                return self.accept_invite(db, session, now, self.body(env, ['token']))
            invite_path = re.fullmatch(
                r'/v1/workspaces/([0-9a-f]{32})/invites(?:/([0-9a-f]{32})(/revoke)?)?', path)
            if invite_path:
                return self.invite_dispatch(db, session, method, query, now, env, *invite_path.groups())
            member_path = re.fullmatch(
                r'/v1/workspaces/([0-9a-f]{32})/members(?:/([0-9a-f]{32})(/remove)?)?', path)
            if member_path:
                return self.member_dispatch(db, session, method, query, now, env, *member_path.groups())
            match = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})(/instances)?', path)
            if match:
                row = members.load(db, match[1], session['user_id'])
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

    def member_dispatch(self, db, session, method, query, now, env, workspace_id, target_id, removing):
        workspace = members.load(db, workspace_id, session['user_id'])
        if workspace is None:
            refuse(404, 'not_found', 'Workspace not found')
        actor = members.role_of(db, workspace, session['user_id'])
        if target_id is None and method == 'GET' and not query:
            return 200, {'items': members.listing(db, workspace)}, []
        if method != 'POST' or query:
            refuse(400, 'invalid', 'Invalid membership request')
        if target_id is None:
            return self.add_member(db, workspace, actor, session['user_id'], now, self.body(env, ['username', 'role']))
        target = db.execute(
            'SELECT u.id AS user_id, u.username, m.role AS role, m.created AS created '
            'FROM workspace_members m JOIN users u ON u.id=m.user_id '
            'WHERE m.workspace_id=? AND m.user_id=?',
            (workspace['id'], target_id),
        ).fetchone()
        if target is None:
            refuse(404, 'not_found', 'Member not found')
        if removing:
            self.body(env, [])
            return self.remove_member(db, workspace, actor, session['user_id'], target)
        return self.change_member_role(db, workspace, actor, target, self.body(env, ['role']))

    def add_member(self, db, workspace, actor, actor_id, now, body):
        if actor not in ('owner', 'admin'):
            refuse(403, 'forbidden', 'Not allowed to add members')
        username, role = body.get('username'), body.get('role')
        if (not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', username)
                or role not in members.ASSIGNABLE):
            refuse(400, 'invalid', 'Provide an existing username and a role of admin or member')
        username = username.lower()
        user = db.execute('SELECT id, username FROM users WHERE username=?', (username,)).fetchone()
        if user is None:
            refuse(404, 'not_found', 'Member could not be added')
        if user['id'] == workspace['owner_id']:
            refuse(409, 'conflict', 'The workspace owner is already a member')
        existing = db.execute(
            'SELECT u.id AS user_id, u.username, m.role AS role, m.created AS created '
            'FROM workspace_members m JOIN users u ON u.id=m.user_id '
            'WHERE m.workspace_id=? AND m.user_id=?',
            (workspace['id'], user['id']),
        ).fetchone()
        if existing:
            if existing['role'] != role:
                refuse(409, 'conflict', 'Member already exists with a different role')
            return 200, {'member': members.view(existing)}, []
        occupied = 1 + db.execute(
            'SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?', (workspace['id'],)
        ).fetchone()[0]
        if occupied >= self.config.max_members_per_workspace:
            refuse(429, 'quota', 'Workspace member capacity reached')
        if actor == 'admin' and role != 'member':
            refuse(403, 'forbidden', 'Admins can only add members')
        db.execute(
            'INSERT INTO workspace_members VALUES(?,?,?,?,?)',
            (workspace['id'], user['id'], role, now, actor_id),
        )
        row = db.execute(
            'SELECT u.id AS user_id, u.username, m.role AS role, m.created AS created '
            'FROM workspace_members m JOIN users u ON u.id=m.user_id '
            'WHERE m.workspace_id=? AND m.user_id=?',
            (workspace['id'], user['id']),
        ).fetchone()
        return 201, {'member': members.view(row)}, []

    def change_member_role(self, db, workspace, actor, target, body):
        if actor != 'owner':
            refuse(403, 'forbidden', 'Only the owner can change roles')
        role = body.get('role')
        if role not in members.ASSIGNABLE:
            refuse(400, 'invalid', 'Provide a role of admin or member')
        if target['role'] == role:
            return 200, {'member': members.view(target)}, []
        db.execute(
            'UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?',
            (role, workspace['id'], target['user_id']),
        )
        changed = {'user_id': target['user_id'], 'username': target['username'],
                   'role': role, 'created': target['created']}
        return 200, {'member': members.view(changed)}, []

    def remove_member(self, db, workspace, actor, actor_id, target):
        leaving = target['user_id'] == actor_id
        if leaving and actor == 'owner':
            refuse(409, 'conflict', 'The workspace owner cannot leave')
        if not leaving and not (actor == 'owner' or (actor == 'admin' and target['role'] == 'member')):
            refuse(403, 'forbidden', 'Not allowed to remove this member')
        db.execute(
            'DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?',
            (workspace['id'], target['user_id']),
        )
        return 200, {'removed': members.view(target)}, []

    def automation_dispatch(self, db, session, method, query, now, env, workspace_id, ticking, target_id, action):
        workspace = members.load(db, workspace_id, session['user_id'])
        if workspace is None:
            refuse(404, 'not_found', 'Workspace not found')
        actor = members.role_of(db, workspace, session['user_id'])
        if ticking:
            if method != 'POST' or query:
                refuse(400, 'invalid', 'Invalid automation request')
            if actor not in ('owner', 'admin'):
                refuse(403, 'forbidden', 'Not allowed to change automations')
            self.body(env, [])
            from .scheduler import Scheduler
            fired = Scheduler(self.store, self.automation_backend, clock=self.clock,
                              max_runs=self.config.max_runs_per_automation).tick_workspace(db, workspace['id'], now)
            return 200, {'items': fired}, []
        if target_id is None and method == 'GET' and not query:
            rows = db.execute(
                'SELECT * FROM automations WHERE workspace_id=? ORDER BY id', (workspace['id'],)
            ).fetchall()
            return 200, {'items': [automations.view(row) for row in rows]}, []
        if target_id is None and method == 'POST' and not query:
            return self.create_automation(db, workspace, actor, now, env)
        if target_id is None:
            refuse(400, 'invalid', 'Invalid automation request')
        row = db.execute(
            'SELECT * FROM automations WHERE id=? AND workspace_id=?', (target_id, workspace['id'])
        ).fetchone()
        if row is None:
            refuse(404, 'not_found', 'Automation not found')
        if action == 'runs':
            if method != 'GET':
                refuse(400, 'invalid', 'Invalid automation request')
            try:
                limit, cursor, _ = self.pagination(query)
            except APIError:
                raise
            except Exception:
                refuse(400, 'invalid', 'Invalid pagination parameters')
            rows = db.execute(
                'SELECT * FROM automation_runs WHERE automation_id=? AND id>? ORDER BY id LIMIT ?',
                (row['id'], cursor, limit + 1),
            ).fetchall()
            return 200, {'items': [automations.run_view(item) for item in rows[:limit]],
                         'cursor': rows[limit - 1]['id'] if len(rows) > limit else None}, []
        if method == 'GET' and action is None and not query:
            return 200, {'automation': automations.view(row)}, []
        if method != 'POST' or query:
            refuse(400, 'invalid', 'Invalid automation request')
        if action == 'remove':
            if actor not in ('owner', 'admin'):
                refuse(403, 'forbidden', 'Not allowed to change automations')
            self.body(env, [])
            db.execute('DELETE FROM automations WHERE id=?', (row['id'],))
            return 200, {'removed': automations.view(row)}, []
        return self.update_automation(db, workspace, actor, row, now, self.body(env, ['revision', 'changes']))

    def invite_dispatch(self, db, session, method, query, now, env, workspace_id, invite_id, revoking):
        workspace = members.load(db, workspace_id, session['user_id'])
        if workspace is None:
            refuse(404, 'not_found', 'Workspace not found')
        actor = members.role_of(db, workspace, session['user_id'])
        if actor not in ('owner', 'admin'):
            refuse(404, 'not_found', 'Workspace not found')
        if invite_id is None and method == 'GET' and not query:
            rows = db.execute(
                'SELECT * FROM workspace_invites WHERE workspace_id=? ORDER BY id', (workspace['id'],)
            ).fetchall()
            return 200, {'items': [invites.view(row) for row in rows]}, []
        if invite_id is None and method == 'POST' and not query:
            return self.create_invite(db, workspace, actor, session['user_id'], now, self.body(env, ['role', 'expires_in', 'max_uses']))
        if invite_id is None or method != 'POST' or query or not revoking:
            refuse(400, 'invalid', 'Invalid invite request')
        self.body(env, [])
        row = db.execute(
            'SELECT * FROM workspace_invites WHERE id=? AND workspace_id=?',
            (invite_id, workspace['id']),
        ).fetchone()
        if row is None:
            refuse(404, 'not_found', 'Invite not found')
        db.execute('UPDATE workspace_invites SET revoked=1 WHERE id=?', (row['id'],))
        row = dict(row)
        row['revoked'] = 1
        return 200, {'invite': invites.view(row)}, []

    def create_invite(self, db, workspace, actor, actor_id, now, body):
        role = body.get('role')
        expires_in = body.get('expires_in', 604800)
        max_uses = body.get('max_uses', 1)
        if role not in members.ASSIGNABLE:
            refuse(400, 'invalid', 'Provide a role of admin or member')
        if type(expires_in) is not int or not 60 <= expires_in <= 2592000:
            refuse(400, 'invalid', 'expires_in must be between 60 and 2592000 seconds')
        if type(max_uses) is not int or not 1 <= max_uses <= 50:
            refuse(400, 'invalid', 'max_uses must be between 1 and 50')
        if actor == 'admin' and role != 'member':
            refuse(403, 'forbidden', 'Admins can only invite members')
        if (db.execute('SELECT COUNT(*) FROM workspace_invites WHERE workspace_id=? AND revoked=0 AND expires>?',
                       (workspace['id'], now)).fetchone()[0] >= self.config.max_invites_per_workspace):
            refuse(429, 'quota', 'Invite capacity reached')
        token, invite_id = opaque(), uuid4().hex
        db.execute(
            'INSERT INTO workspace_invites VALUES(?,?,?,?,?,?,?,?,0,0)',
            (invite_id, workspace['id'], digest(token), role, now, now + expires_in, actor_id, max_uses),
        )
        row = db.execute('SELECT * FROM workspace_invites WHERE id=?', (invite_id,)).fetchone()
        return 201, {'invite': invites.view(row), 'token': token}, []

    def accept_invite(self, db, session, now, body):
        token = body.get('token')
        if not isinstance(token, str) or not invites.TOKEN.fullmatch(token):
            refuse(400, 'invalid', 'Provide an invite token')
        row = db.execute('SELECT * FROM workspace_invites WHERE token_hash=?', (digest(token),)).fetchone()
        if row is None or row['revoked'] == 1 or row['expires'] <= now:
            refuse(404, 'not_found', 'Invite not found')
        workspace = db.execute('SELECT * FROM workspaces WHERE id=?', (row['workspace_id'],)).fetchone()
        if workspace is None:
            refuse(404, 'not_found', 'Invite not found')
        user_id = session['user_id']
        if user_id == workspace['owner_id']:
            refuse(409, 'conflict', 'The workspace owner is already a member')
        existing = db.execute(
            'SELECT u.id AS user_id, u.username, m.role AS role, m.created AS created '
            'FROM workspace_members m JOIN users u ON u.id=m.user_id '
            'WHERE m.workspace_id=? AND m.user_id=?',
            (workspace['id'], user_id),
        ).fetchone()
        if existing:
            if existing['role'] != row['role']:
                refuse(409, 'conflict', 'Member already exists with a different role')
            return 200, {'workspace': self.workspace(workspace), 'member': members.view(existing)}, []
        if row['use_count'] >= row['max_uses']:
            refuse(404, 'not_found', 'Invite not found')
        occupied = 1 + db.execute(
            'SELECT COUNT(*) FROM workspace_members WHERE workspace_id=?', (workspace['id'],)
        ).fetchone()[0]
        if occupied >= self.config.max_members_per_workspace:
            refuse(429, 'quota', 'Workspace member capacity reached')
        username = db.execute('SELECT username FROM users WHERE id=?', (user_id,)).fetchone()['username']
        db.execute(
            'INSERT INTO workspace_members VALUES(?,?,?,?,?)',
            (workspace['id'], user_id, row['role'], now, row['created_by']),
        )
        db.execute(
            'UPDATE workspace_invites SET use_count=use_count+1 WHERE id=?', (row['id'],)
        )
        member = {'user_id': user_id, 'username': username, 'role': row['role'], 'created': now}
        return 201, {'workspace': self.workspace(workspace), 'member': members.view(member)}, []

    def resolve_participants(self, db, workspace, names):
        allowed = {workspace['owner_id']}
        for item in db.execute('SELECT user_id FROM workspace_members WHERE workspace_id=?', (workspace['id'],)):
            allowed.add(item['user_id'])
        resolved, seen = [], set()
        for raw in names:
            user = db.execute('SELECT id, username FROM users WHERE username=?', (raw.lower(),)).fetchone()
            if user is None or user['id'] not in allowed or user['id'] in seen:
                refuse(404, 'not_found', 'Participant not found')
            seen.add(user['id'])
            resolved.append({'user_id': user['id'], 'username': user['username']})
        return resolved

    def create_automation(self, db, workspace, actor, now, env):
        if actor not in ('owner', 'admin'):
            refuse(403, 'forbidden', 'Not allowed to change automations')
        body = self.body(env, ['title', 'prompt', 'template_id', 'schedule', 'participants'])
        title, prompt, template_id = body.get('title'), body.get('prompt'), body.get('template_id')
        schedule, names = body.get('schedule'), body.get('participants')
        if (not automations.valid_title(title) or not automations.valid_prompt(prompt)
                or template_id not in automations.TEMPLATES or not automations.valid_schedule(schedule)
                or not automations.valid_usernames(names)):
            refuse(400, 'invalid', 'Provide a title, prompt, custom template, schedule and participants')
        title = title.strip()
        schedule = automations.normalize_schedule(schedule)
        participants = self.resolve_participants(db, workspace, names)
        key = env.get('HTTP_IDEMPOTENCY_KEY', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', key):
            refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
        payload = json.dumps({'title': title, 'prompt': prompt, 'template_id': template_id,
                              'schedule': schedule, 'participants': [item['username'] for item in participants]},
                             sort_keys=True, separators=(',', ':'))
        key_hash, request_hash, title_hash = digest(key), digest(payload), digest(title.casefold())
        existing = db.execute(
            'SELECT * FROM automations WHERE workspace_id=? AND key_hash=?', (workspace['id'], key_hash)
        ).fetchone()
        if existing:
            if existing['request_hash'] != request_hash:
                refuse(409, 'conflict', 'Idempotency key was used for a different request')
            return 200, {'automation': automations.view(existing)}, []
        titled = db.execute(
            'SELECT id FROM automations WHERE workspace_id=? AND title_hash=?', (workspace['id'], title_hash)
        ).fetchone()
        if titled:
            refuse(409, 'conflict', 'An automation with this title already exists')
        if (db.execute('SELECT COUNT(*) FROM automations WHERE workspace_id=?', (workspace['id'],)).fetchone()[0]
                >= self.config.max_automations_per_workspace):
            refuse(429, 'quota', 'Automation capacity reached')
        aid = uuid4().hex
        db.execute(
            'INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,0,1,?,?,?,?)',
            (aid, workspace['id'], title, title_hash, prompt, template_id,
             json.dumps(schedule, sort_keys=True, separators=(',', ':')),
             json.dumps(participants, sort_keys=True, separators=(',', ':')),
             now, now, key_hash, request_hash),
        )
        row = db.execute('SELECT * FROM automations WHERE id=?', (aid,)).fetchone()
        return 201, {'automation': automations.view(row)}, []

    def update_automation(self, db, workspace, actor, row, now, body):
        if actor not in ('owner', 'admin'):
            refuse(403, 'forbidden', 'Not allowed to change automations')
        revision, changes = body.get('revision'), body.get('changes')
        if type(revision) is not int or not 1 <= revision <= 2 ** 31 or not isinstance(changes, dict) or not changes:
            refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
        allowed = {'title', 'prompt', 'schedule', 'participants', 'enabled'}
        if set(changes) - allowed:
            refuse(400, 'invalid', 'Unknown automation field')
        current = automations.view(row)
        if revision != current['revision']:
            raise RuntimeFault(409, 'conflict', 'Automation changed elsewhere; reload and retry', current)
        title = current['title']
        prompt = current['prompt']
        schedule = current['schedule']
        participants = current['participants']
        enabled = current['enabled']
        if 'title' in changes:
            if not automations.valid_title(changes['title']):
                refuse(400, 'invalid', 'Provide a title, prompt, custom template, schedule and participants')
            title = changes['title'].strip()
        if 'prompt' in changes:
            if not automations.valid_prompt(changes['prompt']):
                refuse(400, 'invalid', 'Provide a title, prompt, custom template, schedule and participants')
            prompt = changes['prompt']
        if 'schedule' in changes:
            if not automations.valid_schedule(changes['schedule']):
                refuse(400, 'invalid', 'Provide a title, prompt, custom template, schedule and participants')
            schedule = automations.normalize_schedule(changes['schedule'])
        if 'participants' in changes:
            if not automations.valid_usernames(changes['participants']):
                refuse(400, 'invalid', 'Provide a title, prompt, custom template, schedule and participants')
            participants = self.resolve_participants(db, workspace, changes['participants'])
        if 'enabled' in changes:
            if type(changes['enabled']) is not bool:
                refuse(400, 'invalid', 'enabled must be a boolean')
            enabled = changes['enabled']
        unchanged = (title == current['title'] and prompt == current['prompt'] and schedule == current['schedule']
                     and participants == current['participants'] and enabled == current['enabled'])
        if unchanged:
            return 200, {'automation': current}, []
        title_hash = digest(title.casefold())
        if title_hash != row['title_hash']:
            clash = db.execute(
                'SELECT id FROM automations WHERE workspace_id=? AND title_hash=? AND id!=?',
                (workspace['id'], title_hash, row['id']),
            ).fetchone()
            if clash:
                refuse(409, 'conflict', 'An automation with this title already exists')
        db.execute(
            'UPDATE automations SET title=?, title_hash=?, prompt=?, schedule=?, participants=?, '
            'enabled=?, revision=?, updated=? WHERE id=?',
            (title, title_hash, prompt,
             json.dumps(schedule, sort_keys=True, separators=(',', ':')),
             json.dumps(participants, sort_keys=True, separators=(',', ':')),
             1 if enabled else 0, current['revision'] + 1, now, row['id']),
        )
        updated = db.execute('SELECT * FROM automations WHERE id=?', (row['id'],)).fetchone()
        return 200, {'automation': automations.view(updated)}, []

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
        recovery = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/recover', path)
        if recovery and method == 'POST' and not query:
            body = self.body(env, ['expected_revision', 'operation_id', 'confirmation'])
            if set(body) != {'expected_revision', 'operation_id', 'confirmation'}:
                refuse(400, 'invalid', 'Recovery confirmation, revision and operation key required')
            return 200, runtime.recover(manager, recovery[1], **body), []
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
