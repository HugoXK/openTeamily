#!/usr/bin/env python3
"""Verify the sharp-libvips notice/source-pointer offer.

Default mode is offline: it checks files under
runtime/third_party/sharp-libvips against pins.json. Pass --fetch to
download the npm tarball (docs only compared) and the libvips 8.18.7
source tarball into --out (default: a temporary directory). The .so
binary is not written into the git tree.

This is not a legal opinion and does not authorize publishing an image.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OFFER = ROOT / "runtime" / "third_party" / "sharp-libvips"
PINS = OFFER / "pins.json"

PINNED_FILES = {
    "PACKAGING-LICENSE": "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1",
    "THIRD-PARTY-NOTICES.md": "6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe",
    "npm-README.md": "b4fb1a9f5909cfd58edb4177c2028ce3033cf8651aef740a554c1dc58b3c5ee3",
    "LGPL-3.0.txt": "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
    "libvips-LGPL-2.1.txt": "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    raise SystemExit(1)


def check_offline() -> int:
    errors = 0
    pins = json.loads(PINS.read_text())
    if pins.get("public_redistributable_image") is not False:
        print("FAIL: offer must not claim a public redistributable image")
        errors += 1
    if pins.get("binary_vendored") is not False:
        print("FAIL: pins must record that the .so is not vendored")
        errors += 1
    for name, expected in PINNED_FILES.items():
        path = OFFER / name
        if not path.is_file():
            print(f"FAIL: missing {name}")
            errors += 1
            continue
        digest = sha256(path.read_bytes())
        if digest != expected:
            print(f"FAIL: {name} sha256 {digest} != {expected}")
            errors += 1
        else:
            print(f"OK {name}")
    if any(OFFER.rglob("*.so")) or any(p.suffix == ".xz" for p in OFFER.glob("*")):
        print("FAIL: binary or source tarball must not live in the offer tree")
        errors += 1
    versions = json.loads((OFFER / "versions.json").read_text())
    if versions.get("vips") != "8.18.7":
        print("FAIL: versions.json vips pin drifted", versions.get("vips"))
        errors += 1
    else:
        print("OK versions.json vips 8.18.7")
    return errors


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read()


def check_fetch(dest: Path) -> int:
    pins = json.loads(PINS.read_text())
    dest.mkdir(parents=True, exist_ok=True)
    errors = 0
    npm = pins["npm"]
    tarball = download(npm["tarball"])
    digest = sha256(tarball)
    if digest != npm["tarball_sha256"]:
        print("FAIL: npm tarball sha256", digest)
        errors += 1
    else:
        print("OK npm tarball", digest)
    with tarfile.open(fileobj=__import__("io").BytesIO(tarball), mode="r:gz") as tar:
        names = tar.getnames()
        if any(n.endswith(".so.8.18.7") or n.endswith(".so") for n in names):
            print("OK npm tarball contains the prebuilt libvips .so (not unpacked into git)")
        readme = tar.extractfile("package/README.md")
        if readme is None or sha256(readme.read()) != PINNED_FILES["npm-README.md"]:
            print("FAIL: npm README does not match vendored npm-README.md")
            errors += 1
        else:
            print("OK npm README matches offer")
        if any(name.endswith("LICENSE") or name.endswith("THIRD-PARTY-NOTICES.md") for name in names):
            print("NOTE: npm tarball unexpectedly contains a license file", names)
        else:
            print("OK npm tarball still has no LICENSE / THIRD-PARTY-NOTICES.md")
    vips = pins["libvips"]
    source = download(vips["source_tar_xz"])
    source_digest = sha256(source)
    if source_digest != vips["source_tar_xz_sha256"]:
        print("FAIL: libvips tarball sha256", source_digest)
        errors += 1
    else:
        out = dest / "vips-8.18.7.tar.xz"
        out.write_bytes(source)
        print("OK libvips source", source_digest, "wrote", out)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    errors = check_offline()
    if args.fetch:
        dest = args.out or Path(tempfile.mkdtemp(prefix="sharp-libvips-src-"))
        errors += check_fetch(dest)
    if errors:
        fail(f"{errors} error(s)")
    print("sharp-libvips offer checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
