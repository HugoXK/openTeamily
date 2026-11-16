"""Canonical single-service Compose, strict argv and bounded, lease-aware subprocesses.

No Docker socket is mounted in the Web app. This module is operator CLI only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time

from .client import check_id
from .safety import LIMIT, ManagerError, require, trusted_path, read_private, write_new, json_loads

IMAGE = re.compile(r'[a-z0-9][a-z0-9./:_-]{0,118}@sha256:[0-9a-f]{64}')


def manifest(iid, entry):
    check_id(iid)
    require(isinstance(entry, dict) and set(entry) == {'image', 'healthcheck', 'publish_port'}, 'registry_fields')
    image = entry['image']
    require(isinstance(image, str) and IMAGE.fullmatch(image) and '..' not in image, 'pinned_image_required')
    port, health = entry['publish_port'], entry['healthcheck']
    require(port is None or (type(port) is int and 1024 <= port <= 65535), 'publish_port')
    require(health is None or (isinstance(health, list) and 2 <= len(health) <= 16 and health[0] == 'CMD' and
            all(isinstance(x, str) and 0 < len(x) <= 256 and not any(c in x for c in ('$','\x00','\n','\r')) for x in health) and
            re.fullmatch(r'[A-Za-z0-9/_.-]+', health[1]) and '..' not in health[1].split('/')), 'healthcheck')
    service = {'image': image, 'init': True, 'user': '1000:1000', 'read_only': True,
               'security_opt': ['no-new-privileges:true'], 'cap_drop': ['ALL'], 'pids_limit': 256,
               'mem_limit': '1g', 'cpus': 1, 'restart': 'no',
               'volumes': [{'type': 'volume', 'source': 'data', 'target': '/data'}],
               'tmpfs': ['/tmp:rw,noexec,nosuid,size=67108864'],
               'logging': {'driver': 'local', 'options': {'max-size': '10m', 'max-file': '3'}}}
    if port is not None:
        service['ports'] = [{'target': 8080, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]
    if health is not None:
        service['healthcheck'] = {'test': health, 'interval': '2s', 'timeout': '1s', 'retries': 3, 'start_period': '2s'}
    return {'services': {'flybot': service}, 'volumes': {'data': {'name': 'ot-' + iid}}}


class Registry:
    def __init__(self, config_path):
        self.config_path = str(config_path)
        self.root = Path(config_path).parent
        self.config = read_private(config_path)
        cfg = self.config
        require(isinstance(cfg, dict) and set(cfg) == {'version', 'execution_enabled', 'base_url', 'server_host', 'manager_id', 'token', 'docker', 'socket', 'instances'}, 'config_fields')
        require(type(cfg['version']) is int and cfg['version'] == 1 and type(cfg['execution_enabled']) is bool, 'config_version')
        require(isinstance(cfg['instances'], dict) and 1 <= len(cfg['instances']) <= 100, 'registry_limit')
        ports = []
        for iid, entry in cfg['instances'].items():
            manifest(iid, entry)
            if entry['publish_port'] is not None:
                ports.append(entry['publish_port'])
        require(len(set(ports)) == len(ports), 'duplicate_port')

    def entry(self, iid, snapshot=None):
        check_id(iid)
        # Freeze registry for this invocation; detect replacement or a permission change.
        require(read_private(self.config_path) == self.config, 'registry_changed')
        require(iid in self.config['instances'], 'instance_not_registered')
        entry = self.config['instances'][iid]
        expected = manifest(iid, entry)
        path = self.root / ('compose-' + iid + '.json')
        if not path.exists() and not path.is_symlink():
            write_new(path, expected)
        require(read_private(path) == expected, 'manifest_changed')
        if snapshot is not None:
            require(snapshot.get('id') == iid and snapshot.get('backend_mode') == 'compose' and
                    snapshot.get('image_ref') == entry['image'] and snapshot.get('volume_ref') == 'ot-' + iid, 'claim_registry_mismatch')
        return entry, path


class Runner:
    def __init__(self, registry, *, enabled=False):
        self.registry, self.enabled = registry, enabled
        self.home = registry.root / 'docker-home'
        if not self.home.exists():
            self.home.mkdir(mode=0o700)
        trusted_path(str(self.home), directory=True, private=True)

    def run(self, args, *, heartbeat=lambda: None, timeout=10):
        require(self.enabled is True and self.registry.config['execution_enabled'] is True, 'execution_disabled')
        require(type(timeout) in (int, float) and 0 < timeout <= 60, 'command_timeout')
        cfg = self.registry.config
        docker = trusted_path(cfg['docker'], executable=True)
        sock = Path(cfg['socket'])
        require(sock.is_absolute() and str(sock) == cfg['socket'], 'socket_path')
        trusted_path(str(sock.parent), directory=True)
        info = sock.lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid in (0, os.getuid()) and not info.st_mode & 0o002, 'socket_policy')
        # No inherited DOCKER_HOST/CONTEXT/COMPOSE_*/proxy/PYTHONPATH/LD_PRELOAD.
        env = {'PATH': os.defpath, 'HOME': str(self.home), 'DOCKER_CONFIG': str(self.home), 'LANG': 'C.UTF-8'}
        argv = [str(docker), '--host', 'unix://' + str(sock), '--config', str(self.home), *args]
        heartbeat()  # do not spawn anything after lost lease
        deadline = time.monotonic() + timeout
        out, err = bytearray(), bytearray()
        proc = subprocess.Popen(argv, cwd=self.registry.root, env=env, shell=False, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ, out)
                selector.register(proc.stderr, selectors.EVENT_READ, err)
                while selector.get_map() or proc.poll() is None:
                    require(time.monotonic() < deadline, 'command_timeout')
                    heartbeat()  # worker renews during command AND readiness polling
                    for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                        raw = os.read(key.fileobj.fileno(), 4096)
                        if not raw:
                            selector.unregister(key.fileobj)
                            continue
                        key.data.extend(raw)
                        require(len(out) + len(err) <= LIMIT, 'output_limit')
                code = proc.wait(timeout=1)
            heartbeat()
            require(code == 0, 'engine_failure')
            return out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')
        finally:
            # Kill only this subprocess group, never a container or any other job.
            # The daemon may continue an already submitted action: no automatic retry.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=2)
            proc.stdout.close()
            proc.stderr.close()


class ComposeEngine:
    def __init__(self, registry, runner):
        self.registry, self.runner = registry, runner

    def compose(self, iid, operation, *, heartbeat=lambda: None, tail=100):
        _, path = self.registry.entry(iid)
        require(type(tail) is int and 1 <= tail <= 100, 'log_tail')
        # Exact argv grammar only; neither API nor registry can supply a verb/flags.
        commands = {
            'create': ['create', '--no-build', '--no-recreate', '--pull', 'never', 'flybot'],
            'start': ['up', '--detach', '--no-build', '--no-recreate', '--no-deps', '--pull', 'never', 'flybot'],
            'stop': ['stop', '--timeout', '10', 'flybot'],
            'recover': ['stop', '--timeout', '10', 'flybot'],
            'restart': ['restart', '--no-deps', '--timeout', '10', 'flybot'],
            'ps': ['ps', '--all', '--quiet', '--no-trunc', 'flybot'],
            'logs': ['logs', '--no-color', '--no-log-prefix', '--tail', str(tail), 'flybot']}
        require(operation in commands, 'operation_not_allowed')
        return self.runner.run(['compose', '--env-file', '/dev/null', '-f', str(path), '--project-directory', str(self.registry.root),
                                '-p', 'ot-' + iid, *commands[operation]], heartbeat=heartbeat,
                               timeout=60 if operation in ('create', 'start', 'stop', 'restart', 'recover') else 10)

    def volume_check(self, iid, heartbeat=lambda: None):
        name = 'ot-' + check_id(iid)
        raw, _ = self.runner.run(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'], heartbeat=heartbeat)
        names = raw.split()
        require(names in ([], [name]), 'volume_scope')
        if names:
            raw, _ = self.runner.run(['volume', 'inspect', name], heartbeat=heartbeat)
            data = json_loads(raw)
            require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) and data[0].get('Name') == name, 'volume_scope')
            require(data[0].get('Driver') == 'local' and data[0].get('Scope') == 'local' and not data[0].get('Options'), 'volume_driver')
            labels = data[0].get('Labels')
            require(isinstance(labels, dict) and labels.get('com.docker.compose.project') == name and labels.get('com.docker.compose.volume') == 'data', 'volume_owner')

    def inspect(self, iid, heartbeat=lambda: None):
        entry, _ = self.registry.entry(iid)
        self.volume_check(iid, heartbeat)
        text, _ = self.compose(iid, 'ps', heartbeat=heartbeat)
        ids = text.split()
        require(len(ids) <= 1 and all(re.fullmatch('[0-9a-f]{64}', x) for x in ids), 'container_scope')
        if not ids:
            return {'present': False, 'stopped': True, 'healthy': False, 'process_ref': None, 'status': 'absent', 'health': 'unknown'}
        raw, _ = self.runner.run(['inspect', '--type', 'container', ids[0]], heartbeat=heartbeat)
        data = json_loads(raw)
        require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict), 'inspect_shape')
        container = data[0]
        config, state, mounts = container.get('Config'), container.get('State'), container.get('Mounts')
        host = container.get('HostConfig')
        require(isinstance(config, dict) and isinstance(state, dict) and isinstance(mounts, list), 'inspect_shape')
        require(isinstance(host, dict) and host.get('Privileged') is False and host.get('ReadonlyRootfs') is True and
                config.get('User') == '1000:1000' and host.get('CapDrop') == ['ALL'] and not host.get('CapAdd') and
                not host.get('Devices') and not host.get('Binds') and not host.get('PidMode') and
                host.get('IpcMode') in ('private', 'shareable') and host.get('NetworkMode') == 'ot-' + iid + '_default' and
                isinstance(host.get('SecurityOpt'), list) and any(x in host['SecurityOpt'] for x in ('no-new-privileges', 'no-new-privileges:true')), 'unsafe_container')
        expected_ports = {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(entry['publish_port'])}]} if entry['publish_port'] is not None else {}
        require((host.get('PortBindings') or {}) == expected_ports, 'unsafe_ports')
        labels = config.get('Labels')
        require(container.get('Id') == ids[0] and isinstance(labels, dict) and
                labels.get('com.docker.compose.project') == 'ot-' + iid and labels.get('com.docker.compose.service') == 'flybot' and
                config.get('Image') == entry['image'], 'container_owner')
        data_mounts = [m for m in mounts if isinstance(m, dict) and m.get('Destination') == '/data']
        require(len(data_mounts) == 1 and data_mounts[0].get('Type') == 'volume' and data_mounts[0].get('Name') == 'ot-' + iid and
                data_mounts[0].get('RW') is True, 'volume_scope')
        require(all(isinstance(m, dict) and (m.get('Destination') == '/data' or
                    (m.get('Type') == 'tmpfs' and m.get('Destination') == '/tmp')) for m in mounts), 'unexpected_mount')
        running = state.get('Running') is True and state.get('Status') == 'running' and not state.get('Paused') and not state.get('Restarting')
        started = state.get('StartedAt')
        ref = None
        if running:
            require(isinstance(started, str) and re.fullmatch(r'20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z', started), 'process_identity')
            ref = hashlib.sha256((ids[0] + '\n' + started).encode()).hexdigest()[:32]
        health = state.get('Health')
        return {'present': True, 'stopped': state.get('Running') is False and state.get('Status') in ('created', 'exited') and not state.get('Restarting'),
                'healthy': running and isinstance(health, dict) and health.get('Status') == 'healthy', 'process_ref': ref,
                'status': state.get('Status') if state.get('Status') in ('running', 'created', 'exited', 'dead', 'paused', 'restarting', 'removing') else 'unknown',
                'health': health.get('Status') if isinstance(health, dict) and health.get('Status') in ('healthy', 'unhealthy', 'starting') else 'unknown'}

    def wait(self, iid, action, previous=None, heartbeat=lambda: None, timeout=30):
        deadline = time.monotonic() + timeout
        def bounded_heartbeat():
            heartbeat()
            require(time.monotonic() < deadline, 'readiness_timeout')
        while True:
            bounded_heartbeat()
            state = self.inspect(iid, bounded_heartbeat)
            if action in ('create', 'stop', 'recover'):
                if state['stopped'] and (action != 'create' or state['present']):
                    return {'observed': 'stopped'}
            elif state['healthy'] and (action != 'restart' or state['process_ref'] != previous):
                return {'observed': 'running', 'process_ref': state['process_ref']}
            require(time.monotonic() < deadline, 'readiness_timeout')
            time.sleep(0.1)
