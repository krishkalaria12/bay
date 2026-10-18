"""The package overlay must be reproducible without editing the checkout source."""
import importlib.util
import hashlib
import os
import re
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


class ChromiumLayerTests(unittest.TestCase):
    def test_package_overlay_is_idempotent_and_detects_drift(self):
        with tempfile.TemporaryDirectory(prefix="bay-apply-test-") as directory:
            # Freeze the inputs before applying/checking, so concurrent edits in
            # a development checkout cannot look like an overlay regression.
            checkout = Path(directory) / "checkout"
            here = checkout / "engine/chromium"
            shutil.copytree(HERE, here, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for package in ("import", "sync"):
                shutil.copytree(REPO / "packages" / package / "windows",
                                checkout / "packages" / package / "windows")
            root = Path(directory) / "chromium"
            environment = dict(os.environ, CHROMIUM_SRC=str(root))
            command = [sys.executable, str(here / "apply.py")]
            subprocess.run(command, env=environment, check=True, capture_output=True)
            target = root / "chrome/browser/bay/data/packages"
            for package, source in (("import", "ImportService.cpp"), ("sync", "SyncService.cpp")):
                copied = target / package / "windows" / source
                self.assertEqual(copied.read_bytes(), (checkout / "packages" / package / "windows" / source).read_bytes())
                self.assertFalse((target / package / "windows/tests").exists())
            data = target.parent
            for source in re.findall(r'"([^"\n]+\.(?:cc|cpp|h))"', (data / "BUILD.gn").read_text()):
                self.assertTrue((data / source).is_file(), f"Missing GN source {source}")
            self.assertEqual(
                hashlib.sha256((data / "vendor/nlohmann/json.hpp").read_bytes()).hexdigest(),
                "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6",
            )
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)
            changed = target / "import/windows/Readers.cpp"
            changed.write_text("drift\n")
            result = subprocess.run([*command, "--check"], env=environment, capture_output=True)
            self.assertEqual(result.returncode, 1)
            subprocess.run(command, env=environment, check=True, capture_output=True)
            subprocess.run([*command, "--check"], env=environment, check=True, capture_output=True)

    def test_engine_digest_tracks_production_data_code(self):
        spec = importlib.util.spec_from_file_location("bay_engine_digest_test", REPO / "scripts/windows/engine.py")
        engine = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(engine)
        with tempfile.TemporaryDirectory(prefix="bay-digest-test-") as directory:
            original = engine.REPO
            engine.REPO = Path(directory)
            try:
                production = engine.REPO / "packages/import/windows/Readers.cpp"
                production.parent.mkdir(parents=True)
                production.write_text("before\n")
                before = engine.source_digest()
                production.write_text("after\n")
                after = engine.source_digest()
                self.assertNotEqual(before, after)
                test_file = production.parent / "tests/Readers.cpp"
                test_file.parent.mkdir()
                test_file.write_text("test-only\n")
                self.assertEqual(after, engine.source_digest())
            finally:
                engine.REPO = original


if __name__ == "__main__":
    unittest.main()
