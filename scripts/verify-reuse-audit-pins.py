#!/usr/bin/env python3
"""Verify recorded reuse-audit pins and, optionally, re-fetch public files.

Default mode is offline: it checks pins.json structure and the recorded
sha256/byte lengths. Pass --fetch to download the public GitHub raw files
again and compare. This is not a license legal opinion and does not authorize
imports.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PINS_PATH = ROOT / "docs" / "reuse-audit" / "pins.json"

REQUIRED_SHA256 = {
    ("ThinkFlowLab/FlyBot", "LICENSE"): "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    ("ThinkFlowLab/FlyBot", "NOTICE"): "94f05bc42e635dee7082583c010dc13fb084b1ed9cdcfed6b9e5246c763027ca",
    ("Birfy/bot-social", "LICENSE"): "6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3",
    ("deepseek-ai/deepseek-harness", "LICENSE"): "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be",
    ("deepseek-ai/deepseek-harness", "THIRD_PARTY_NOTICES.md"): "aeea7aa256ede5349cc7903f56a859d54f10b82a45fba7dcce667eb69916dab0",
}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def load_pins() -> dict:
    if not PINS_PATH.is_file():
        fail(f"missing {PINS_PATH}")
    return json.loads(PINS_PATH.read_text())


def check_offline(pins: dict) -> int:
    errors = 0
    repos = pins.get("pins") or {}
    mapping = {
        "ThinkFlowLab/FlyBot": repos.get("ThinkFlowLab/FlyBot", {}),
        "Birfy/bot-social": repos.get("Birfy/bot-social", {}),
        "deepseek-ai/deepseek-harness": repos.get("deepseek-ai/deepseek-harness", {}),
    }
    for repo, fname in REQUIRED_SHA256:
        rec = (mapping[repo].get("files") or {}).get(fname)
        if not rec:
            print(f"FAIL: pins.json missing {repo} {fname}")
            errors += 1
            continue
        got = rec.get("sha256")
        if got != REQUIRED_SHA256[(repo, fname)]:
            print(f"FAIL: {repo} {fname} sha256 {got} != recorded constant")
            errors += 1
        else:
            print(f"OK offline {repo} {fname} sha256={got}")
        if not rec.get("url") or "github.com" not in rec["url"]:
            print(f"FAIL: {repo} {fname} missing public github url")
            errors += 1
    cp = repos.get("Birfy/flybot-control-plane") or {}
    if cp.get("import_allowed") is not False or cp.get("license_file_in_default_tree") is not False:
        print("FAIL: control-plane must remain import_allowed=false and no license file")
        errors += 1
    else:
        print("OK control-plane remains non-importable (no license file recorded)")
    fb = repos.get("ThinkFlowLab/FlyBot") or {}
    if fb.get("commit") != "e26895e737b1218875aafa1f74ab1d3464f287d2":
        print("FAIL: FlyBot main pin changed in pins.json; re-audit required")
        errors += 1
    else:
        print("OK FlyBot pin", fb.get("commit"))
    return errors


def raw_url(blob_url: str) -> str:
    # https://github.com/owner/repo/blob/sha/path -> raw.githubusercontent.com/owner/repo/sha/path
    prefix = "https://github.com/"
    if not blob_url.startswith(prefix) or "/blob/" not in blob_url:
        raise ValueError(blob_url)
    rest = blob_url[len(prefix) :]
    owner_repo, _, sha_path = rest.partition("/blob/")
    return f"https://raw.githubusercontent.com/{owner_repo}/{sha_path}"


def check_fetch(pins: dict) -> int:
    errors = 0
    repos = pins.get("pins") or {}
    for key, rec_repo in (
        ("ThinkFlowLab/FlyBot", repos.get("ThinkFlowLab/FlyBot")),
        ("Birfy/bot-social", repos.get("Birfy/bot-social")),
        ("deepseek-ai/deepseek-harness", repos.get("deepseek-ai/deepseek-harness")),
    ):
        files = (rec_repo or {}).get("files") or {}
        for fname, rec in files.items():
            url = rec.get("url")
            expected = rec.get("sha256")
            if not url or not expected:
                continue
            target = raw_url(url)
            try:
                with urllib.request.urlopen(target, timeout=30) as resp:
                    data = resp.read()
            except Exception as exc:
                print(f"FAIL fetch {key} {fname}: {exc}")
                errors += 1
                continue
            got = hashlib.sha256(data).hexdigest()
            if got != expected:
                print(f"FAIL fetch hash {key} {fname}: {got} != {expected} ({len(data)} bytes)")
                errors += 1
            else:
                print(f"OK fetch {key} {fname} ({len(data)} bytes)")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true", help="re-download public files and compare hashes")
    args = parser.parse_args()
    pins = load_pins()
    errors = check_offline(pins)
    if args.fetch:
        errors += check_fetch(pins)
    if errors:
        fail(f"{errors} check(s) failed")
    print("all reuse-audit pin checks passed")


if __name__ == "__main__":
    main()
