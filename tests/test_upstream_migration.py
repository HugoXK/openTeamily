"""Provenance and exclusion checks for the first FlyBot / Bot Social import."""
from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify-upstream-migration.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_upstream_migration", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class UpstreamMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verify = load_verifier()

    def test_current_tree_passes_offline_verifier(self):
        errors = self.verify.verify(ROOT, fetch=False)
        self.assertEqual(errors, [])

    def test_audit_license_pins_are_the_recorded_bytes(self):
        pins = self.verify.AUDIT_PINS
        self.assertEqual(
            self.verify.sha256_file(ROOT / "runtime/flybot/LICENSE"),
            pins["runtime/flybot/LICENSE"],
        )
        self.assertEqual(
            self.verify.sha256_file(ROOT / "runtime/flybot/NOTICE"),
            pins["runtime/flybot/NOTICE"],
        )
        self.assertEqual(
            self.verify.sha256_file(ROOT / "services/bot-social/LICENSE"),
            pins["services/bot-social/LICENSE"],
        )

    def test_default_core_exclusions_are_absent(self):
        flybot = ROOT / "runtime/flybot"
        self.assertFalse((flybot / "plugins/project").exists())
        self.assertFalse((flybot / "plugins/timeline").exists())
        self.assertFalse((flybot / "plugins/tree").exists())
        self.assertFalse((flybot / "plugins/workflow").exists())
        self.assertFalse((flybot / "ds-bot").exists())
        self.assertFalse((flybot / "patches").exists())
        self.assertFalse((flybot / "Dockerfile").exists())
        self.assertFalse((flybot / "compose.yaml").exists())
        self.assertFalse((flybot / "docs/images").exists())
        self.assertFalse((flybot / "docs/assets/wechat-group.png").exists())
        self.assertFalse((ROOT / "services/bot-social/docs/assets").exists())
        self.assertFalse((ROOT / "services/bot-social/docs/index.html").exists())
        self.assertFalse((ROOT / "services/bot-social/scripts/install.sh").exists())
        self.assertTrue((flybot / "plugins/social/index.js").is_file())
        self.assertTrue((flybot / "core/index.js").is_file())
        self.assertTrue((flybot / "docker/entrypoint.mjs").is_file())
        self.assertTrue((ROOT / "services/bot-social/src/server.ts").is_file())
        self.assertTrue((ROOT / "services/bot-social/public/index.html").is_file())

    def test_verifier_flags_excluded_plugin_and_dotenv(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            flybot = base / "runtime/flybot"
            (flybot / "plugins/project").mkdir(parents=True)
            (flybot / "plugins/project/index.js").write_text("x\n", encoding="utf-8")
            manifest = {
                "components": {
                    "flybot": {
                        "destination": "runtime/flybot",
                        "excluded_paths": ["plugins/project/index.js"],
                    },
                    "bot-social": {
                        "destination": "services/bot-social",
                        "excluded_paths": [],
                    },
                }
            }
            errors: list[str] = []
            self.verify.check_exclusions(base, manifest, errors)
            self.assertTrue(any("plugins/project" in item for item in errors), errors)

            social = base / "services/bot-social"
            social.mkdir(parents=True)
            (social / ".env").write_text("TOKEN=nope\n", encoding="utf-8")
            clean_errors: list[str] = []
            self.verify.check_clean_tree(base, clean_errors)
            self.assertTrue(any(".env" in item for item in clean_errors), clean_errors)

    def test_ds_bot_pin_equivalence_is_recorded(self):
        pin = (ROOT / "runtime/flybot/ds-bot.pin.json")
        equiv_path = (ROOT / "docs/upstream/ds-bot-pin-equivalence.json")
        self.assertTrue(pin.is_file())
        self.assertTrue(equiv_path.is_file())
        import json
        recorded = json.loads(pin.read_text(encoding="utf-8"))
        equiv = json.loads(equiv_path.read_text(encoding="utf-8"))
        self.assertEqual(recorded["commit"], self.verify.DS_BOT_PINNED_COMMIT)
        self.assertEqual(recorded["tree"], self.verify.DS_BOT_TREE)
        self.assertEqual(equiv["pinned_commit"], self.verify.DS_BOT_PINNED_COMMIT)
        self.assertEqual(equiv["ds_bot_tree"], self.verify.DS_BOT_TREE)
        self.assertEqual(
            equiv["equivalent_commit_after_rewrite"]["sha"],
            self.verify.DS_BOT_EQUIVALENT_COMMIT,
        )
        self.assertNotIn(recorded["commit"], self.verify.DS_BOT_FORBIDDEN_TARGETS)
        self.assertNotEqual(recorded["commit"], "a66cc737cfb6c3d8a2597e748cded6cab1206dd3")
        errors = []
        self.verify.check_ds_bot_pin(ROOT, errors)
        self.assertEqual(errors, [])
        origin = (ROOT / "runtime/flybot/ORIGIN.md").read_text(encoding="utf-8")
        self.assertIn(self.verify.DS_BOT_EQUIVALENT_COMMIT, origin)
        self.assertIn("v0.3.6", origin)


if __name__ == "__main__":
    unittest.main()
