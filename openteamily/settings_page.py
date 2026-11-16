"""Same-origin settings page for the /v1/settings API (issue #4, slice 2).

Serves only an exact asset allowlist. API security stays in App; this wrapper
does not interpret /v1 routes. Self-written; no upstream or Teamily source.
"""
import os
from pathlib import Path
import stat
from urllib.parse import urlsplit


class SettingsPage:
    ASSETS = {
        '/settings': ('index.html', 'text/html; charset=utf-8'),
        '/settings/app.mjs': ('app.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.css': ('app.css', 'text/css; charset=utf-8'),
    }
    CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
           "img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")

    def __init__(self, api):
        self.api = api
        self.root = Path(__file__).absolute().parent / 'static' / 'settings'

    @property
    def config(self):
        return self.api.config

    @config.setter
    def config(self, value):
        self.api.config = value

    def _asset(self, name):
        # Never resolve user input into a filename. Reject symlinks, including the asset directory.
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
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

    def __call__(self, env, start_response):
        path = env.get('PATH_INFO', '')
        if path not in self.ASSETS:
            if path.startswith('/settings/') or path == '/settings':
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
            name, content_type = self.ASSETS[path]
            try:
                data = self._asset(name)
                status = '200 OK'
            except OSError:
                status, data = '503 Service Unavailable', b'UI asset unavailable'
                content_type = 'text/plain; charset=utf-8'
        headers += [('Content-Type', content_type), ('Content-Length', str(len(data)))]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]
