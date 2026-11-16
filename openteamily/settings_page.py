"""Same-origin management pages for the /v1 APIs (settings and automations).

Serves only an exact asset allowlist. API security stays in App; this wrapper
does not interpret /v1 routes. Self-written; no upstream or Teamily source.
"""
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit


class SettingsPage:
    ASSETS = {
        '/settings': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/app.mjs': ('settings', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.css': ('settings', 'app.css', 'text/css; charset=utf-8'),
        '/automations': ('automations', 'index.html', 'text/html; charset=utf-8'),
        '/automations/app.mjs': ('automations', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/automations/app.css': ('automations', 'app.css', 'text/css; charset=utf-8'),
        '/team': ('team', 'index.html', 'text/html; charset=utf-8'),
        '/team/app.mjs': ('team', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/team/app.css': ('team', 'app.css', 'text/css; charset=utf-8'),
        '/members': ('members', 'index.html', 'text/html; charset=utf-8'),
        '/members/app.mjs': ('members', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/members/app.css': ('members', 'app.css', 'text/css; charset=utf-8'),
        '/runtimes': ('runtimes', 'index.html', 'text/html; charset=utf-8'),
        '/runtimes/app.mjs': ('runtimes', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/runtimes/app.css': ('runtimes', 'app.css', 'text/css; charset=utf-8'),
        '/artifacts': ('artifacts', 'index.html', 'text/html; charset=utf-8'),
        '/artifacts/app.mjs': ('artifacts', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/app.css': ('artifacts', 'app.css', 'text/css; charset=utf-8'),
        '/install/flybot.sh': ('install', 'flybot.sh', 'text/plain; charset=utf-8'),
        '/install/flybot.ps1': ('install', 'flybot.ps1', 'text/plain; charset=utf-8'),
    }
    PREFIXES = ('/settings', '/automations', '/team', '/members', '/runtimes', '/artifacts', '/install')
    CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
           "img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; "
           "frame-ancestors 'none'; object-src 'none'")

    def __init__(self, api):
        self.api = api
        self.root = Path(__file__).absolute().parent / 'static'

    @property
    def config(self):
        return self.api.config

    @config.setter
    def config(self, value):
        self.api.config = value


    def _bundle(self, env, start_response):
        from .flybot_bundle import build
        headers = [('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', self.CSP), ('Referrer-Policy', 'no-referrer'),
                   ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')]
        origin = self.api.config.origin
        if (env.get('HTTP_HOST') != urlsplit(origin).netloc
                or env.get('HTTP_ORIGIN', origin) != origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            data = b'Same-origin request required'
            status, content_type = '403 Forbidden', 'text/plain; charset=utf-8'
        elif env.get('REQUEST_METHOD') not in ('GET', 'HEAD'):
            data = b'Use GET or HEAD'
            status, content_type = '405 Method Not Allowed', 'text/plain; charset=utf-8'
            headers.append(('Allow', 'GET, HEAD'))
        elif env.get('QUERY_STRING'):
            data = b'Queries not supported'
            status, content_type = '400 Bad Request', 'text/plain; charset=utf-8'
        else:
            try:
                data = build()
                status, content_type = '200 OK', 'application/octet-stream'
            except OSError:
                data = b'UI asset unavailable'
                status, content_type = '503 Service Unavailable', 'text/plain; charset=utf-8'
        headers += [('Content-Type', content_type), ('Content-Length', str(len(data))),
                    ('Content-Disposition', 'attachment; filename="flybot.pyz"')]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]

    def _asset(self, directory, name):
        # Never resolve user input into a filename. Reject symlinks, including the asset directory.
        folder = self.root / directory
        root_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
                    raise OSError('Invalid asset')
                with os.fdopen(fd, 'rb', closefd=False) as file:
                    data = file.read(262145)
                if len(data) > 262144:
                    raise OSError('Invalid asset')
                return data
            finally:
                os.close(fd)
        finally:
            os.close(root_fd)

    def _unknown_page(self, path):
        return any(path == prefix or path.startswith(prefix + '/') for prefix in self.PREFIXES)

    def __call__(self, env, start_response):
        path = env.get('PATH_INFO', '')
        if path == '/install/flybot.pyz':
            return self._bundle(env, start_response)
        if path not in self.ASSETS:
            if self._unknown_page(path):
                start_response('404 Not Found', [('Content-Type', 'text/plain; charset=utf-8'),
                                                 ('Cache-Control', 'no-store'),
                                                 ('Content-Length', '9')])
                return [] if env.get('REQUEST_METHOD') == 'HEAD' else [b'Not found']
            return self.api(env, start_response)
        headers = [('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', self.CSP), ('Referrer-Policy', 'no-referrer'),
                   ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')]
        content_type = 'text/plain; charset=utf-8'
        status, data = '404 Not Found', b'Not found'
        origin = self.api.config.origin
        if (env.get('HTTP_HOST') != urlsplit(origin).netloc
                or env.get('HTTP_ORIGIN', origin) != origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            status, data = '403 Forbidden', b'Same-origin request required'
        elif env.get('REQUEST_METHOD') not in ('GET', 'HEAD'):
            status, data = '405 Method Not Allowed', b'Use GET or HEAD'
            headers.append(('Allow', 'GET, HEAD'))
        elif env.get('QUERY_STRING'):
            status, data = '400 Bad Request', b'Queries not supported'
        else:
            directory, name, content_type = self.ASSETS[path]
            try:
                data = self._asset(directory, name)
                status = '200 OK'
            except OSError:
                status, data = '503 Service Unavailable', b'UI asset unavailable'
                content_type = 'text/plain; charset=utf-8'
        headers += [('Content-Type', content_type), ('Content-Length', str(len(data)))]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]
