"""Manager job that writes per-user import bundles and the runtime seal key."""
import json
import hashlib
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
        self.unreadable = set()
        self.received = {}

    def run(self, args, heartbeat=lambda: None, timeout=10, stdin=None):
        self.calls.append(args)
        if args[:3] == ['inspect', '-f', '{{.State.Running}}']:
            return ('true\n' if self.running else 'false\n'), ''
        if 'check-copy' in args:
            bundle, marker, legacy = args[-3:]
            if bundle not in self.files and (marker in self.files or legacy in self.files):
                return '', ''
            raise ManagerError('exec_failed')
        if args[:4] == ['exec', '-i', '-u', '1000:1000'] and args[-4] == 'receive-bundle':
            filename, checksum, marker = args[-3:]
            raw = stdin.read()
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise ManagerError('exec_failed')
            dest = f'/data/openteamily/import/{filename}'
            self.files.add(dest)
            self.unreadable.discard(dest)
            self.received[filename] = json.loads(raw)
            self.files.add(f'/data/openteamily/import/{marker}')
            if self.consume:
                # A verified plugin import deletes the bundle and leaves the marker.
                self.files.discard(dest)
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

    def test_writes_bundles_once_and_reuses_the_seal_key(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertEqual(client.seen[1], '11' * 32)
        self.assertEqual(engine.runner.received['settings-v1.bundle']['feature'], 'settings')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertIn('automations-v1.bundle', first['features'])
        self.assertIn('agents-v1.bundle', first['features'])
        self.assertIn('artifacts-v1.bundle', first['features'])
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))

    def test_redelivers_unreadable_bundles_with_legacy_markers(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        dsbot_import.deliver(engine, client, iid)
        # Simulate an older manager's .delivered markers and an unreadable bundle.
        engine.runner.files = {f.replace('.copied-', '.delivered-') for f in engine.runner.files}
        bundle = '/data/openteamily/import/agents-v1.bundle'
        engine.runner.files.add(bundle)
        engine.runner.unreadable.add(bundle)
        engine.runner.calls.clear()
        retry = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(retry['features'], ['agents-v1.bundle'])
        self.assertNotIn(bundle, engine.runner.unreadable)
        self.assertEqual(dsbot_import.deliver(engine, client, iid)['status'], 'already-imported')

    def test_rejected_import_is_retried_instead_of_suppressed_by_the_copy_marker(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.consume = False
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertTrue(any('.copied-settings-v1' in f for f in engine.runner.files))

        # The plugin rejected the bundle, so it remains present. A copy marker
        # alone must not turn the next poll into already-imported.
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'delivered')
        self.assertTrue(any(args[-4] == 'receive-bundle' for args in engine.runner.calls),
                        'rejected bundle is delivered again')

        # Once the plugin consumes the bundles (verified import), retry stops.
        engine.runner.files = {f for f in engine.runner.files if not f.endswith('.bundle')}
        engine.runner.calls.clear()
        settled = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(settled['status'], 'already-imported')
        self.assertFalse(any(args[-4] == 'receive-bundle' for args in engine.runner.calls))

    def test_skips_a_historical_runtime_without_writing_a_bundle(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        with mock.patch.object(client, 'dsbot_import', side_effect=ManagerError('import_destination')):
            result = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(result['status'], 'import_skipped')
        self.assertEqual(engine.runner.received, {})

    def test_refuses_when_the_runtime_is_down(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.running = False
        with self.assertRaises(ManagerError) as caught:
            dsbot_import.deliver(engine, client, '1' * 32)
        self.assertEqual(caught.exception.code, 'instance_not_running')
        self.assertIsNone(client.seen)
