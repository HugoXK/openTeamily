"""In-memory workspace export bundles and validation-only import planning.

This module builds a deterministic, self-contained dictionary containing a
manifest and one UTF-8 JSON file per dataset. It performs recursive masking of
credential-like object keys, enforces file/bundle/count bounds, verifies
per-file SHA-256 hashes and a manifest checksum, and produces a dry-run import
plan from dataset ``id`` values.

Scope is deliberately narrow: the caller must authorize access, select the
workspace data, and persist or transmit the returned bytes. Nothing here reads
or writes the filesystem, opens a network connection, or imports live data.
The redaction is key-based and therefore cannot catch a secret embedded in an
unexpected field or a free-text body; it is not a general secret scanner. A
bundle is a portable exchange format, not a backup/restore guarantee, database
migration, or proof that an import will be semantically valid.
"""
import datetime
import hashlib
import json
import re

FORMAT = 'openteamily.workspace.export'
FORMAT_VERSION = 1
MAX_BUNDLE_BYTES = 4 * 1024 * 1024
MAX_FILES = 64
MAX_FILE_BYTES = 2 * 1024 * 1024
REDACTED = '[REDACTED]'
FORBIDDEN_KEYS = frozenset({
    'password', 'passwd', 'secret', 'token', 'key', 'authorization',
    'cookie', 'session', 'csrf', 'api_key',
})

_MAX_ID_CHARS = 128
_MAX_PATH_CHARS = 256
_MAX_DEPTH = 64
_DATASET_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}')
_DATASET_PATH = re.compile(r'datasets/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json')
_HEX64 = re.compile(r'[0-9a-f]{64}')
_CAMEL_WORD = re.compile(r'([a-z0-9])([A-Z])')
_KEY_SEPARATOR = re.compile(r'[^a-z0-9]+')


def _key_tokens(key):
    spaced = _CAMEL_WORD.sub(r'\1_\2', key)
    return [part for part in _KEY_SEPARATOR.split(spaced.lower()) if part]


def _is_forbidden_key(key):
    if not isinstance(key, str):
        return False
    tokens = _key_tokens(key)
    if any(token in FORBIDDEN_KEYS for token in tokens):
        return True
    return 'api_key' in '_'.join(tokens)


def redact(value, _depth=0):
    """Return a copy of *value* with credential-like keys masked recursively."""
    if _depth > _MAX_DEPTH:
        raise ValueError('value nesting exceeds the supported depth')
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            if _is_forbidden_key(key):
                cleaned[key] = REDACTED
            else:
                cleaned[key] = redact(item, _depth + 1)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [redact(item, _depth + 1) for item in value]
    return value


def _json_safe(value, depth=0):
    if depth > _MAX_DEPTH:
        raise ValueError('value nesting exceeds the supported depth')
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError('JSON object keys must be strings')
            _json_safe(item, depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            _json_safe(item, depth + 1)
        return
    if value is None or isinstance(value, (bool, int, str)):
        return
    if isinstance(value, float):
        if value != value or value in (float('inf'), float('-inf')):
            raise ValueError('non-finite numbers are not supported')
        return
    raise ValueError(f'unsupported JSON value type: {type(value).__name__}')


def _timestamp(now):
    if isinstance(now, bool):
        raise ValueError('now must be an integer timestamp or datetime')
    if isinstance(now, int):
        return now
    if isinstance(now, datetime.datetime):
        if now.tzinfo is None:
            now = now.replace(tzinfo=datetime.timezone.utc)
        return int(now.timestamp())
    raise ValueError('now must be an integer timestamp or datetime')


def _canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
        allow_nan=False,
    ).encode('utf-8')


def _manifest_checksum(manifest):
    body = {key: value for key, value in manifest.items() if key != 'checksum'}
    return hashlib.sha256(_canonical(body)).hexdigest()


