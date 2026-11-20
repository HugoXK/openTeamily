"""Platform gateway to each user's own DS-Bot (docs/DSBOT_PLUGIN_ARCHITECTURE.md §4).

The platform only registers, signs in, provisions and forwards. This module is the
forwarding decision: the edge (nginx ``auth_request``) asks ``GET /v1/platform/route``
for every request bound for a DS-Bot; the answer names the signed-in owner's *own*
runtime and the DSH session cookie for it, or refuses. No request field can name an
instance. The browser never receives a DSH token or cookie.

Nothing here executes user work. Credential-grade rows (``dsbot_upstreams.auth_cookie``)
are never returned by any listing API; protect database backups as credentials, as on
the FlyBot platform.
"""
import hmac
import ipaddress
import json
import re
from http.client import HTTPConnection
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import quote, urlsplit

from .security import digest

ROUTES_FILE = Path(__file__).with_name('dsbot_routes.json')
ROUTE_PATH = '/v1/platform/route'
UPSTREAM_PATH = re.compile(r'/v1/internal/instances/([0-9a-f]{32})/dsbot-upstream')
KEY_HEADER = 'HTTP_X_OT_GATEWAY_KEY'
PAGE_ROUTE = '/api/openteamily/page'
API_ROUTE = '/api/openteamily'
GATEWAY_PREFIX = '/v1/gateway/'
GATEWAY_TOKEN = re.compile(r'^ota_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$')
GATEWAY_INVOKE = re.compile(r'^/v1/gateway/agents/([0-9a-f]{32})/invocations$')
GATEWAY_STATUS = re.compile(r'^/v1/gateway/invocations/([0-9a-f]{32})$')
BEARER = re.compile(r'^Bearer ([A-Za-z0-9._~+/-]+=*)$')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS dsbot_upstreams (
 instance_id TEXT PRIMARY KEY, address TEXT NOT NULL, auth_cookie TEXT NOT NULL,
 updated INTEGER NOT NULL);
