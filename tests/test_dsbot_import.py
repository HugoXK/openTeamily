"""Manager job that writes per-user import bundles and the runtime seal key."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from openteamily.manager import dsbot_import
from openteamily.manager.safety import ManagerError


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.running = True
        self.consume = True
        self.files = set()

    def run(self, args, heartbeat=lambda: None, timeout=10):
        self.calls.append(args)
        if args[:3] == ['inspect', '-f', '{{.State.Running}}']:
            return ('true\n' if self.running else 'false\n'), ''
        if args[0] == 'exec' and 'test' in args and ('-f' in args or '-r' in args):
            marker = args[-1]
            if marker in self.files:
                return '', ''
            raise ManagerError('exec_failed')
        if args[0] == 'exec' and args[-2:] == ['-p', '/data/openteamily/import']:
            return '', ''
        if args[0] == 'cp':
            dest = args[-1].split(':', 1)[-1]
            self.files.add(dest)
            return '', ''
        if args[0] == 'exec' and 'chown' in args:
            return '', ''
        if args[0] == 'exec' and 'sh' in args:
            cmd = args[-1]
            # `touch /data/openteamily/import/.copied-<feature>-v1`
            for part in cmd.split():
                if part.startswith('/data/openteamily/import/.copied-'):
                    self.files.add(part)
                    if self.consume:
                        suffix = part.rsplit('/', 1)[-1][len('.copied-'):]
                        self.files.discard('/data/openteamily/import/' + suffix + '.bundle')
            return '', ''
        raise ManagerError('unexpected')


class FakeEngine:
    def __init__(self, root):
        self.registry = mock.Mock()
        self.registry.root = Path(root)
        self.registry.entry = mock.Mock()
        self.runner = FakeRunner()
        self._key = b'\x11' * 32
        self.seal = Path(root) / 'secrets' / 'seal-x.key'

    def seal_key_path(self, iid):
        return self.seal

    def install_seal_key(self, iid):
        self.seal.parent.mkdir(parents=True, exist_ok=True)
        self.seal.write_bytes(self._key)
        return self.seal, self._key


class FakeClient:
    def __init__(self):
        self.seen = None

    def dsbot_import(self, iid, seal_key_hex):
        self.seen = (iid, seal_key_hex)
        from openteamily.manager.dsbot_import import FEATURES
        return {'owner_imported': True, 'features': [
            {'name': name, 'bundle': {'format': 'openteamily-dsbot-import', 'feature': name, 'tables': {}, 'manifest': {}}}
            for name in FEATURES
        ]}


class ImportJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # GitHub runners and local macOS users are not uid 1000; ownership is
        # covered by the manager code, not this copy/retry unit test.
        if os.geteuid() != 1000:
            patcher = mock.patch('openteamily.manager.dsbot_import.os.fchown')
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_writes_bundles_once_and_reuses_the_seal_key(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertEqual(client.seen[1], '11' * 32)
        self.assertTrue(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertIn('automations-v1.bundle', first['features'])
        self.assertIn('agents-v1.bundle', first['features'])
        self.assertIn('artifacts-v1.bundle', first['features'])
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertFalse(any('.delivered-' in f for f in engine.runner.files))

    def test_rejected_import_is_retried_instead_of_suppressed_by_the_copy_marker(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.consume = False
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertTrue(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertTrue(any('.copied-settings-v1' in f for f in engine.runner.files))

        # The runtime rejected the bundle, so the files are still present. A copy
        # marker alone must not turn the next poll into already-imported.
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'delivered')
        self.assertTrue(any(c[0] == 'cp' for c in engine.runner.calls), 'rejected bundle is copied again')

        # Once the runtime consumes the bundles (verified import), the retry stops.
        engine.runner.files = {f for f in engine.runner.files if not f.endswith('.bundle')}
        engine.runner.calls.clear()
        settled = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(settled['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))

    def test_refuses_when_the_runtime_is_down(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.running = False
        with self.assertRaises(ManagerError) as caught:
            dsbot_import.deliver(engine, client, '1' * 32)
        self.assertEqual(caught.exception.code, 'instance_not_running')
        self.assertIsNone(client.seen)