def _validate_manifest_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError('unsafe path: path must be a non-empty string')
    if len(path) > _MAX_PATH_CHARS:
        raise ValueError('unsafe path: path is too long')
    if '\x00' in path:
        raise ValueError('unsafe path: path contains a null byte')
    if '\\' in path:
        raise ValueError('backslash paths are not allowed')
    if path.startswith('/') or re.match(r'^[A-Za-z]:', path):
        raise ValueError('absolute paths are not allowed')
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError(f'unsafe path: {path!r}')
    match = _DATASET_PATH.fullmatch(path)
    if match is None:
        raise ValueError(f'unsafe or invalid file path: {path!r}')
    return match.group(1)


def _reject_constant(value):
    raise ValueError(f'non-finite JSON number is not supported: {value}')


def _decode_datasets(manifest_files, files):
    datasets = {}
    for entry in manifest_files:
        name = _validate_manifest_path(entry['path'])
        try:
            rows = json.loads(
                files[entry['path']].decode('utf-8'),
                parse_constant=_reject_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f'dataset {name!r} is not valid UTF-8 JSON') from exc
        if not isinstance(rows, list):
            raise ValueError(f'dataset {name!r} must contain a JSON list')
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError(f'dataset {name!r} records must be JSON objects')
        datasets[name] = rows
    return datasets


def build_bundle(workspace, datasets, now):
    """Build a deterministic in-memory export bundle.

    ``workspace`` is a mapping with at least an ``id``; ``datasets`` maps safe
    dataset names to lists of JSON-object records. ``now`` is an integer
    timestamp (or a datetime, normalized to UTC seconds). The returned mapping
    is ``{'manifest': {...}, 'files': {path: bytes}}``. No input is mutated.
    """
    if not isinstance(workspace, dict):
        raise ValueError('workspace must be a mapping')
    workspace_id = workspace.get('id')
    if not isinstance(workspace_id, str) or not workspace_id.strip():
        raise ValueError('workspace id must be a non-empty string')
    if len(workspace_id) > _MAX_ID_CHARS:
        raise ValueError('workspace id is too long')
    created = _timestamp(now)

    if not isinstance(datasets, dict):
        raise ValueError('datasets must be a mapping')
    names = list(datasets)
    if any(not isinstance(name, str) for name in names):
        raise ValueError('dataset names must be strings')
    if len(names) > MAX_FILES:
        raise ValueError('too many files in bundle')
    for name in names:
        if _DATASET_NAME.fullmatch(name) is None:
            raise ValueError(f'invalid dataset name: {name!r}')

    files = {}
    counts = {}
    total_bytes = 0
    for name in sorted(names):
        rows = datasets[name]
        if not isinstance(rows, (list, tuple)):
            raise ValueError(f'dataset {name!r} must be a list of records')
        clean_rows = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError(f'dataset {name!r} records must be mappings')
            cleaned = redact(row)
            _json_safe(cleaned)
            clean_rows.append(cleaned)
        try:
            data = _canonical(clean_rows)
        except (TypeError, ValueError) as exc:
            raise ValueError(f'dataset {name!r} is not JSON serializable') from exc
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f'dataset file {name!r} exceeds MAX_FILE_BYTES')
        total_bytes += len(data)
        path = f'datasets/{name}.json'
        files[path] = data
        counts[name] = len(clean_rows)

    if total_bytes > MAX_BUNDLE_BYTES:
        raise ValueError('bundle exceeds MAX_BUNDLE_BYTES')

    manifest_files = [
        {
            'path': path,
            'sha256': hashlib.sha256(files[path]).hexdigest(),
            'bytes': len(files[path]),
        }
        for path in sorted(files)
    ]
    manifest = {
        'format': FORMAT,
        'version': FORMAT_VERSION,
        'workspace_id': workspace_id,
        'created': created,
        'files': manifest_files,
        'counts': {
            'datasets': {name: counts[name] for name in sorted(counts)},
            'files': len(files),
            'records': sum(counts.values()),
        },
    }
    manifest['checksum'] = _manifest_checksum(manifest)
    return {'manifest': manifest, 'files': files}