'''

SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
ADDRESS = re.compile(r'(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})')
COOKIE_NAME = re.compile(r'dsh-auth-[A-Za-z0-9._:%-]{1,200}')
PAGE_SEGMENT = re.compile(r'[a-z0-9][a-z0-9-]{0,40}')


class GatewayError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def load_routes(path=ROUTES_FILE):
    data = json.loads(Path(path).read_text('utf-8'))
    if data.get('version') != 1 or set(data) != {'version', 'mount', 'passthrough', 'moved_pages'}:
        raise ValueError('Unsupported DS-Bot route table')
    mount = data['mount']
    if not re.fullmatch(r'/[a-z]{1,16}', mount):
        raise ValueError('Invalid DS-Bot mount')
    passthrough = list(data['passthrough'])
    if any(not re.fullmatch(r'/[a-z]{1,16}/', p) for p in passthrough):
        raise ValueError('Invalid passthrough prefix')
    pages = list(data['moved_pages'])
    if any(not PAGE_SEGMENT.fullmatch(p) for p in pages) or len(set(pages)) != len(pages):
        raise ValueError('Invalid moved page list')
    return {'mount': mount, 'passthrough': tuple(passthrough), 'moved_pages': frozenset(pages)}


def ensure_schema(db):
    db.executescript(SCHEMA)


def target_for(uri, routes):
    """Map a browser request target to the DS-Bot path, or None for the platform."""
    if not isinstance(uri, str) or not uri.startswith('/') or len(uri) > 2048:
        return None
    parts = urlsplit(uri)
    path, query = parts.path, parts.query
    lowered = path.lower()
    if ('\\' in path or '//' in path or any(bad in lowered for bad in ('%2e', '%2f', '%5c', '%00'))
            or '/../' in path + '/' or '/./' in path + '/'):
        return None
    mount = routes['mount']
    if path == mount or path.startswith(mount + '/'):
        rest = path[len(mount):] or '/'
        return rest + ('?' + query if query else '')
    if any(path.startswith(prefix) for prefix in routes['passthrough']):
        return uri
    if path.startswith(GATEWAY_PREFIX) and not query:
        return path  # authorize() rewrites this to /api/openteamily after the key is parsed
    first = path.split('/')[1] if path != '/' else 'home'
    if first in routes['moved_pages'] and not query:
        return PAGE_ROUTE + '?path=' + quote(path, safe='')
    return None


def _cookies(header):
    jar = SimpleCookie()
    try:
        jar.load(header or '')
    except CookieError:
        raise GatewayError(400, 'invalid_cookie')
    return {name: morsel.value for name, morsel in jar.items()}


def _same_origin(method, origin, fetch_site, fetch_mode, upgrade, public_origin):
    if fetch_site == 'cross-site' and not (method in SAFE_METHODS and fetch_mode == 'navigate' and not upgrade):
        return False
    if method in SAFE_METHODS and not upgrade:
        return origin in ('', public_origin)
    return origin == public_origin and fetch_site in ('', 'same-origin', 'none')



def gateway_call(uri, authorization):
    """Map /v1/gateway/* + Bearer ota_<instance>_<secret> to a plugin call.

    The instance id in the key is used only to pick the owner's DS-Bot. The secret
    is passed in the JSON body so the DS-Bot can verify it; nginx still strips
    Authorization so the raw key never arrives as a header.
    """
    parts = urlsplit(uri)
    path = parts.path
    if parts.query or not path.startswith(GATEWAY_PREFIX):
        return None
    presented = authorization or ''
    match = BEARER.fullmatch(presented.strip())
    token = match[1] if match else ''
    parsed = GATEWAY_TOKEN.fullmatch(token)
    if not parsed:
        raise GatewayError(401, 'unauthorized')
    invoke = GATEWAY_INVOKE.fullmatch(path)
    status = GATEWAY_STATUS.fullmatch(path)
    if invoke:
        endpoint, extra = 'agent-api/invoke', {'agent_id': invoke[1]}
    elif status:
        endpoint, extra = 'agent-api/invocation', {'id': status[1]}
    else:
        raise GatewayError(404, 'not_found')
    return parsed[1], endpoint, extra, token


def _upstream_row(db, instance_id):
    row = db.execute(
        "SELECT i.id, u.address, u.auth_cookie FROM instances i JOIN dsbot_upstreams u ON u.instance_id=i.id "
        "WHERE i.id=? AND i.desired='running' AND i.observed='running' AND i.health='healthy' "
        "AND i.blocked=0 AND i.observed_revision=i.revision",
        (instance_id,)).fetchone()
    if row is None:
        raise GatewayError(503, 'dsbot_not_ready')
    return row


def authorize(db, *, cookie_header, session_cookie, method, uri, origin, fetch_site, fetch_mode,
              upgrade, public_origin, now, routes, authorization=''):
    """Return the internal headers for the edge, or raise GatewayError."""
    method = (method or '').upper()
    if method not in ('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'):
        raise GatewayError(405, 'method')
    upgrade = (upgrade or '').lower()
    if upgrade not in ('', 'websocket'):
        raise GatewayError(400, 'upgrade')
    call = gateway_call(uri, authorization)
    if call is not None:
        # External Agent API: no browser session, no Origin requirement. The key's
        # instance id picks the owner's DS-Bot; the secret is verified there.
        if upgrade:
            raise GatewayError(400, 'upgrade')
        instance_id, endpoint, extra, token = call
        row = _upstream_row(db, instance_id)
        address = validate_address(row[1])
        # Path includes the original /v1/gateway/... so the plugin can dispatch;
        # the token travels in a dedicated header (not Authorization; nginx strips that).
        return [
            ('X-OT-Upstream', address),
            ('X-OT-Upstream-Path', '/api/openteamily/gateway?path=' + quote(urlsplit(uri).path, safe='')),
            ('X-OT-Upstream-Origin', 'http://' + address),
            ('X-OT-Upstream-Cookie', row[2]),
            ('X-OT-Instance', row[0]),
            ('X-OT-Upstream-Token', token),
        ]
    upstream_path = target_for(uri, routes)
    if upstream_path is None:
        raise GatewayError(404, 'not_gateway')
    if not _same_origin(method, origin or '', (fetch_site or '').lower(), (fetch_mode or '').lower(),
                        bool(upgrade), public_origin):
        raise GatewayError(403, 'origin')
    token = _cookies(cookie_header).get(session_cookie, '')
    if not TOKEN.fullmatch(token):
        raise GatewayError(401, 'unauthorized')
    session = db.execute('SELECT user_id FROM sessions WHERE token_hash=? AND expires>?',
                         (digest(token), now)).fetchone()
    if session is None:
        raise GatewayError(401, 'unauthorized')
    row = db.execute(
        "SELECT i.id, u.address, u.auth_cookie FROM instances i JOIN dsbot_upstreams u ON u.instance_id=i.id "
        "WHERE i.owner_id=? AND i.desired='running' AND i.observed='running' AND i.health='healthy' "
        "AND i.blocked=0 AND i.observed_revision=i.revision ORDER BY i.created, i.id LIMIT 1",
        (session[0],)).fetchone()
    if row is None:
        raise GatewayError(503, 'dsbot_not_ready')
    address = validate_address(row[1])
    return [
        ('X-OT-Upstream', address),
        ('X-OT-Upstream-Path', upstream_path),
        ('X-OT-Upstream-Origin', 'http://' + address),
        ('X-OT-Upstream-Cookie', row[2]),
        ('X-OT-Instance', row[0]),
    ]


def validate_address(address):
    match = ADDRESS.fullmatch(address or '')
    if not match:
        raise ValueError('Upstream must be an IPv4 literal with a port')
    ip = ipaddress.IPv4Address(match[1])
    port = int(match[2])
    if not (ip.is_private and not ip.is_loopback and not ip.is_link_local) or not 1024 <= port <= 65535:
        raise ValueError('Upstream must be a private runtime address')
    return f'{ip}:{port}'


def record_upstream(db, instance_id, address, auth_cookie, now):
    """Manager side: remember where an instance listens and its DSH session cookie."""
    if not re.fullmatch(r'[0-9a-f]{32}', instance_id or ''):
        raise ValueError('Invalid instance id')
    name, _, value = (auth_cookie or '').partition('=')
    if not COOKIE_NAME.fullmatch(name) or not re.fullmatch(r'[A-Za-z0-9._~-]{16,2048}', value):
        raise ValueError('Invalid DSH session cookie')
    ensure_schema(db)
    db.execute('INSERT INTO dsbot_upstreams VALUES(?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET '
               'address=excluded.address, auth_cookie=excluded.auth_cookie, updated=excluded.updated',
               (instance_id, validate_address(address), auth_cookie, int(now)))


def exchange_launch_url(launch_url, address, timeout=10):
    """Trade a runtime's tokenized launch URL for its DSH session cookie, server side.

    The request goes to the runtime's private address with that address as Host, so the
    signed cookie is bound to the authority the edge later presents. Nothing is logged.
    """
    address = validate_address(address)
    parts = urlsplit(launch_url)
    if parts.scheme != 'http' or not parts.query.startswith('token=') or parts.path not in ('', '/'):
        raise ValueError('Unexpected DSH launch URL')
    host, port = address.split(':')
    conn = HTTPConnection(host, int(port), timeout=timeout)
    try:
        conn.request('GET', '/?' + parts.query, headers={'Host': address})
        response = conn.getresponse()
        response.read()
        found = []
        for header in response.headers.get_all('Set-Cookie') or []:
            pair = header.split(';', 1)[0].strip()
            if COOKIE_NAME.fullmatch(pair.partition('=')[0]):
                found.append(pair)
    finally:
        conn.close()
    if len(found) != 1:
        raise ValueError('DSH did not issue exactly one session cookie')
    return found[0]


class GatewayApp:
    """WSGI endpoint for the edge's auth_request. Mount with :func:`mount`.

    With ``manager_auth`` it also accepts the manager's upstream report
    ``POST /v1/internal/instances/<id>/dsbot-upstream`` (loopback manager bearer only,
    instance must be granted to that manager).
    """

    def __init__(self, store, public_origin, session_cookie, key, routes=None, clock=None, manager_auth=None):
        import time
        if not isinstance(key, str) or len(key) < 32:
            raise ValueError('Gateway key must be at least 32 characters')
        self.store, self.public_origin, self.session_cookie = store, public_origin, session_cookie
        self.manager_auth = manager_auth
        self.key_hash = digest(key)
        self.routes = routes or load_routes()
        self.clock = clock or time.time
        with store.transaction() as db:
            ensure_schema(db)

    def decide(self, env):
        presented = env.get(KEY_HEADER, '')
        if not presented or not hmac.compare_digest(digest(presented), self.key_hash):
            raise GatewayError(404, 'not_found')
        if env.get('REQUEST_METHOD') != 'GET':
            raise GatewayError(405, 'method')
        with self.store.connect() as db:
            return authorize(
                db, cookie_header=env.get('HTTP_COOKIE', ''), session_cookie=self.session_cookie,
                method=env.get('HTTP_X_ORIGINAL_METHOD', ''), uri=env.get('HTTP_X_ORIGINAL_URI', ''),
                origin=env.get('HTTP_ORIGIN', ''), fetch_site=env.get('HTTP_SEC_FETCH_SITE', ''),
                fetch_mode=env.get('HTTP_SEC_FETCH_MODE', ''), upgrade=env.get('HTTP_X_ORIGINAL_UPGRADE', ''),
                public_origin=self.public_origin, now=int(self.clock()), routes=self.routes,
                authorization=env.get('HTTP_AUTHORIZATION', ''))

    def record(self, env, iid):
        """Manager report: where instance ``iid`` listens and its DSH session cookie."""
        from .lifecycle import Lifecycle, RuntimeFault
        if self.manager_auth is None:
            raise GatewayError(404, 'not_found')
        if env.get('REQUEST_METHOD') != 'POST' or env.get('QUERY_STRING'):
            raise GatewayError(405, 'method')
        try:
            manager = self.manager_auth.authenticate(env)
        except RuntimeFault:
            raise GatewayError(401, 'manager_auth')
        try:
            length = int(env.get('CONTENT_LENGTH') or 0)
        except ValueError:
            raise GatewayError(400, 'invalid')
        if not 0 < length <= 8192:
            raise GatewayError(400, 'invalid')
        try:
            body = json.loads(env['wsgi.input'].read(length))
        except (ValueError, KeyError):
            raise GatewayError(400, 'invalid')
        if not isinstance(body, dict) or set(body) != {'address', 'auth_cookie', 'process_ref'}:
            raise GatewayError(400, 'invalid')
        if not isinstance(body['process_ref'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['process_ref']):
            raise GatewayError(400, 'invalid')
        with self.store.transaction() as db:
            row = db.execute('SELECT process_ref, observed FROM instances WHERE id=?', (iid,)).fetchone()
            if row is None or not Lifecycle.grants(db, manager, iid):
                raise GatewayError(403, 'not_granted')
            if row[1] != 'running' or row[0] != body['process_ref']:
                raise GatewayError(409, 'stale_process')
            try:
                record_upstream(db, iid, body['address'], body['auth_cookie'], self.clock())
            except ValueError:
                raise GatewayError(400, 'invalid')
        return [('Content-Type', 'application/json')], b'{"recorded":true}'

    def __call__(self, env, start_response):
        base = [('Cache-Control', 'no-store'), ('Content-Type', 'text/plain; charset=utf-8')]
        reported = UPSTREAM_PATH.fullmatch(env.get('PATH_INFO', ''))
        if reported:
            try:
                headers, body = self.record(env, reported[1])
                start_response('200 OK', [('Cache-Control', 'no-store')] + headers)
                return [body]
            except GatewayError as error:
                start_response(f'{error.status} Refused', [('Cache-Control', 'no-store'), ('Content-Type', 'application/json')])
                return [json.dumps({'error': {'code': error.code}}).encode()]
            except Exception:
                start_response('503 Service Unavailable', [('Content-Type', 'application/json')])
                return [b'{"error":{"code":"unavailable"}}']
        try:
            headers = self.decide(env)
            start_response('204 No Content', base + headers)
            return [b'']
        except GatewayError as error:
            reasons = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
                       405: 'Method Not Allowed', 409: 'Conflict', 503: 'Service Unavailable'}
            start_response(f'{error.status} {reasons.get(error.status, "Error")}',
                           base + [('X-OT-Gateway-Error', error.code)])
            return [error.code.encode()]
        except Exception:
            start_response('503 Service Unavailable', base + [('X-OT-Gateway-Error', 'unavailable')])
            return [b'unavailable']


def load_operator_key(path):
    """Read the operator gateway key file ``{"version":1,"key":"..."}`` (0600, owner-only)."""
    import os
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Gateway key file must be a private regular file')
        data = json.loads(os.read(fd, 4096))
    finally:
        os.close(fd)
    if not isinstance(data, dict) or set(data) != {'version', 'key'} or data['version'] != 1:
        raise ValueError('Unsupported gateway key file')
    key = data['key']
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('Invalid gateway key')
    return key


def wrap(app, store, config, key_file, manager_auth=None):
    """Deployment wiring for wsgi.py: ``application = dsbot_gateway.wrap(app, store, config, path, manager_auth)``.

    ``config`` is the management ``Config`` (public origin and session cookie name come
    from it). Without a key file the gateway stays off and ``app`` is returned as is.
    """
    if not key_file:
        return app
    gateway = GatewayApp(store, config.origin, config.cookie_names[0], load_operator_key(key_file),
                         manager_auth=manager_auth)
    return mount(app, gateway)


def mount(app, gateway):
    """Compose the management app with the gateway endpoint; nothing else changes."""
    def composed(env, start_response):
        if gateway is not None and (env.get('PATH_INFO') == ROUTE_PATH
                                    or UPSTREAM_PATH.fullmatch(env.get('PATH_INFO', ''))):
            return gateway(env, start_response)
        return app(env, start_response)
    return composed


NGINX_TEMPLATE = r'''# Generated by openteamily.dsbot_gateway.nginx_config. Edge for one public origin:
# platform paths go to the management app; DS-Bot paths go to the signed-in owner's
# own runtime after auth_request. Client X-OT-* headers and dsh-auth-* cookies never
# reach a runtime. In production the gateway key comes from an operator include.
map $http_upgrade $ot_connection_upgrade { default upgrade; '' close; }
server {
  listen __LISTEN__;
  server_name _;
  client_max_body_size 64m;
__KEY_SETTING__
  location = /v1/internal { return 404; }
  location ^~ /v1/internal/ { return 404; }
  location = /v1/admin { return 404; }
  location ^~ /v1/admin/ { return 404; }
  location = /v1/platform/route { return 404; }
  location = /_ot_authz {
    internal;
    proxy_pass http://__PLATFORM__/v1/platform/route;
    proxy_method GET;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $host;
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Original-Upgrade $http_upgrade;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-OT-Gateway-Key $ot_gateway_key;
  }
__DSBOT_LOCATIONS__
  location @ot_dsbot {
    auth_request /_ot_authz;
    auth_request_set $ot_upstream $upstream_http_x_ot_upstream;
    auth_request_set $ot_path $upstream_http_x_ot_upstream_path;
    auth_request_set $ot_origin $upstream_http_x_ot_upstream_origin;
    auth_request_set $ot_cookie $upstream_http_x_ot_upstream_cookie;
    proxy_pass http://$ot_upstream$ot_path;
    proxy_http_version 1.1;
    proxy_set_header Host $ot_upstream;
    proxy_set_header Origin $ot_origin;
    proxy_set_header Cookie $ot_cookie;
    proxy_set_header Authorization "";
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header X-OT-Upstream "";
    proxy_set_header X-OT-Upstream-Cookie "";
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $ot_connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_redirect off;
    proxy_hide_header Set-Cookie;
  }
  location ^~ /v1/gateway/ {
    auth_request /_ot_authz;
    auth_request_set $ot_upstream $upstream_http_x_ot_upstream;
    auth_request_set $ot_path $upstream_http_x_ot_upstream_path;
    auth_request_set $ot_origin $upstream_http_x_ot_upstream_origin;
    auth_request_set $ot_cookie $upstream_http_x_ot_upstream_cookie;
    auth_request_set $ot_token $upstream_http_x_ot_upstream_token;
    proxy_pass http://$ot_upstream$ot_path;
    proxy_http_version 1.1;
    proxy_set_header Host $ot_upstream;
    proxy_set_header Origin $ot_origin;
    proxy_set_header Cookie $ot_cookie;
    proxy_set_header Authorization "";
    proxy_set_header X-OT-Gateway-Token $ot_token;
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header X-OT-Upstream "";
    proxy_set_header X-OT-Upstream-Cookie "";
    proxy_set_header X-OT-Upstream-Token "";
    proxy_hide_header Set-Cookie;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_redirect off;
  }
  recursive_error_pages on;
  error_page 418 = @ot_dsbot;
  error_page 401 = @ot_login;
  location @ot_login { return 302 /register/; }
  location / {
    proxy_pass http://__PLATFORM__;
    proxy_set_header Host $host;
    proxy_set_header X-OT-Gateway-Key "";
  }
}
'''


def nginx_config(routes, platform, listen, key_include=None, key=None):
    """Render the edge config.

    Production passes ``key_include``: the absolute path of an operator-owned nginx
    include containing ``set $ot_gateway_key "<key>";`` so the key never sits in the
    rendered file. Tests may pass ``key`` directly.
    """
    if (key_include is None) == (key is None):
        raise ValueError('Pass exactly one of key_include or key')
    if key_include is not None:
        if not re.fullmatch(r'/[A-Za-z0-9/_.-]{1,200}', key_include) or '..' in key_include:
            raise ValueError('Invalid key include path')
        setting = f'  include {key_include};'
    else:
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
            raise ValueError('Invalid gateway key')
        setting = f'  set $ot_gateway_key "{key}";'
    if not re.fullmatch(r'[0-9A-Za-z.\-]+:\d{2,5}', platform) or not re.fullmatch(r'[0-9A-Za-z.:\[\]]+', str(listen)):
        raise ValueError('Invalid platform or listen address')
    locations = [f'  location = {routes["mount"]} {{ return 418; }}',
                 f'  location ^~ {routes["mount"]}/ {{ return 418; }}']
    for prefix in routes['passthrough']:
        locations.append(f'  location ^~ {prefix} {{ return 418; }}')
    for page in sorted(routes['moved_pages']):
        if page == 'home':
            locations.append('  location = / { return 418; }')
        locations.append(f'  location = /{page} {{ return 418; }}')
        locations.append(f'  location ^~ /{page}/ {{ return 418; }}')
    return (NGINX_TEMPLATE.replace('__LISTEN__', str(listen)).replace('__PLATFORM__', platform)
            .replace('__KEY_SETTING__', setting).replace('__DSBOT_LOCATIONS__', '\n'.join(locations)))


def main(argv=None):
    """Render the edge config: ``python -m openteamily.dsbot_gateway render ...``."""
    import argparse
    parser = argparse.ArgumentParser(prog='python -m openteamily.dsbot_gateway')
    sub = parser.add_subparsers(dest='command', required=True)
    render = sub.add_parser('render', help='Print the nginx edge config for the current route table')
    render.add_argument('--platform', required=True, help='host:port of the management app as seen by nginx')
    render.add_argument('--listen', required=True, help='nginx listen address, e.g. 127.0.0.1:8081')
    render.add_argument('--key-include', required=True, help='absolute path of the operator include setting $ot_gateway_key')
    render.add_argument('--routes', default=str(ROUTES_FILE))
    args = parser.parse_args(argv)
    print(nginx_config(load_routes(args.routes), args.platform, args.listen, key_include=args.key_include), end='')


if __name__ == '__main__':
    main()
