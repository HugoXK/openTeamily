"""Build the explicit FlyBot zipapp from this tree. No network, no install."""
import io
from pathlib import Path
import zipfile
import zipapp

MAX = 262144


def build():
    source = (Path(__file__).resolve().parent / 'flybot.py').read_bytes()
    if b'teamily.com' in source.lower():
        raise OSError('Refusing to bundle unexpected URLs')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        # Shebang is added by zipapp after this archive is built.
        bundle.writestr('__main__.py', source)
    data = buffer.getvalue()
    # zipapp.create_archive adds a python shebang so `python flybot.pyz` works.
    output = io.BytesIO()
    output.write(b'#!/usr/bin/env python3\n')
    output.write(data)
    payload = output.getvalue()
    if not payload or len(payload) > MAX:
        raise OSError('FlyBot bundle is missing or too large')
    return payload