def validate_bundle(bundle):
    """Validate *bundle* and return its manifest, or raise ``ValueError``."""
    if not isinstance(bundle, dict):
        raise ValueError('bundle must be a mapping')
    manifest = bundle.get('manifest')
    files = bundle.get('files')
    if not isinstance(manifest, dict):
        raise ValueError('manifest must be a mapping')
    if not isinstance(files, dict):
        raise ValueError('files must be a mapping')

    required = ('format', 'version', 'workspace_id', 'created', 'files', 'counts', 'checksum')
    for key in required:
        if key not in manifest:
            raise ValueError(f'manifest is missing {key!r}')

    if manifest['format'] != FORMAT:
        raise ValueError('unsupported bundle format')
    version = manifest['version']
    if (not isinstance(version, int) or isinstance(version, bool)
            or version != FORMAT_VERSION):
        raise ValueError('unsupported bundle version')

    workspace_id = manifest['workspace_id']
    if not isinstance(workspace_id, str) or not workspace_id.strip():
        raise ValueError('manifest workspace_id must be a non-empty string')
    if len(workspace_id) > _MAX_ID_CHARS:
        raise ValueError('manifest workspace_id is too long')
    created = manifest['created']
    if not isinstance(created, int) or isinstance(created, bool):
        raise ValueError('manifest created must be an integer timestamp')

    manifest_files = manifest['files']
    if not isinstance(manifest_files, list):
        raise ValueError('manifest files must be a list')
    if len(manifest_files) > MAX_FILES:
        raise ValueError('too many files in manifest')

    manifest_paths = []
    seen_paths = set()
    for entry in manifest_files:
        if not isinstance(entry, dict):
            raise ValueError('manifest file entries must be mappings')
        for key in ('path', 'sha256', 'bytes'):
            if key not in entry:
                raise ValueError(f'manifest file entry is missing {key!r}')
        path = entry['path']
        _validate_manifest_path(path)
        if path in seen_paths:
            raise ValueError(f'duplicate manifest path: {path!r}')
        seen_paths.add(path)
        manifest_paths.append(path)

        digest = entry['sha256']
        if (not isinstance(digest, str) or len(digest) != 64
                or _HEX64.fullmatch(digest) is None):
            raise ValueError(f'invalid sha256 for {path!r}')
        size = entry['bytes']
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError(f'invalid byte size for {path!r}')
        if size > MAX_FILE_BYTES:
            raise ValueError(f'file {path!r} exceeds MAX_FILE_BYTES')

    if len(files) > MAX_FILES:
        raise ValueError('too many files in bundle')
    total_bytes = 0
    for path, data in files.items():
        _validate_manifest_path(path)
        if not isinstance(data, bytes):
            raise ValueError(f'file {path!r} must contain bytes')
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f'file {path!r} exceeds MAX_FILE_BYTES')
        total_bytes += len(data)
    if total_bytes > MAX_BUNDLE_BYTES:
        raise ValueError('bundle exceeds MAX_BUNDLE_BYTES')

    if set(manifest_paths) != set(files):
        raise ValueError('bundle files do not match the manifest')

    for entry in manifest_files:
        data = files[entry['path']]
        if len(data) != entry['bytes']:
            raise ValueError(f'file size mismatch for {entry["path"]!r}')
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError(f'sha256 mismatch for {entry["path"]!r}')

    datasets = _decode_datasets(manifest_files, files)

    counts = manifest['counts']
    if not isinstance(counts, dict):
        raise ValueError('manifest counts must be a mapping')
    if set(counts) != {'datasets', 'files', 'records'}:
        raise ValueError('manifest counts has an invalid shape')
    count_datasets = counts['datasets']
    if not isinstance(count_datasets, dict):
        raise ValueError('manifest dataset counts must be a mapping')
    if set(count_datasets) != set(datasets):
        raise ValueError('manifest counts do not match datasets')
    total_records = 0
    for name, rows in datasets.items():
        value = count_datasets[name]
        if (not isinstance(value, int) or isinstance(value, bool) or value < 0
                or value != len(rows)):
            raise ValueError(f'manifest counts do not match dataset {name!r}')
        total_records += len(rows)
    file_count = counts['files']
    if (not isinstance(file_count, int) or isinstance(file_count, bool)
            or file_count != len(manifest_files)):
        raise ValueError('manifest counts do not match files')
    if (not isinstance(counts['records'], int)
            or isinstance(counts['records'], bool)
            or counts['records'] != total_records):
        raise ValueError('manifest counts do not match records')

    checksum = manifest['checksum']
    if (not isinstance(checksum, str) or len(checksum) != 64
            or _HEX64.fullmatch(checksum) is None):
        raise ValueError('invalid manifest checksum')
    try:
        expected_checksum = _manifest_checksum(manifest)
    except (TypeError, ValueError) as exc:
        raise ValueError('manifest is not canonical JSON') from exc
    if checksum != expected_checksum:
        raise ValueError('manifest checksum mismatch')

    return manifest


