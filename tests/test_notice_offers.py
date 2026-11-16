"""Offline checks for KaTeX, sharp-libvips, Anthropic, and Debian offer tooling."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KATEX = ROOT / "runtime" / "third_party" / "font-notices" / "katex"
SHARP = ROOT / "runtime" / "third_party" / "sharp-libvips"
ANTHROPIC = ROOT / "runtime" / "third_party" / "anthropic-sdk"


class NoticeOfferTests(unittest.TestCase):
    def test_katex_license_matches_the_official_package_text(self):
        data = (KATEX / "LICENSE").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3")
        self.assertIn(b"MIT License", data)
        self.assertIn(b"Khan Academy", data)
        pins = json.loads((KATEX / "pins.json").read_text())
        self.assertFalse(pins["ofl_txt_in_package_or_git_tag"])
        self.assertFalse(pins["font_binaries_vendored"])
        self.assertIn("0.18.7", pins["matched_versions"])

    def test_anthropic_license_matches_the_image_inventory_hash(self):
        data = (ANTHROPIC / "LICENSE").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "8bf96984ff8bcfae7e48cae76a529e8a25317ba9e02abf7fd3cc64fdf95657a6")
        self.assertEqual(len(data), 1056)
        self.assertIn(b"Copyright 2023 Anthropic, PBC.", data)
        readme = (ANTHROPIC / "README.md").read_text()
        self.assertIn("not", readme.lower())
        self.assertIn("claude-agent-sdk", readme)
        self.assertIn("@anthropic-ai/sdk@0.129.0", readme)

    def test_sharp_libvips_offer_offline_check_passes(self):
        process = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "fetch-sharp-libvips-sources.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertNotIn(".so", [p.suffix for p in SHARP.rglob("*") if p.is_file()])
        notices = (SHARP / "THIRD-PARTY-NOTICES.md").read_text()
        self.assertIn("LGPLv3", notices)
        self.assertIn("Mozilla Public License 1.1", notices)

    def test_debian_source_offer_lists_exact_fixture_versions(self):
        inventory = {
            "collected_at": "2026-11-16T13:55:30.030Z",
            "os": {
                "os_release": {"PRETTY_NAME": "Debian GNU/Linux 12 (bookworm)", "VERSION_CODENAME": "bookworm"},
                "packages": [
                    {
                        "name": "git",
                        "version": "1:2.39.5-0+deb12u3",
                        "source_package": "git",
                        "source_version": "1:2.39.5-0+deb12u3",
                        "copyright_sha256": "8ceacdebe13249ea8aba6e400418e2b503c83a1f19ad92377380fb32ecf48d0c",
                        "copyright_fields": {"licenses": ["GPL-2", "GPL-2+"]},
                    },
                    {
                        "name": "ca-certificates",
                        "version": "20230311",
                        "source_package": "ca-certificates",
                        "source_version": "20230311",
                        "copyright_sha256": "abc",
                        "copyright_fields": {"licenses": ["GPL-2+ or MPL-2.0"]},
                    },
                ],
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            inv = Path(tmp) / "inventory.json"
            out = Path(tmp) / "offer"
            inv.write_text(json.dumps(inventory))
            process = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "debian-source-offer.py"), "--inventory", str(inv), "--out", str(out)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            text = (out / "debian-source-offer.md").read_text()
            self.assertIn("not", text.lower())
            self.assertIn("legal", text.lower())
            self.assertIn("apt-get source git=1:2.39.5-0+deb12u3", text)
            self.assertIn("apt-get source ca-certificates=20230311", text)
            payload = json.loads((out / "debian-packages.json").read_text())
            self.assertIs(payload["public_redistributable_image"], False)
            self.assertEqual(payload["binary_package_count"], 2)
            self.assertEqual(payload["source_package_count"], 2)


if __name__ == "__main__":
    unittest.main()
