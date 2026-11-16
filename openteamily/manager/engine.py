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
from .safety import LIMIT, ManagerError, require, trusted_path, read_private, write_new, replace_private, json_loads

IMAGE = re.compile(r'[a-z0-9][a-z0-9./:_-]{0,118}@sha256:[0-9a-f]{64}')
SECRET_TARGET = '/run/secrets/openteamily-model-api.json'
SECRET_BIND_SUFFIX = ':' + SECRET_TARGET + ':ro'
BOT_SOCIAL_TARGET = '/run/secrets/openteamily-bot-social.json'
BOT_SOCIAL_BIND_SUFFIX = ':' + BOT_SOCIAL_TARGET + ':ro'
RUNTIME_KEY_TARGET = '/run/secrets/openteamily-runtime-key.json'
RUNTIME_KEY_BIND_SUFFIX = ':' + RUNTIME_KEY_TARGET + ':ro'
ALLOWED_BIND_SUFFIXES = (SECRET_BIND_SUFFIX, BOT_SOCIAL_BIND_SUFFIX, RUNTIME_KEY_BIND_SUFFIX)
ALLOWED_BIND_TARGETS = (SECRET_TARGET, BOT_SOCIAL_TARGET, RUNTIME_KEY_TARGET)

def compose_bytes(document):
    return (json.dumps(document, sort_keys=True, separators=(',', ':')) + '\n').encode()


def volume_key(item):
    if not isinstance(item, dict):
        return None
    return (item.get('type'), item.get('source'), item.get('target'), bool(item.get('read_only')))


def added_secret_binds(stored, expected):
    """If stored is expected plus only missing allowlisted secret binds, return those binds.

    Anything else (removed mounts, changed image, unexpected keys) returns None so the
    exact-content check still fails closed. Named volume identity must stay the same.
    """
    if not isinstance(stored, dict) or not isinstance(expected, dict):
        return None
    if stored.get('volumes') != expected.get('volumes'):
        return None
    stored_svc, expected_svc = (stored.get('services') or {}).get('flybot'), (expected.get('services') or {}).get('flybot')
    if not isinstance(stored_svc, dict) or not isinstance(expected_svc, dict):
        return None
    stored_vols = stored_svc.get('volumes')
    expected_vols = expected_svc.get('volumes')
    if not isinstance(stored_vols, list) or not isinstance(expected_vols, list):
        return None
    stored_rest = {k: v for k, v in stored_svc.items() if k != 'volumes'}
    expected_rest = {k: v for k, v in expected_svc.items() if k != 'volumes'}
    if stored_rest != expected_rest:
        return None
    if {k: v for k, v in stored.items() if k != 'services'} != {k: v for k, v in expected.items() if k != 'services'}:
        return None
    stored_keys = [volume_key(item) for item in stored_vols]
    expected_keys = [volume_key(item) for item in expected_vols]
    if None in stored_keys or None in expected_keys:
        return None
    if any(key not in expected_keys for key in stored_keys):
        return None
    added = [item for item, key in zip(expected_vols, expected_keys) if key not in stored_keys]
    if not added:
        return []
    allowed = []
    for item in added:
        if item.get('type') != 'bind' or item.get('read_only') is not True:
            return None
        if item.get('target') not in ALLOWED_BIND_TARGETS or '..' in str(item.get('source') or ''):
            return None
        allowed.append(item)
    return allowed


def secret_relpath(iid):
    check_id(iid)
    return 'secrets/model-api-' + iid + '.json'


def bot_social_relpath(iid):
    check_id(iid)
    return 'secrets/bot-social-' + iid + '.json'


