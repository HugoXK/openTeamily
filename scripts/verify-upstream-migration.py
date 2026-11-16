#!/usr/bin/env python3
"""Verify OpenTeamily's imported FlyBot / Bot Social snapshots.

Checks, all offline unless --fetch is passed:

- every manifest file exists, matches sha256, and has the recorded git mode
- recorded LICENSE / NOTICE bytes match the 2026-11-16 audit pins
- excluded paths (project, timeline, logos, QR, banner, workflows, .claude)
  are absent
- no node_modules, build caches, env/credential files, private keys, or
  sqlite databases in the snapshot trees
- ORIGIN.md and component LICENSE files are present
- the trees are not claimed as root-MIT replacements (LICENSE files still
  hash to the upstream pins)

--fetch (optional) downloads the public GitHub tarballs for the pinned
FlyBot and Bot Social commits and re-checks included file hashes. It also
fetches DS-Bot commit 2b10c70 by SHA (falling back to equivalent commit
0f130e7) and compares the `ds-bot` tree 5834c00d. It is not required for CI.
"""
from __future__ import annotations

import argparse
import os
import re
import hashlib
import json
import stat
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

AUDIT_PINS = {
    "runtime/flybot/LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "runtime/flybot/NOTICE": "94f05bc42e635dee7082583c010dc13fb084b1ed9cdcfed6b9e5246c763027ca",
    "services/bot-social/LICENSE": "6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3",
}

# FlyBot's ds-bot.pin.json still names 2b10c70. After a DS-Bot history rewrite
# that commit is not on upstream main; 0f130e7 is the equivalent commit and
# both have ds-bot tree 5834c00d. Do not retarget to v0.3.6.
DS_BOT_EQUIVALENCE_PATH = "docs/upstream/ds-bot-pin-equivalence.json"
DS_BOT_PIN_PATH = "runtime/flybot/ds-bot.pin.json"
DS_BOT_PINNED_COMMIT = "2b10c70b614e969117b68ddc6fd14e68968272f2"
DS_BOT_TREE = "5834c00d9c21b972e4b32ad90489443da2a10324"
DS_BOT_EQUIVALENT_COMMIT = "0f130e7d134bf63e8988b2d53fd6846138ac3d73"
DS_BOT_REPO = "Fei2411/DS-Bot"
DS_BOT_FORBIDDEN_TARGETS = frozenset({
    "a66cc737cfb6c3d8a2597e748cded6cab1206dd3",  # upstream main / v0.3.6 at recording
    "v0.3.6",
})

FORBIDDEN_PATH_SUBSTRINGS = (
    "plugins/project/",
    "plugins/timeline/",
    "plugins/tree/",
    "plugins/workflow/",
    "docs/images/",
    "docs/assets/wechat-group.png",
    "flybot-control-plane",
    "/node_modules/",
    "node_modules/",
)

FORBIDDEN_EXACT_RELATIVE = {
    "runtime/flybot/Dockerfile",
    "runtime/flybot/compose.yaml",
    "runtime/flybot/core/scripts/install-doctor.mjs",
    "runtime/flybot/core/test/install-doctor.test.js",
    "services/bot-social/docs/index.html",
    "services/bot-social/scripts/install.sh",
}

FORBIDDEN_DIR_NAMES = {
    "node_modules",
    "__pycache__",
    ".state",
    "coverage",
    "dist",
}

FORBIDDEN_FILE_NAMES = {
    ".env",
    ".credentials",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
}

FORBIDDEN_SUFFIXES = {
    ".sqlite3",
    ".sqlite",
    ".pyc",
}

PRIVATE_KEY_MARKERS = (
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN PRIVATE KEY-----",
)

# Real-looking GitHub tokens, not redaction regexes like ghp_[A-Za-z0-9] or
# documented fixtures such as ghp_testvalue_123.
GITHUB_TOKEN_RE = re.compile(rb"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")
GITHUB_PAT_RE = re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{20,}\b")
TOKEN_ALLOW_HINTS = (b"test", b"example", b"fake", b"placeholder", b"xxx", b"sample")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def repo_root() -> Path:
    here = Path(__file__).resolve()
    return here.parent.parent


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def iter_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            yield path


def check_pins(root: Path, errors: list[str]) -> None:
    for rel, expected in AUDIT_PINS.items():
        path = root / rel
        if not path.is_file():
            errors.append(f"missing binding license file: {rel}")
            continue
        actual = sha256_file(path)
        if actual != expected:
            errors.append(f"{rel} sha256 {actual} != audit pin {expected}")


