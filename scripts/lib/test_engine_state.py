"""Exercise the archive that resumes engine builds across GitHub runner stages."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("engine-state.py")
SPEC = importlib.util.spec_from_file_location("bay_engine_state", SCRIPT)
state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(state)
MODIFIED_NS = 1700000000123456789


def gnu_tar():
    try:
        version = subprocess.run(["tar", "--version"], capture_output=True, text=True).stdout
    except OSError:
        return False
    return "GNU tar" in version and shutil.which("zstd") is not None


def make_tree(root: Path):
    (root / "src/out").mkdir(parents=True)
    source = root / "src/main.cc"
    source.write_text("int main() {}\n")
    os.utime(source, ns=(MODIFIED_NS, MODIFIED_NS))
    (root / "src/out/.ninja_log").write_text("# ninja log v7\n")
    (root / "empty").mkdir()
    (root / "link").symlink_to("src/main.cc")
    (root / "dangling").symlink_to("missing")


class EngineStateTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        self.root = self.base / "engine"
        make_tree(self.root)

    def test_archive_inside_the_root_is_refused(self):
        with self.assertRaisesRegex(ValueError, "outside the engine root"):
            state.create(self.root, self.root / "state.tar.zst")

    def test_archive_needs_the_zstd_suffix(self):
        with self.assertRaisesRegex(ValueError, "tar.zst"):
            state.create(self.root, self.base / "state.tar.gz")

    def test_restore_needs_an_empty_destination(self):
        archive = self.base / "state.tar.zst"
        archive.write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "must be empty"):
            state.restore(self.root, archive)

    def test_restore_refuses_a_missing_or_wrong_checksum(self):
        archive = self.base / "state.tar.zst"
        archive.write_bytes(b"not the saved tree")
        with self.assertRaisesRegex(ValueError, "no checksum"):
            state.restore(self.base / "restored", archive)
        state.checksum_path(archive).write_text("0" * 64 + "  state.tar.zst\n")
        with self.assertRaisesRegex(ValueError, "does not match"):
            state.restore(self.base / "restored", archive)
        self.assertFalse((self.base / "restored").exists())

    @unittest.skipUnless(gnu_tar(), "GNU tar and zstd write the state archive")
    def test_round_trip_keeps_links_and_nanosecond_times(self):
        archive = self.base / "state/state.tar.zst"
        subprocess.run([sys.executable, SCRIPT, "check", "--root", self.root, "--archive", archive], check=True)
        self.assertFalse(archive.exists())
        state.create(self.root, archive)
        self.assertTrue(state.checksum_path(archive).is_file())
        restored = self.base / "restored"
        state.restore(restored, archive)
        self.assertEqual(state.describe(self.root), state.describe(restored))
        self.assertEqual((restored / "src/main.cc").stat().st_mtime_ns, MODIFIED_NS)
        self.assertEqual(os.readlink(restored / "dangling"), "missing")


if __name__ == "__main__":
    unittest.main()
