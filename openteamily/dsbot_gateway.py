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
KEY_HEADER = 'HTTP_X_OT_GATEWAY_KEY'
PAGE_ROUTE = '/api/openteamily/page'

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


def authorize(db, *, cookie_header, session_cookie, method, uri, origin, fetch_site, fetch_mode,
              upgrade, public_origin, now, routes):
    """Return the internal headers for the edge, or raise GatewayError."""
    upstream_path = target_for(uri, routes)
    if upstream_path is None:
        raise GatewayError(404, 'not_gateway')
    method = (method or '').upper()
    if method not in ('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'):
        raise GatewayError(405, 'method')
    upgrade = (upgrade or '').lower()
    if upgrade not in ('', 'websocket'):
        raise GatewayError(400, 'upgrade')
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
    """WSGI endpoint for the edge's auth_request. Mount with :func:`mount`."""

    def __init__(self, store, public_origin, session_cookie, key, routes=None, clock=None):
        import time
        if not isinstance(key, str) or len(key) < 32:
            raise ValueError('Gateway key must be at least 32 characters')
        self.store, self.public_origin, self.session_cookie = store, public_origin, session_cookie
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
                public_origin=self.public_origin, now=int(self.clock()), routes=self.routes)

    def __call__(self, env, start_response):
        base = [('Cache-Control', 'no-store'), ('Content-Type', 'text/plain; charset=utf-8')]
        try:
            headers = self.decide(env)
            start_response('204 No Content', base + headers)
            return [b'']
        except GatewayError as error:
            reasons = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
                       405: 'Method Not Allowed', 503: 'Service Unavailable'}
            start_response(f'{error.status} {reasons.get(error.status, "Error")}',
                           base + [('X-OT-Gateway-Error', error.code)])
            return [error.code.encode()]
        except Exception:
            start_response('503 Service Unavailable', base + [('X-OT-Gateway-Error', 'unavailable')])
            return [b'unavailable']


def mount(app, gateway):
    """Compose the management app with the gateway endpoint; nothing else changes."""
    def composed(env, start_response):
        if gateway is not None and env.get('PATH_INFO') == ROUTE_PATH:
            return gateway(env, start_response)
        return app(env, start_response)
    return composed


NGINX_TEMPLATE = r'''# Generated by openteamily.dsbot_gateway.nginx_config. Edge for one public origin:
# platform paths go to the management app; DS-Bot paths go to the signed-in owner's
# own runtime after auth_request. Client X-OT-* headers and dsh-auth-* cookies never
# reach a runtime. Gateway key is read from an operator include, never this file.
map $http_upgrade $ot_connection_upgrade { default upgrade; '' close; }
server {
  listen __LISTEN__;
  server_name _;
  client_max_body_size 64m;
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
    proxy_set_header X-OT-Gateway-Key __KEY__;
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


def nginx_config(routes, platform, listen, key_include):
    """Render the edge config. ``key_include`` is the nginx literal/variable for the key."""
    if not re.fullmatch(r'[0-9A-Za-z.\-]+:\d{2,5}', platform) or not re.fullmatch(r'[0-9A-Za-z.:\[\]]+', str(listen)):
        raise ValueError('Invalid platform or listen address')
    locations = [f'  location = {routes["mount"]} {{ return 418; }}',
                 f'  location ^~ {routes["mount"]}/ {{ return 418; }}']
    for prefix in routes['passthrough']:
        locations.append(f'  location ^~ {prefix} {{ return 418; }}')
    for page in sorted(routes['moved_pages']):
        if page == 'home':
            locations.append('  location = / { return 418; }')
        locations.append(f'  location ^~ /{page}/ {{ return 418; }}')
    return (NGINX_TEMPLATE.replace('__LISTEN__', str(listen)).replace('__PLATFORM__', platform)
            .replace('__KEY__', key_include).replace('__DSBOT_LOCATIONS__', '\n'.join(locations)))
