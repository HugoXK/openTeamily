"""Platform → own DS-Bot gateway decisions (docs/DSBOT_PLUGIN_ARCHITECTURE.md §4)."""
import os
import secrets
import tempfile
import time
import unittest

from openteamily import dsbot_gateway as gw
from openteamily import lifecycle
from openteamily.security import digest
from openteamily.store import Store

ORIGIN = 'https://openteamily.example'
COOKIE = '__Host-ot_session'
KEY = 'k' * 40


def seed(store):
    """Two users, each with one healthy runtime; returns their session tokens."""
    now = int(time.time())
    tokens = {}
    with store.transaction() as db:
        db.executescript(lifecycle.SCHEMA)
        gw.ensure_schema(db)
        for n, (user, inst, addr) in enumerate((('a' * 32, '1' * 32, '172.30.0.11:8080'),
                                                ('b' * 32, '2' * 32, '172.30.0.12:8080'))):
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, f'user{n}', 'x', now))
            ws = f'{n}' * 32
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (ws, user, 'w', now, f'k{n}', f'r{n}'))
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,"
                       "operation_id,operation_type,observed,observed_revision,health,process_ref,error_code,blocked,create_key,created) "
                       "VALUES(?,?,?,'p','compose','img',?,'running',1,'op','create','running',1,'healthy',NULL,NULL,0,?,?)",
                       (inst, ws, user, f'vol{n}', f'c{n}', now))
            gw.record_upstream(db, inst, addr, f'dsh-auth-{addr}=' + 'S' * 20 + str(n), now)
            token = secrets.token_urlsafe(32)
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (digest(token), digest('c'), user, now + 3600, now))
            tokens[user] = token
    return tokens


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.chmod(self.tmp.name, 0o700)
        self.store = Store(os.path.join(self.tmp.name, 'd'))
        self.tokens = seed(self.store)
        self.app = gw.GatewayApp(self.store, ORIGIN, COOKIE, KEY)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, token=None, uri='/b/', method='GET', key=KEY, **headers):
        env = {'REQUEST_METHOD': 'GET', 'PATH_INFO': gw.ROUTE_PATH, 'HTTP_X_ORIGINAL_URI': uri,
               'HTTP_X_ORIGINAL_METHOD': method}
        if key is not None:
            env[gw.KEY_HEADER] = key
        if token is not None:
            env['HTTP_COOKIE'] = f'{COOKIE}={token}'
        env.update({'HTTP_' + k.upper(): v for k, v in headers.items()})
        seen = {}

        def start(status, hdrs):
            seen['status'] = int(status.split()[0])
            seen['headers'] = dict(hdrs)
        gw.mount(lambda e, s: s('200 OK', []) or [b'app'], self.app)(env, start)
        return seen['status'], seen['headers']

    def test_each_user_reaches_only_their_own_dsbot(self):
        a, b = self.tokens['a' * 32], self.tokens['b' * 32]
        status, headers = self.call(a)
        self.assertEqual(status, 204)
        self.assertEqual(headers['X-OT-Upstream'], '172.30.0.11:8080')
        self.assertEqual(headers['X-OT-Instance'], '1' * 32)
        self.assertEqual(headers['X-OT-Upstream-Path'], '/')
        status, headers = self.call(b, uri='/b/api/bot?x=1')
        self.assertEqual((status, headers['X-OT-Upstream']), (204, '172.30.0.12:8080'))
        self.assertEqual(headers['X-OT-Upstream-Path'], '/api/bot?x=1')

    def test_request_fields_cannot_select_another_instance(self):
        a = self.tokens['a' * 32]
        for extra in ({'x_ot_upstream': '172.30.0.12:8080'}, {'x_ot_instance': '2' * 32}):
            status, headers = self.call(a, uri='/b/?instance=' + '2' * 32, **extra)
            self.assertEqual(headers['X-OT-Upstream'], '172.30.0.11:8080')
        status, headers = self.call(None, HTTP_COOKIE=f'{COOKIE}=forged{"x" * 37}')
        self.assertEqual(status, 401)

    def test_unauthenticated_cross_site_and_unknown_key(self):
        a = self.tokens['a' * 32]
        self.assertEqual(self.call()[0], 401)
        self.assertEqual(self.call(a, key=None)[0], 404)
        self.assertEqual(self.call(a, key='wrong' * 10)[0], 404)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST', origin='https://evil.example')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/bot', method='POST', origin=ORIGIN)[0], 204)
        self.assertEqual(self.call(a, uri='/b/api/x', x_original_upgrade='websocket')[0], 403)
        self.assertEqual(self.call(a, uri='/b/api/x', x_original_upgrade='websocket', origin=ORIGIN)[0], 204)
        self.assertEqual(self.call(a, uri='/b/api/x', sec_fetch_site='cross-site', sec_fetch_mode='cors')[0], 403)
        self.assertEqual(self.call(a, uri='/b/', sec_fetch_site='cross-site', sec_fetch_mode='navigate')[0], 204)

    def test_platform_paths_and_tricks_are_not_forwarded(self):
        a = self.tokens['a' * 32]
        for uri in ('/v1/auth/session', '/register/', '/chat/', '/bx', '/b/%2e%2e/x', '/b/a%2fb', '/b/../v1/', '//b/'):
            self.assertEqual(self.call(a, uri=uri)[0], 404, uri)

    def test_unhealthy_or_blocked_runtime_is_not_routed(self):
        a = self.tokens['a' * 32]
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET health='unknown' WHERE id=?", ('1' * 32,))
        self.assertEqual(self.call(a)[0], 503)
        with self.store.transaction() as db:
            db.execute("UPDATE instances SET health='healthy', blocked=1 WHERE id=?", ('1' * 32,))
        self.assertEqual(self.call(a)[0], 503)

    def test_expired_session(self):
        with self.store.transaction() as db:
            db.execute('UPDATE sessions SET expires=0')
        self.assertEqual(self.call(self.tokens['a' * 32])[0], 401)

    def test_moved_pages_map_to_plugin_route(self):
        routes = dict(gw.load_routes(), moved_pages=frozenset({'chat', 'home'}))
        self.assertEqual(gw.target_for('/chat/', routes), '/api/openteamily/page?path=%2Fchat%2F')
        self.assertEqual(gw.target_for('/', routes), '/api/openteamily/page?path=%2F')
        self.assertIsNone(gw.target_for('/skills/', routes))

    def test_record_upstream_validation(self):
        with self.store.transaction() as db:
            for addr in ('127.0.0.1:8080', '8.8.8.8:8080', '169.254.169.254:80', 'host:8080', '10.0.0.1:80'):
                with self.assertRaises(ValueError, msg=addr):
                    gw.record_upstream(db, '1' * 32, addr, 'dsh-auth-x=' + 'a' * 20, 1)
            with self.assertRaises(ValueError):
                gw.record_upstream(db, '1' * 32, '10.0.0.1:8080', 'session=abc', 1)

    def test_other_paths_reach_the_management_app(self):
        seen = {}

        def app(env, start):
            start('200 OK', [])
            return [b'app']
        body = gw.mount(app, self.app)(
            {'PATH_INFO': '/v1/auth/session', 'REQUEST_METHOD': 'GET'}, lambda st, h: seen.setdefault('s', st))
        self.assertEqual((seen['s'], body), ('200 OK', [b'app']))

    def test_nginx_config_strips_client_credentials(self):
        conf = gw.nginx_config(gw.load_routes(), '127.0.0.1:8080', 8081, '$ot_gateway_key')
        for line in ('location = /v1/platform/route { return 404; }', 'auth_request /_ot_authz;',
                     'proxy_set_header Cookie $ot_cookie;', 'proxy_hide_header Set-Cookie;',
                     'proxy_set_header X-OT-Gateway-Key $ot_gateway_key;', 'location ^~ /b/ { return 418; }',
                     'location ^~ /api/ { return 418; }', 'proxy_set_header Upgrade $http_upgrade;'):
            self.assertIn(line, conf)


if __name__ == '__main__':
    unittest.main()
