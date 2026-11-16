"""Loopback-only development WSGI runner, not an internet-facing production server."""
import argparse
from wsgiref.simple_server import WSGIRequestHandler, make_server

from .app import App, Config
from .store import Store


class QuietHandler(WSGIRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        # Do not write URLs, queries, cookies or bodies to request logs.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--insecure-local', action='store_true')
    parser.add_argument('--open-registration', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    try:
        app = App(Store(args.data_dir), Config(origin=args.origin, insecure_local=args.insecure_local,
                                              allow_registration=args.open_registration))
    except (OSError, ValueError):
        parser.error('Cannot initialize private storage or origin configuration')
    # Never changes firewall/proxy rules or binds the development service to all interfaces.
    with make_server('127.0.0.1', args.port, app, handler_class=QuietHandler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