def check_manifest_files(root: Path, dest: str, files: dict, errors: list[str]) -> None:
    base = root / dest
    overlay = {"ORIGIN.md", "OPENTEAMILY.md"}
    for rel, meta in files.items():
        path = base / rel
        if not path.is_file():
            errors.append(f"missing imported file: {dest}/{rel}")
            continue
        actual = sha256_file(path)
        if actual != meta["sha256"]:
            errors.append(f"hash mismatch {dest}/{rel}: {actual} != {meta['sha256']}")
        if meta.get("bytes") is not None and path.stat().st_size != meta["bytes"]:
            errors.append(f"size mismatch {dest}/{rel}")
        mode = meta.get("mode")
        if mode == "100755":
            if not (path.stat().st_mode & stat.S_IXUSR):
                errors.append(f"expected executable bit: {dest}/{rel}")
        elif mode == "100644":
            if path.stat().st_mode & stat.S_IXUSR:
                errors.append(f"unexpected executable bit: {dest}/{rel}")
    extra = []
    for path in iter_files(base):
        rel = path.relative_to(base).as_posix()
        if rel in overlay:
            continue
        if rel not in files:
            extra.append(rel)
    if extra:
        preview = ", ".join(extra[:20])
        more = "" if len(extra) <= 20 else f" (+{len(extra) - 20} more)"
        errors.append(f"unexpected files under {dest}/: {preview}{more}")


def check_exclusions(root: Path, manifest: dict, errors: list[str]) -> None:
    for component in manifest["components"].values():
        dest = root / component["destination"]
        for rel in component["excluded_paths"]:
            path = dest / rel
            if path.exists():
                errors.append(f"excluded path present: {component['destination']}/{rel}")
    for dest in ("runtime/flybot", "services/bot-social"):
        base = root / dest
        if not base.exists():
            errors.append(f"missing snapshot directory: {dest}")
            continue
        for path in base.rglob("*"):
            rel = path.relative_to(root).as_posix()
            marker = rel + ("/" if path.is_dir() else "")
            if rel in FORBIDDEN_EXACT_RELATIVE:
                errors.append(f"forbidden path present: {rel}")
                continue
            if path.is_dir() and rel in {
                "runtime/flybot/ds-bot",
                "runtime/flybot/patches",
                "runtime/flybot/plugins/project",
                "runtime/flybot/plugins/timeline",
                "runtime/flybot/plugins/tree",
                "runtime/flybot/plugins/workflow",
            }:
                errors.append(f"forbidden directory present: {rel}")
            for needle in FORBIDDEN_PATH_SUBSTRINGS:
                if needle in marker:
                    errors.append(f"forbidden path present: {rel}")
                    break


def check_clean_tree(root: Path, errors: list[str]) -> None:
    for dest in ("runtime/flybot", "services/bot-social", "docs/upstream"):
        base = root / dest
        if not base.exists():
            continue
        for path in base.rglob("*"):
            name = path.name
            if path.is_dir() and name in FORBIDDEN_DIR_NAMES:
                errors.append(f"forbidden directory: {path.relative_to(root).as_posix()}")
                continue
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if name in FORBIDDEN_FILE_NAMES:
                errors.append(f"forbidden file: {rel}")
            if name.startswith(".env.") and name != ".env.example":
                errors.append(f"forbidden env file: {rel}")
            lowered = rel.lower()
            in_tests = (
                "/test/" in f"/{lowered}"
                or "/tests/" in f"/{lowered}"
                or "/fixtures/" in f"/{lowered}"
            )
            if path.suffix in FORBIDDEN_SUFFIXES or name.endswith(".sqlite3-journal"):
                if not in_tests:
                    errors.append(f"forbidden data/cache file: {rel}")
            try:
                sample = path.read_bytes()[: 1024 * 1024]
            except OSError as exc:
                errors.append(f"unreadable {rel}: {exc}")
                continue
            if any(marker in sample for marker in PRIVATE_KEY_MARKERS) and not in_tests:
                errors.append(f"private key block in {rel}")
            if lowered.endswith(".example") or in_tests:
                continue
            for match in list(GITHUB_TOKEN_RE.finditer(sample)) + list(GITHUB_PAT_RE.finditer(sample)):
                token = match.group(0).lower()
                if any(hint in token for hint in TOKEN_ALLOW_HINTS):
                    continue
                errors.append(f"possible live GitHub token in {rel}")
                break