def runtime_key_relpath(iid):
    check_id(iid)
    return 'secrets/runtime-key-' + iid + '.json'


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
               'volumes': [
                   {'type': 'volume', 'source': 'data', 'target': '/data'},
                   {'type': 'bind', 'source': secret_relpath(iid), 'target': SECRET_TARGET, 'read_only': True},
                   {'type': 'bind', 'source': bot_social_relpath(iid), 'target': BOT_SOCIAL_TARGET, 'read_only': True},
                   {'type': 'bind', 'source': runtime_key_relpath(iid), 'target': RUNTIME_KEY_TARGET, 'read_only': True},
               ],
               'tmpfs': ['/tmp:rw,noexec,nosuid,size=67108864'],
               'logging': {'driver': 'local', 'options': {'max-size': '10m', 'max-file': '3'}}}
    if port is not None:
        service['ports'] = [{'target': 8080, 'published': str(port), 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]
    if health is not None:
        service['healthcheck'] = {'test': health, 'interval': '2s', 'timeout': '1s', 'retries': 3, 'start_period': '2s'}
    return {'services': {'flybot': service}, 'volumes': {'data': {'name': 'ot-' + iid}}}


class EngineFailure(ManagerError):
    """Bounded child diagnostics for internal classification, never error text/log output."""
    def __init__(self, returncode, stdout, stderr):
        super().__init__('engine_failure')
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class Registry:
    def __init__(self, config_path):
        self.config_path = str(config_path)
        self.root = Path(config_path).parent
        self.config = read_private(config_path)
        self.upgrades = {}
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
        secrets = self.root / 'secrets'
        if not secrets.exists():
            secrets.mkdir(mode=0o700)
        trusted_path(str(secrets), directory=True, private=True)

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
        stored = read_private(path)
        if stored != expected:
            added = added_secret_binds(stored, expected)
            require(added is not None, 'manifest_changed')
            # Rewrite only the frozen compose file. The named volume ot-<id> and
            # existing secret files are not removed or replaced here.
            replace_private(path, compose_bytes(expected))
            self.upgrades[iid] = [item['target'] for item in added]
        require(read_private(path) == expected, 'manifest_changed')
        if snapshot is not None:
            require(snapshot.get('id') == iid and snapshot.get('backend_mode') == 'compose' and
                    snapshot.get('image_ref') == entry['image'] and snapshot.get('volume_ref') == 'ot-' + iid, 'claim_registry_mismatch')
        return entry, path

    def preview_manifest(self, iid):
        """Describe a compose-file upgrade without writing. Never touches the volume."""
        check_id(iid)
        require(iid in self.config['instances'], 'instance_not_registered')
        expected = manifest(iid, self.config['instances'][iid])
        path = self.root / ('compose-' + iid + '.json')
        volume = 'ot-' + iid
        note = 'The named volume and existing secret files are left in place. A container created from the old file still needs a no-delete recreate so new binds attach.'
        if not path.exists() and not path.is_symlink():
            return {'status': 'missing', 'volume': volume, 'compose_file': str(path), 'note': note}
        stored = read_private(path)
        if stored == expected:
            return {'status': 'current', 'volume': volume, 'compose_file': str(path)}
        added = added_secret_binds(stored, expected)
        if added is None:
            return {'status': 'incompatible', 'reason': 'manifest_changed', 'volume': volume, 'compose_file': str(path),
                    'note': 'The frozen compose file does not match a known secret-bind addition. The volume was not modified. Recreate the instance only after reviewing the file; do not delete the ot-<id> volume.'}
        return {'status': 'upgradeable', 'volume': volume, 'compose_file': str(path),
                'added': [item['target'] for item in added], 'note': note}

    def apply_manifest_upgrade(self, iid):
        preview = self.preview_manifest(iid)
        if preview['status'] == 'current':
            return preview
        require(preview['status'] == 'upgradeable', preview.get('reason') or 'manifest_changed')
        self.entry(iid)
        preview['status'] = 'upgraded'
        preview['added'] = self.upgrades.get(iid, preview.get('added') or [])
        return preview


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
            stdout, stderr = out.decode('utf-8', 'replace'), err.decode('utf-8', 'replace')
            if code != 0:
                raise EngineFailure(code, stdout, stderr)
            return stdout, stderr
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

    def secret_path(self, iid):
        return self.registry.root / secret_relpath(iid)

    def bot_social_path(self, iid):
        return self.registry.root / bot_social_relpath(iid)

    def runtime_key_path(self, iid):
        return self.registry.root / runtime_key_relpath(iid)

    def install_secret(self, iid, payload):
        """Write the resolved model-API file (or empty). Never logs the key."""
        self.registry.entry(iid)
        path = self.secret_path(iid)
        if payload is None:
            raw = b''
        else:
            require(isinstance(payload, dict) and payload.get('api_key'), 'secret_payload')
            raw = (json.dumps(payload, separators=(',', ':')) + '\n').encode()
        replace_private(path, raw)
        return path

    def install_bot_social(self, iid, payload):
        """Write the resolved Bot Social URL file (or empty). Never accepts a token."""
        self.registry.entry(iid)
        path = self.bot_social_path(iid)
        if payload is None:
            raw = b''
        else:
            require(isinstance(payload, dict), 'bot_social_payload')
            require('token' not in payload and 'api_key' not in payload, 'bot_social_payload')
            require(isinstance(payload.get('server'), str) and payload['server'], 'bot_social_payload')
            allowed = {key: payload[key] for key in ('server', 'displayName', 'source') if key in payload}
            raw = (json.dumps(allowed, separators=(',', ':')) + '\n').encode()
        replace_private(path, raw)
        return path

    def install_runtime_key(self, iid, payload):
        """Write the instance runtime key file (or empty). Never logs the token."""
        self.registry.entry(iid)
        path = self.runtime_key_path(iid)
        if payload is None:
            raw = b''
        else:
            require(isinstance(payload, dict) and payload.get('token') and payload.get('origin') and payload.get('hostname'), 'runtime_key_payload')
            allowed = {key: payload[key] for key in ('origin', 'token', 'hostname')}
            raw = (json.dumps(allowed, separators=(',', ':')) + '\n').encode()
        replace_private(path, raw)
        return path

    def compose(self, iid, operation, *, heartbeat=lambda: None, tail=100):
        _, path = self.registry.entry(iid)
        require(type(tail) is int and 1 <= tail <= 100, 'log_tail')
        if operation in ('create', 'start', 'restart', 'up'):
            if not self.secret_path(iid).exists():
                self.install_secret(iid, None)
            if not self.bot_social_path(iid).exists():
                self.install_bot_social(iid, None)
            if not self.runtime_key_path(iid).exists():
                self.install_runtime_key(iid, None)
        # Exact argv grammar only; neither API nor registry can supply a verb/flags.
        commands = {
            'create': ['create', '--no-build', '--no-recreate', '--pull', 'never', 'flybot'],
            'start': ['up', '--detach', '--no-build', '--no-recreate', '--no-deps', '--pull', 'never', 'flybot'],
            'create-recreate': ['create', '--no-build', '--force-recreate', '--pull', 'never', 'flybot'],
            'start-recreate': ['up', '--detach', '--no-build', '--force-recreate', '--no-deps', '--pull', 'never', 'flybot'],
            'stop': ['stop', '--timeout', '10', 'flybot'],
            'recover': ['stop', '--timeout', '10', 'flybot'],
            'restart': ['restart', '--no-deps', '--timeout', '10', 'flybot'],
            'ps': ['ps', '--all', '--quiet', '--no-trunc', 'flybot'],
            'logs': ['logs', '--no-color', '--no-log-prefix', '--tail', str(tail), 'flybot']}
        require(operation in commands, 'operation_not_allowed')
        require('--force-recreate' not in commands[operation] or '-v' not in commands[operation], 'operation_not_allowed')
        return self.runner.run(['compose', '--env-file', '/dev/null', '-f', str(path), '--project-directory', str(self.registry.root),
                                '-p', 'ot-' + iid, *commands[operation]], heartbeat=heartbeat,
                               timeout=60 if operation in ('create', 'start', 'create-recreate', 'start-recreate', 'stop', 'restart', 'recover') else 10)

    def volume_check(self, iid, heartbeat=lambda: None):
        name = 'ot-' + check_id(iid)
        # Exact lookup, independent of Docker name-filter matching semantics.
        try:
            raw, stderr = self.runner.run(['volume', 'inspect', name], heartbeat=heartbeat)
        except EngineFailure as error:
            # Only one exact missing object is safe to treat as absent. Connectivity,
            # permission, driver, malformed/unknown or mixed errors must fail closed.
            # CLI/localization variants not listed here remain unsupported errors.
            missing = {f'Error response from daemon: get {name}: no such volume',
                       f'Error: No such volume: {name}'}
            require(error.returncode == 1 and error.stdout.strip() == '[]'
                    and error.stderr.strip() in missing, 'engine_failure')
            return
        require(not stderr.strip(), 'volume_inspect_warning')
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
            return {'present': False, 'stopped': True, 'healthy': False, 'process_ref': None, 'status': 'absent', 'health': 'unknown', 'needs_recreate': False, 'volume': 'ot-' + iid}
        raw, _ = self.runner.run(['inspect', '--type', 'container', ids[0]], heartbeat=heartbeat)
        data = json_loads(raw)
        require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict), 'inspect_shape')
        container = data[0]
        config, state, mounts = container.get('Config'), container.get('State'), container.get('Mounts')
        host = container.get('HostConfig')
        require(isinstance(config, dict) and isinstance(state, dict) and isinstance(mounts, list), 'inspect_shape')
        binds = host.get('Binds') or []
        require(isinstance(host, dict) and host.get('Privileged') is False and host.get('ReadonlyRootfs') is True and
                config.get('User') == '1000:1000' and host.get('CapDrop') == ['ALL'] and not host.get('CapAdd') and
                not host.get('Devices') and not host.get('PidMode') and
                host.get('IpcMode') in ('private', 'shareable') and host.get('NetworkMode') == 'ot-' + iid + '_default' and
                isinstance(host.get('SecurityOpt'), list) and any(x in host['SecurityOpt'] for x in ('no-new-privileges', 'no-new-privileges:true')), 'unsafe_container')
        def bind_suffix(bind):
            require(isinstance(bind, str) and '..' not in bind, 'unsafe_container')
            matched = [suffix for suffix in ALLOWED_BIND_SUFFIXES if bind.endswith(suffix)]
            require(len(matched) == 1, 'unsafe_container')
            return matched[0]
        require(isinstance(binds, list), 'unsafe_container')
        present_suffixes = sorted(bind_suffix(bind) for bind in binds)
        allowed = sorted(ALLOWED_BIND_SUFFIXES)
        require(all(suffix in allowed for suffix in present_suffixes), 'unsafe_container')
        needs_recreate = present_suffixes != allowed
        if not needs_recreate:
            require(len(binds) == len(ALLOWED_BIND_SUFFIXES), 'unsafe_container')
        expected_ports = {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(entry['publish_port'])}]} if entry['publish_port'] is not None else {}
        require((host.get('PortBindings') or {}) == expected_ports, 'unsafe_ports')
        labels = config.get('Labels')
        require(container.get('Id') == ids[0] and isinstance(labels, dict) and
                labels.get('com.docker.compose.project') == 'ot-' + iid and labels.get('com.docker.compose.service') == 'flybot' and
                config.get('Image') == entry['image'], 'container_owner')
        data_mounts = [m for m in mounts if isinstance(m, dict) and m.get('Destination') == '/data']
        require(len(data_mounts) == 1 and data_mounts[0].get('Type') == 'volume' and data_mounts[0].get('Name') == 'ot-' + iid and
                data_mounts[0].get('RW') is True, 'volume_scope')
        def secret_bind(target):
            found = [m for m in mounts if isinstance(m, dict) and m.get('Destination') == target]
            if not found:
                return None
            require(len(found) == 1 and found[0].get('Type') == 'bind' and found[0].get('RW') is False
                    and '..' not in str(found[0].get('Source') or ''), 'secret_mount')
            return found[0]
        present_secrets = [target for target in ALLOWED_BIND_TARGETS if secret_bind(target) is not None]
        if set(present_secrets) != set(ALLOWED_BIND_TARGETS):
            needs_recreate = True
        require(all(isinstance(m, dict) and (m.get('Destination') == '/data' or
                    m.get('Destination') in ALLOWED_BIND_TARGETS or
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
                'health': health.get('Status') if isinstance(health, dict) and health.get('Status') in ('healthy', 'unhealthy', 'starting') else 'unknown',
                'needs_recreate': needs_recreate, 'volume': 'ot-' + iid}

    def wait(self, iid, action, previous=None, heartbeat=lambda: None, timeout=30):
        deadline = time.monotonic() + timeout
        def bounded_heartbeat():
            heartbeat()
            require(time.monotonic() < deadline, 'readiness_timeout')
        while True:
            bounded_heartbeat()
            state = self.inspect(iid, bounded_heartbeat)
            if action in ('create', 'create-recreate', 'stop', 'recover'):
                if state['stopped'] and state.get('needs_recreate') is not True and (action in ('stop', 'recover') or state['present']):
                    return {'observed': 'stopped'}
            elif state['healthy'] and state.get('needs_recreate') is not True and (
                    action != 'restart' or state['process_ref'] != previous):
                return {'observed': 'running', 'process_ref': state['process_ref']}
            require(time.monotonic() < deadline, 'readiness_timeout')
            time.sleep(0.1)
