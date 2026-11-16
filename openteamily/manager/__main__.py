"""Operator CLI; no real HTTP/Docker unless config AND --execute explicitly enable it."""
import argparse
import json
import signal
from pathlib import Path
from urllib.parse import urlsplit

from ..security import digest, opaque
from .client import ManagerClient, check_id
from .engine import Registry, Runner, ComposeEngine, manifest
from .safety import ManagerError, require, trusted_path, write_new, instance_lock, redact
from .worker import ManagerWorker


def initialize(args):
    check_id(args.instance_id)
    # Validate before creating anything; no Docker or HTTP in init.
    entry = {'image': args.image, 'healthcheck': json.loads(args.healthcheck_json) if args.healthcheck_json else None, 'publish_port': args.publish_port}
    manifest(args.instance_id, entry)
    token = opaque()
    ManagerClient(args.base_url, args.manager_id, token, host_header=args.server_host)
    state = Path(args.state_dir)
    require(state.is_absolute() and not state.exists() and not state.is_symlink(), 'new_absolute_state_dir_required')
    trusted_path(str(state.parent), directory=True)
    state.mkdir(mode=0o700)
    config = {'version': 1, 'execution_enabled': False, 'base_url': args.base_url, 'server_host': args.server_host or urlsplit(args.base_url).netloc, 'manager_id': args.manager_id,
              'token': token, 'docker': args.docker, 'socket': args.socket, 'instances': {args.instance_id: entry}}
    write_new(state / 'manager.json', config)
    write_new(state / 'grants.json', [{'id': args.manager_id, 'credential_hash': digest(token),
              'instance_ids': [args.instance_id], 'backend_mode': 'compose'}])
    return {'status': 'initialized_disabled', 'config': str(state / 'manager.json'), 'server_grants': str(state / 'grants.json')}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Private operator JSON; never an HTTP field')
    parser.add_argument('--execute', action='store_true', help='Explicit local permission to send manager HTTP and invoke configured Docker')
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init', help='Create a new disabled configuration and digest-only server grants; no overwrite, network or Docker')
    init.add_argument('--state-dir', required=True)
    init.add_argument('--instance-id', required=True)
    init.add_argument('--image', required=True, help='Operator-provided image@sha256 digest; no pulls')
    init.add_argument('--base-url', default='http://127.0.0.1:8080')
    init.add_argument('--server-host', help='Exact configured management origin netloc, e.g. management.example.org; connection still numeric loopback')
    init.add_argument('--manager-id', default='local-compose')
    init.add_argument('--docker', default='/usr/bin/docker')
    init.add_argument('--socket', default='/run/docker.sock')
    init.add_argument('--healthcheck-json', help='Optional CMD argv JSON; otherwise image MUST provide a Docker HEALTHCHECK')
    init.add_argument('--publish-port', type=int, help='Optional loopback-only host port mapping to container TCP8080')
    for name in ('plan', 'inspect', 'logs', 'run-once', 'recover'):
        cmd = sub.add_parser(name)
        cmd.add_argument('--instance-id', required=True)
        if name == 'logs':
            cmd.add_argument('--tail', type=int, default=100)
        if name == 'recover':
            cmd.add_argument('--apply', action='store_true')
            cmd.add_argument('--confirm-no-active-executors', action='store_true')
            cmd.add_argument('--expected-revision', type=int)
            cmd.add_argument('--operation-id', help='Fresh 16..64 character operator key; reuse this key on uncertain HTTP retry')
    args = parser.parse_args(argv)
    try:
        if args.command == 'init':
            result = initialize(args)
        else:
            require(bool(args.config), 'config_required')
            iid = check_id(args.instance_id)
            registry = Registry(args.config)
            entry, path = registry.entry(iid)
            if args.command == 'plan':
                result = {'status': 'plan_only', 'instance_id': iid, 'compose_file': str(path), 'image': entry['image'], 'executed': False}
            else:
                require(args.execute and registry.config['execution_enabled'] is True, 'execution_disabled')
                cfg = registry.config
                client = ManagerClient(cfg['base_url'], cfg['manager_id'], cfg['token'], enabled=True, host_header=cfg['server_host'])
                snapshot = client.snapshot(iid)  # separate grant authorization even for logs/inspect
                registry.entry(iid, snapshot)
                engine = ComposeEngine(registry, Runner(registry, enabled=True))
                if args.command == 'run-once':
                    result = ManagerWorker(client, registry, engine).run_once(iid)
                else:
                    with instance_lock(registry.root, iid):
                        state = engine.inspect(iid)
                        if args.command == 'inspect':
                            result = {'instance': snapshot, 'engine': state}
                        elif args.command == 'logs':
                            stdout, stderr = engine.compose(iid, 'logs', tail=args.tail)
                            result = {'source': 'operator-compose-logs', 'instance_id': iid, 'tail': args.tail,
                                      'public_runtime_log_api': False, 'text': redact(stdout + '\n' + stderr, (cfg['token'],))}
                        else:
                            result = {'mode': 'dry-run', 'applied': False, 'instance': snapshot, 'engine': state,
                                      'note': 'Wait for all previous executors/daemon actions to finish; apply queues a fenced STOP, never resumes an interrupted action'}
                            if args.apply:
                                require(args.confirm_no_active_executors, 'explicit_quiescence_confirmation_required')
                                recovered = client.recover(iid, args.expected_revision, args.operation_id)
                                result = {'mode': 'applied', 'applied': True, 'result': recovered,
                                          'note': 'Recovery accepted or replayed; inspect current revision and run-once to confirm its fenced STOP before any new owner start'}
        print(json.dumps(result, sort_keys=True))
        return 1 if result.get('status') == 'uncertain' else 0
    except (ManagerError, OSError, ValueError, TypeError, KeyError) as error:
        # Never print exception repr/traceback, raw config, response or Docker output.
        print(json.dumps({'error': 'manager_operation_refused', 'reason': error.code if isinstance(error, ManagerError) else 'invalid_local_configuration', 'hint': 'Check private config, grants, enabled flags, stopped/quiesced recovery and operator documentation'}))
        return 2


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise ManagerError('operator_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