def _github_json(url: str):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "openTeamily-upstream-migration-verifier",
    }
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _ds_bot_tree_sha_from_commit(commit: str) -> str:
    url = f"https://api.github.com/repos/{DS_BOT_REPO}/git/trees/{commit}"
    payload = _github_json(url)
    for entry in payload.get("tree", []):
        if entry.get("path") == "ds-bot" and entry.get("type") == "tree":
            return entry["sha"]
    raise KeyError(f"no ds-bot tree entry at {DS_BOT_REPO}@{commit}")


def check_ds_bot_pin(root: Path, errors: list[str]) -> dict | None:
    pin_path = root / DS_BOT_PIN_PATH
    equiv_path = root / DS_BOT_EQUIVALENCE_PATH
    if not pin_path.is_file():
        errors.append(f"missing {DS_BOT_PIN_PATH}")
        return None
    if not equiv_path.is_file():
        errors.append(f"missing {DS_BOT_EQUIVALENCE_PATH}")
        return None
    pin = load_json(pin_path)
    equiv = load_json(equiv_path)
    if pin.get("commit") != DS_BOT_PINNED_COMMIT:
        errors.append(
            f"{DS_BOT_PIN_PATH} commit {pin.get('commit')} != pinned {DS_BOT_PINNED_COMMIT} "
            "(do not retarget to upstream main or v0.3.6)"
        )
    if pin.get("tree") != DS_BOT_TREE:
        errors.append(f"{DS_BOT_PIN_PATH} tree {pin.get('tree')} != {DS_BOT_TREE}")
    if equiv.get("pinned_commit") != DS_BOT_PINNED_COMMIT:
        errors.append(f"{DS_BOT_EQUIVALENCE_PATH} pinned_commit mismatch")
    if equiv.get("ds_bot_tree") != DS_BOT_TREE:
        errors.append(f"{DS_BOT_EQUIVALENCE_PATH} ds_bot_tree mismatch")
    equivalent = (equiv.get("equivalent_commit_after_rewrite") or {}).get("sha")
    if equivalent != DS_BOT_EQUIVALENT_COMMIT:
        errors.append(
            f"{DS_BOT_EQUIVALENCE_PATH} equivalent commit {equivalent} != {DS_BOT_EQUIVALENT_COMMIT}"
        )
    if equivalent and equivalent in DS_BOT_FORBIDDEN_TARGETS:
        errors.append("equivalent commit must not be upstream v0.3.6 / main")
    if pin.get("commit") in DS_BOT_FORBIDDEN_TARGETS:
        errors.append(f"{DS_BOT_PIN_PATH} must not be retargeted to v0.3.6")
    return equiv


def fetch_ds_bot_equivalence(errors: list[str]) -> None:
    """Fetch 2b10c70 by SHA, or compare the equivalent 0f130e7 tree."""
    pinned_tree = None
    equivalent_tree = None
    try:
        pinned_tree = _ds_bot_tree_sha_from_commit(DS_BOT_PINNED_COMMIT)
    except Exception as exc:  # noqa: BLE001 — report and fall back to tree compare
        errors.append(
            f"direct SHA fetch of {DS_BOT_REPO}@{DS_BOT_PINNED_COMMIT} failed: {exc}; "
            f"falling back to equivalent commit {DS_BOT_EQUIVALENT_COMMIT}"
        )
    try:
        equivalent_tree = _ds_bot_tree_sha_from_commit(DS_BOT_EQUIVALENT_COMMIT)
    except Exception as exc:  # noqa: BLE001
        errors.append(
            f"fetch of equivalent {DS_BOT_REPO}@{DS_BOT_EQUIVALENT_COMMIT} failed: {exc}"
        )
        return
    if equivalent_tree != DS_BOT_TREE:
        errors.append(
            f"equivalent commit {DS_BOT_EQUIVALENT_COMMIT} ds-bot tree "
            f"{equivalent_tree} != {DS_BOT_TREE}"
        )
    if pinned_tree is not None and pinned_tree != DS_BOT_TREE:
        errors.append(
            f"pinned commit {DS_BOT_PINNED_COMMIT} ds-bot tree "
            f"{pinned_tree} != {DS_BOT_TREE}"
        )
    if pinned_tree is not None and equivalent_tree is not None and pinned_tree != equivalent_tree:
        errors.append(
            f"2b10c70 tree {pinned_tree} != equivalent 0f130e7 tree {equivalent_tree}"
        )


