"""Read operator-owned local manager grants, never an HTTP-selected path.

The file contains credential digests only, not bearer secrets. No endpoint can
write this file or grant another instance. Reload requires an operator restart.
"""
import json
import os
from pathlib import Path
import stat

from .lifecycle import ManagerAuth, ManagerIdentity


def load_manager_auth(path):
    path = Path(path).absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Manager grant path must not use symbolic links')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('Manager grant directory must be private')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 131072:
            raise ValueError('Manager grant file must be private and bounded')
        raw = stream.read(131073)
    if len(raw) > 131072:
        raise ValueError('Manager grant file exceeds bound')
    from .app import object_only
    data = json.loads(raw, object_pairs_hook=object_only)
    if not isinstance(data, list) or len(data) > 100:
        raise ValueError('Invalid manager grant registry')
    identities = []
    for entry in data:
        if not isinstance(entry, dict) or set(entry) != {'id', 'credential_hash', 'instance_ids', 'backend_mode'}:
            raise ValueError('Invalid manager grant fields')
        ids = entry['instance_ids']
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
            raise ValueError('Invalid instance grants')
        identities.append(ManagerIdentity(entry['id'], entry['credential_hash'], frozenset(ids), entry['backend_mode']))
    return ManagerAuth(identities)
