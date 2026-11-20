"""Unit tests for the in-memory workspace export/import planning module.

No server, database, filesystem or live data is used. The tests exercise
deterministic serialization, manifest integrity, redaction, bounds and the
validation-only import plan.
"""
import copy
import hashlib
import json
import unittest
from unittest import mock

from openteamily import workspace_export


WORKSPACE = {'id': 'ws-0123456789abcdef', 'name': 'Demo workspace', 'created': 1700000000}
NOW = 1800000000


def canonical_checksum(manifest):
    body = {key: value for key, value in manifest.items() if key != 'checksum'}
    encoded = json.dumps(
        body, sort_keys=True, separators=(',', ':'), ensure_ascii=False
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def fixture_datasets():
    return {
        'agents': [
            {'id': 'agent-2', 'name': 'Zed'},
            {'id': 'agent-1', 'name': 'Alpha', 'settings': {'theme': 'light'}},
        ],
        'artifacts': [
            {'id': 'artifact-1', 'title': 'Notes', 'body': 'Plain artifact text.'},
        ],
        'memory': [],
        'automations': [
            {'id': 'automation-1', 'schedule': {'kind': 'daily', 'time': '09:00'}},
        ],
        'meetings': [
            {'id': 'meeting-1', 'summary': 'Weekly sync'},
        ],
    }


def resign(bundle):
    """Recompute the manifest checksum after an intentional structural edit."""
    bundle['manifest']['checksum'] = canonical_checksum(bundle['manifest'])
    return bundle


class WorkspaceExportTests(unittest.TestCase):
    def build(self, datasets=None, workspace=None, now=NOW):
        return workspace_export.build_bundle(
            workspace if workspace is not None else WORKSPACE,
            datasets if datasets is not None else fixture_datasets(),
            now,
        )

    def test_constants_and_deterministic_bundle(self):
        self.assertIsInstance(workspace_export.FORMAT_VERSION, int)
        self.assertGreater(workspace_export.MAX_BUNDLE_BYTES, 0)
        self.assertGreater(workspace_export.MAX_FILES, 0)
        self.assertGreater(workspace_export.MAX_FILE_BYTES, 0)
        self.assertIn('password', workspace_export.FORBIDDEN_KEYS)
        self.assertIn('token', workspace_export.FORBIDDEN_KEYS)

        first = self.build()
        second = self.build()
        reordered = self.build({
            name: [dict(reversed(list(record.items()))) for record in records]
            for name, records in reversed(list(fixture_datasets().items()))
        })
        self.assertEqual(first, second)
        self.assertEqual(first, reordered)
        self.assertEqual(first['manifest']['format'], workspace_export.FORMAT)
        self.assertEqual(first['manifest']['version'], workspace_export.FORMAT_VERSION)
        self.assertEqual(first['manifest']['workspace_id'], WORKSPACE['id'])
        self.assertEqual(first['manifest']['created'], NOW)
        self.assertEqual(first['manifest']['checksum'], canonical_checksum(first['manifest']))
        self.assertEqual(set(first['files']), {entry['path'] for entry in first['manifest']['files']})
        self.assertEqual(first['manifest']['counts']['files'], len(first['files']))
        self.assertEqual(first['manifest']['counts']['records'], 5)
        self.assertEqual(first['manifest']['counts']['datasets']['agents'], 2)
        self.assertEqual(workspace_export.validate_bundle(first), first['manifest'])

    def test_manifest_file_hashes_sizes_and_checksum_validate(self):
        bundle = self.build()
        manifest = workspace_export.validate_bundle(bundle)
        for entry in manifest['files']:
            data = bundle['files'][entry['path']]
            self.assertEqual(entry['bytes'], len(data))
            self.assertEqual(entry['sha256'], hashlib.sha256(data).hexdigest())

    def test_tampered_file_hash_size_and_checksum_are_rejected(self):
        bundle = self.build()

        changed = copy.deepcopy(bundle)
        path = sorted(changed['files'])[0]
        changed['files'][path] = changed['files'][path] + b' '
        with self.assertRaisesRegex(ValueError, 'sha256|bytes|size'):
            workspace_export.validate_bundle(changed)

        changed = copy.deepcopy(bundle)
        changed['manifest']['files'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'sha256'):
            workspace_export.validate_bundle(changed)

        changed = copy.deepcopy(bundle)
        changed['manifest']['files'][0]['bytes'] += 1
        with self.assertRaisesRegex(ValueError, 'bytes|size'):
            workspace_export.validate_bundle(changed)

        changed = copy.deepcopy(bundle)
        changed['manifest']['checksum'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'checksum'):
            workspace_export.validate_bundle(changed)

    def test_forbidden_keys_are_redacted_recursively_without_mutation(self):
        value = {
            'id': 'agent-1',
            'password': 'pw-secret',
            'passwd': 'passwd-secret',
            'secret': 'generic-secret',
            'token': 'token-secret',
            'key': 'key-secret',
            'api_key': 'api-key-secret',
            'authorization': 'Bearer auth-secret',
            'cookie': 'cookie-secret',
            'session': 'session-secret',
            'csrf': 'csrf-secret',
            'apiKey': 'camel-secret',
            'monkey': 'not-a-secret',
            'nested': {
                'items': [{'accessToken': 'nested-token'}, {'safe': 'visible'}],
                'deep': {'private_key': 'private-key-secret'},
            },
        }
        original = copy.deepcopy(value)
        redacted = workspace_export.redact(value)
        self.assertEqual(value, original)
        for name in ('password', 'passwd', 'secret', 'token', 'key', 'api_key',
                     'authorization', 'cookie', 'session', 'csrf', 'apiKey'):
            self.assertEqual(redacted[name], workspace_export.REDACTED, name)
        self.assertEqual(redacted['monkey'], 'not-a-secret')
        self.assertEqual(redacted['nested']['items'][0]['accessToken'], workspace_export.REDACTED)
        self.assertEqual(redacted['nested']['items'][1]['safe'], 'visible')
        self.assertEqual(redacted['nested']['deep']['private_key'], workspace_export.REDACTED)

        bundle = self.build({'agents': [value]})
        encoded = bundle['files']['datasets/agents.json'].decode('utf-8')
        self.assertIn(workspace_export.REDACTED, encoded)
        self.assertIn('not-a-secret', encoded)
        self.assertIn('visible', encoded)
        for secret in ('pw-secret', 'passwd-secret', 'generic-secret', 'token-secret',
                       'key-secret', 'api-key-secret', 'auth-secret', 'cookie-secret',
                       'session-secret', 'csrf-secret', 'camel-secret', 'nested-token',
                       'private-key-secret'):
            self.assertNotIn(secret, encoded)

    def test_no_secret_value_appears_in_the_whole_serialized_bundle(self):
        bundle = self.build({
            'agents': [{'id': 'a1', 'password': 'super-secret-password',
                        'nested': [{'refreshToken': 'super-secret-token'}]}],
            'memory': [{'id': 'm1', 'body': 'kept text'}],
        })
        serialized = b''.join(bundle['files'].values()) + json.dumps(
            bundle['manifest'], sort_keys=True, ensure_ascii=False
        ).encode('utf-8')
        self.assertNotIn(b'super-secret-password', serialized)
        self.assertNotIn(b'super-secret-token', serialized)
        self.assertIn(b'kept text', serialized)

    def test_unsafe_manifest_paths_are_rejected(self):
        bundle = self.build()
        bad_paths = (
            '../evil.json',
            '/absolute/evil.json',
            'datasets\\evil.json',
            'datasets/../../evil.json',
            'datasets/evil.json/..',
            'datasets/evil/../agents.json',
        )
        for bad in bad_paths:
            with self.subTest(path=bad):
                changed = copy.deepcopy(bundle)
                entry = changed['manifest']['files'][0]
                old = entry['path']
                data = changed['files'].pop(old)
                entry['path'] = bad
                changed['files'][bad] = data
                resign(changed)
                with self.assertRaisesRegex(ValueError, 'path|unsafe|absolute|backslash'):
                    workspace_export.validate_bundle(changed)

    def test_oversize_file_and_bundle_are_rejected(self):
        with mock.patch.object(workspace_export, 'MAX_FILE_BYTES', 32):
            with self.assertRaisesRegex(ValueError, 'file|exceed'):
                self.build({'agents': [{'id': 'a1', 'body': 'x' * 512}]})

        with mock.patch.object(workspace_export, 'MAX_FILE_BYTES', 4096), \
                mock.patch.object(workspace_export, 'MAX_BUNDLE_BYTES', 10):
            with self.assertRaisesRegex(ValueError, 'bundle|exceed'):
                self.build({'agents': [{'id': 'a1'}], 'memory': [{'id': 'm1'}]})

        bundle = self.build()
        with mock.patch.object(workspace_export, 'MAX_FILE_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'file|exceed'):
                workspace_export.validate_bundle(bundle)
        with mock.patch.object(workspace_export, 'MAX_BUNDLE_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'bundle|exceed'):
                workspace_export.validate_bundle(bundle)

    def test_too_many_files_are_rejected(self):
        with mock.patch.object(workspace_export, 'MAX_FILES', 2):
            with self.assertRaisesRegex(ValueError, 'too many|files'):
                self.build({'agents': [], 'memory': [], 'meetings': []})

        bundle = self.build()
        with mock.patch.object(workspace_export, 'MAX_FILES', 2):
            with self.assertRaisesRegex(ValueError, 'too many|files'):
                workspace_export.validate_bundle(bundle)

    def test_import_plan_is_deterministic_and_does_not_mutate(self):
        datasets = {
            'agents': [
                {'id': 'agent-2'},
                {'id': 'agent-1'},
                {'name': 'missing-id'},
            ],
            'artifacts': [{'id': 'artifact-1'}],
            'memory': [{'id': 'memory-1'}],
        }
        bundle = self.build(datasets)
        before = copy.deepcopy(bundle)
        existing = {'agents': {'agent-1'}, 'artifacts': ['artifact-1']}
        existing_before = copy.deepcopy(existing)
        plan = workspace_export.import_plan(bundle, existing)
        self.assertEqual(bundle, before)
        self.assertEqual(existing, existing_before)
        self.assertEqual(plan['creates'], [
            {'dataset': 'agents', 'id': 'agent-2'},
            {'dataset': 'memory', 'id': 'memory-1'},
        ])
        self.assertEqual(plan['conflicts'], [
            {'dataset': 'agents', 'id': 'agent-1', 'reason': 'id_exists'},
            {'dataset': 'artifacts', 'id': 'artifact-1', 'reason': 'id_exists'},
        ])
        self.assertEqual(plan['skipped'], [
            {'dataset': 'agents', 'id': None, 'reason': 'missing_id'},
        ])

        reordered = self.build({
            name: list(reversed(records)) for name, records in reversed(list(datasets.items()))
        })
        self.assertEqual(workspace_export.import_plan(reordered, existing), plan)

    def test_duplicate_dataset_ids_are_reported_as_skipped(self):
        bundle = self.build({
            'agents': [
                {'id': 'agent-1', 'name': 'first'},
                {'id': 'agent-1', 'name': 'second'},
                {'id': 'agent-2'},
            ],
        })
        plan = workspace_export.import_plan(bundle, {'agents': {'agent-2'}})
        self.assertEqual(plan['creates'], [{'dataset': 'agents', 'id': 'agent-1'}])
        self.assertEqual(plan['conflicts'], [
            {'dataset': 'agents', 'id': 'agent-2', 'reason': 'id_exists'},
        ])
        self.assertEqual(plan['skipped'], [
            {'dataset': 'agents', 'id': 'agent-1', 'reason': 'duplicate_id'},
        ])

    def test_invalid_format_version_and_counts_are_rejected(self):
        bundle = self.build()

        changed = copy.deepcopy(bundle)
        changed['manifest']['format'] = 'openteamily.other'
        with self.assertRaisesRegex(ValueError, 'format'):
            workspace_export.validate_bundle(changed)

        changed = copy.deepcopy(bundle)
        changed['manifest']['version'] = workspace_export.FORMAT_VERSION + 1
        with self.assertRaisesRegex(ValueError, 'version'):
            workspace_export.validate_bundle(changed)

        changed = copy.deepcopy(bundle)
        changed['manifest']['counts']['records'] += 1
        resign(changed)
        with self.assertRaisesRegex(ValueError, 'count'):
            workspace_export.validate_bundle(changed)

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            workspace_export.build_bundle({}, {}, NOW)
        with self.assertRaises(ValueError):
            workspace_export.build_bundle(WORKSPACE, [], NOW)
        with self.assertRaises(ValueError):
            workspace_export.build_bundle(WORKSPACE, {'../agents': []}, NOW)
        with self.assertRaises(ValueError):
            workspace_export.build_bundle(WORKSPACE, {'agents': [['not', 'a', 'mapping']]}, NOW)
        with self.assertRaises(ValueError):
            workspace_export.validate_bundle({'manifest': {}, 'files': {}})
        with self.assertRaises(ValueError):
            workspace_export.import_plan({'manifest': {}, 'files': {}})


if __name__ == '__main__':
    unittest.main()