def _existing_ids(existing_ids):
    if existing_ids is None:
        return {}, None
    if isinstance(existing_ids, dict):
        per_dataset = {}
        for name, values in existing_ids.items():
            if not isinstance(name, str):
                raise ValueError('existing_ids dataset names must be strings')
            if values is None:
                per_dataset[name] = set()
            elif isinstance(values, str):
                per_dataset[name] = {values}
            else:
                try:
                    per_dataset[name] = set(values)
                except TypeError as exc:
                    raise ValueError(
                        'existing_ids values must be iterable id collections'
                    ) from exc
        return per_dataset, None
    if isinstance(existing_ids, str):
        return {}, {existing_ids}
    try:
        return {}, set(existing_ids)
    except TypeError as exc:
        raise ValueError('existing_ids must be a mapping or iterable') from exc


def import_plan(bundle, existing_ids=None):
    """Return a deterministic dry-run plan without mutating the bundle.

    ``existing_ids`` may be a mapping of dataset name to existing id values, or
    a flat iterable of ids applied to every dataset. Records are scoped by
    dataset name. Missing/invalid ids are skipped; the first occurrence of a
    duplicate id is planned and later occurrences are reported as skipped.
    """
    manifest = validate_bundle(bundle)
    datasets = _decode_datasets(manifest['files'], bundle['files'])
    per_dataset, flat_ids = _existing_ids(existing_ids)

    creates, conflicts, skipped = [], [], []
    for name in sorted(datasets):
        seen = set()
        for row in datasets[name]:
            record_id = row.get('id')
            if (not isinstance(record_id, str) or not record_id
                    or len(record_id) > _MAX_ID_CHARS):
                skipped.append({
                    'dataset': name,
                    'id': record_id if isinstance(record_id, str) and record_id else None,
                    'reason': 'missing_id',
                })
                continue
            if record_id in seen:
                skipped.append({
                    'dataset': name, 'id': record_id, 'reason': 'duplicate_id',
                })
                continue
            seen.add(record_id)
            exists = record_id in per_dataset.get(name, ())
            if flat_ids is not None and record_id in flat_ids:
                exists = True
            if exists:
                conflicts.append({
                    'dataset': name, 'id': record_id, 'reason': 'id_exists',
                })
            else:
                creates.append({'dataset': name, 'id': record_id})

    creates.sort(key=lambda entry: (entry['dataset'], entry['id']))
    conflicts.sort(key=lambda entry: (entry['dataset'], entry['id']))
    skipped.sort(key=lambda entry: (
        entry['dataset'],
        entry['id'] if isinstance(entry['id'], str) else '',
        entry['reason'],
    ))
    return {'creates': creates, 'conflicts': conflicts, 'skipped': skipped}
