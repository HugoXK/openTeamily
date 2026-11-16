"""Loopback-only development WSGI runner, not an internet-facing production server."""
import argparse
from wsgiref.simple_server import WSGIRequestHandler, make_server

from .app import App, Config
from .store import Store
from .lifecycle import Lifecycle, RuntimePolicy
from .operator_config import load_manager_auth
from .settings_page import SettingsPage


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
    parser.add_argument('--simulation', action='store_true', help='Enable explicitly labelled simulation lifecycle APIs; never runs Docker')
    parser.add_argument('--compose-image', help='Explicit Compose execution profile; operator-supplied image@sha256 digest, never pulled by Web')
    parser.add_argument('--manager-grants', help='Operator-owned private JSON file containing manager credential digests and explicit instance grants')
    args = parser.parse_args()
    if args.simulation and args.compose_image:
        parser.error('Choose simulation OR explicit Compose execution')
    if args.manager_grants and not (args.simulation or args.compose_image):
        parser.error('Manager grants require an explicit runtime profile')
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    try:
        store = Store(args.data_dir)
        policy = RuntimePolicy(image_ref=args.compose_image, profile='local-compose', backend_mode='compose') if args.compose_image else RuntimePolicy()
        lifecycle = Lifecycle(store, policy) if args.simulation or args.compose_image else None
        manager_auth = load_manager_auth(args.manager_grants) if args.manager_grants else None
        app = App(store, Config(origin=args.origin, insecure_local=args.insecure_local,
                                allow_registration=args.open_registration), lifecycle=lifecycle, manager_auth=manager_auth)
    except (OSError, ValueError, TypeError):
        parser.error('Cannot initialize private storage or origin configuration')
    app = SettingsPage(app)
    # Never changes firewall/proxy rules or binds the development service to all interfaces.
    with make_server('127.0.0.1', args.port, app, handler_class=QuietHandler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