def check_origin_files(root: Path, errors: list[str]) -> None:
    for path, needle in (
        (root / "runtime/flybot/ORIGIN.md", "e26895e737b1218875aafa1f74ab1d3464f287d2"),
        (root / "runtime/flybot/OPENTEAMILY.md", "not"),
        (root / "services/bot-social/ORIGIN.md", "8706824f53f6cce8212470bc6b442f7271cccd3e"),
        (root / "services/bot-social/OPENTEAMILY.md", "optional"),
        (root / "docs/LICENSING.md", "Apache License 2.0"),
        (root / "runtime/flybot/ORIGIN.md", "0f130e7d134bf63e8988b2d53fd6846138ac3d73"),
        (root / "runtime/flybot/ORIGIN.md", "5834c00d9c21b972e4b32ad90489443da2a10324"),
        (root / "docs/upstream/SELECTION.md", "0f130e7d134bf63e8988b2d53fd6846138ac3d73"),
    ):
        if not path.is_file():
            errors.append(f"missing {path.relative_to(root).as_posix()}")
            continue
        text = path.read_text(encoding="utf-8")
        if needle.lower() not in text.lower():
            errors.append(f"{path.name} missing expected provenance text: {needle}")


def fetch_and_compare(manifest: dict, files_by_dest: dict, errors: list[str]) -> None:
    for url, prefix, dest in (
        (
            f"https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/{manifest['components']['flybot']['commit']}",
            f"FlyBot-{manifest['components']['flybot']['commit']}/",
            "runtime/flybot",
        ),
        (
            f"https://codeload.github.com/Birfy/bot-social/tar.gz/{manifest['components']['bot-social']['commit']}",
            f"bot-social-{manifest['components']['bot-social']['commit']}/",
            "services/bot-social",
        ),
    ):
        files = files_by_dest[dest]
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "src.tar.gz"
            with urllib.request.urlopen(url, timeout=120) as resp, archive.open("wb") as fh:
                fh.write(resp.read())
            with tarfile.open(archive, "r:gz") as tar:
                for rel, meta in files.items():
                    try:
                        member = tar.getmember(prefix + rel)
                    except KeyError:
                        errors.append(f"--fetch missing {dest}/{rel}")
                        continue
                    extracted = tar.extractfile(member)
                    if extracted is None:
                        errors.append(f"--fetch missing {dest}/{rel}")
                        continue
                    data = extracted.read()
                    digest = hashlib.sha256(data).hexdigest()
                    if digest != meta["sha256"]:
                        errors.append(
                            f"--fetch hash mismatch {dest}/{rel}: public {digest} != manifest {meta['sha256']}"
                        )


def verify(root: Path, fetch: bool = False) -> list[str]:
    errors: list[str] = []
    manifest_path = root / "docs/upstream/migration-manifest.json"
    flybot_files_path = root / "docs/upstream/flybot-files.json"
    social_files_path = root / "docs/upstream/bot-social-files.json"
    for path in (manifest_path, flybot_files_path, social_files_path):
        if not path.is_file():
            return [f"missing {path.relative_to(root).as_posix()}"]
    manifest = load_json(manifest_path)
    flybot_files = load_json(flybot_files_path)
    social_files = load_json(social_files_path)
    if manifest["components"]["flybot"]["file_count"] != len(flybot_files):
        errors.append("flybot file_count does not match flybot-files.json")
    if manifest["components"]["bot-social"]["file_count"] != len(social_files):
        errors.append("bot-social file_count does not match bot-social-files.json")
    check_pins(root, errors)
    check_manifest_files(root, "runtime/flybot", flybot_files, errors)
    check_manifest_files(root, "services/bot-social", social_files, errors)
    check_exclusions(root, manifest, errors)
    check_clean_tree(root, errors)
    check_origin_files(root, errors)
    check_ds_bot_pin(root, errors)
    if fetch:
        fetch_and_compare(
            manifest,
            {"runtime/flybot": flybot_files, "services/bot-social": social_files},
            errors,
        )
        fetch_ds_bot_equivalence(errors)
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="repository root (default: parent of scripts/)",
    )
    parser.add_argument(
        "--fetch",
        action="store_true",
        help="re-download public GitHub tarballs and fetch DS-Bot 2b10c70 (or equivalent 0f130e7) by SHA/tree",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve() if args.root else repo_root()
    errors = verify(root, fetch=args.fetch)
    if errors:
        print(f"verify-upstream-migration: {len(errors)} problem(s)", file=sys.stderr)
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        return 1
    manifest = load_json(root / "docs/upstream/migration-manifest.json")
    print(
        "verify-upstream-migration: ok "
        f"(flybot {manifest['components']['flybot']['file_count']} files, "
        f"bot-social {manifest['components']['bot-social']['file_count']} files)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
