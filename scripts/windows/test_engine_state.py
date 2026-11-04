"""Exercise the same native tar commands used to resume Windows engine jobs."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import unicodedata
from unittest import mock


SCRIPT = Path(__file__).with_name("engine-state.py")
SPEC = importlib.util.spec_from_file_location("bay_engine_state", SCRIPT)
state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(state)


class EngineStateTests(unittest.TestCase):
    def test_native_tar_round_trip_preserves_links_and_tree_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            root.mkdir()
            (root / "source").mkdir()
            source = root / "source/hello ü.txt"
            source.write_text("engine source\n", encoding="utf-8")
            os.utime(source, (1700000000, 1700000000))
            (root / ".build-state").write_text("saved\n")
            (root / "empty").mkdir()
            (root / "file-link").symlink_to("source/hello ü.txt")
            (root / "directory-link").symlink_to("source", target_is_directory=True)
            (root / "dangling-file").symlink_to("missing.txt")
            (root / "dangling-directory").symlink_to("missing-directory", target_is_directory=True)
            archive = base / "state.tar.gz"
            subprocess.run([sys.executable, SCRIPT, "create", "--root", root,
                            "--archive", archive], check=True)
            restored = base / "restored"
            subprocess.run([sys.executable, SCRIPT, "restore", "--root", restored,
                            "--archive", archive], check=True)
            self.assertEqual((restored / "source/hello ü.txt").read_bytes(), source.read_bytes())
            self.assertEqual(int((restored / "source/hello ü.txt").stat().st_mtime), 1700000000)
            self.assertEqual((restored / ".build-state").read_text(), "saved\n")
            self.assertTrue((restored / "empty").is_dir())
            for name in ("file-link", "directory-link", "dangling-file", "dangling-directory"):
                with self.subTest(name=name):
                    self.assertTrue((restored / name).is_symlink())
                    # macOS can normalize Unicode link text and Windows tar restores
                    # native separators; the target must be the same path on either.
                    self.assertEqual(unicodedata.normalize("NFC", os.path.normpath(os.readlink(restored / name))),
                                     unicodedata.normalize("NFC", os.path.normpath(os.readlink(root / name))))
            # Resuming a build needs restored links that resolve, not just their text.
            self.assertEqual((restored / "file-link").read_bytes(), source.read_bytes())
            self.assertEqual((restored / "directory-link/hello ü.txt").read_bytes(), source.read_bytes())
            self.assertFalse((restored / "dangling-file").exists())
            self.assertFalse((restored / "dangling-directory").exists())

    def test_failed_tar_keeps_previous_archive_and_removes_partial_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            root.mkdir()
            (root / "source.cc").write_text("source\n")
            archive = base / "state.tar.gz"
            state.create(root, archive)
            previous = archive.read_bytes()
            native_run = subprocess.run

            def unreadable_input(command, **kwargs):
                # Ask the actual archiver to read a missing input after it has
                # already written part of the new archive.
                return native_run([*command, "missing-source.cc"], capture_output=True, **kwargs)

            with mock.patch.object(state.subprocess, "run", side_effect=unreadable_input):
                with self.assertRaises(subprocess.CalledProcessError):
                    state.create(root, archive)
            self.assertEqual(archive.read_bytes(), previous)
            self.assertEqual(list(base.glob("*.partial")), [])

    def test_refuses_missing_input_and_archive_inside_source(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with self.assertRaisesRegex(ValueError, "not a directory"):
                state.create(base / "missing", base / "state.tar.gz")
            with self.assertRaisesRegex(ValueError, "outside"):
                state.create(base, base / "state.tar.gz")
            with self.assertRaisesRegex(ValueError, "archive is missing"):
                state.restore(base / "restored", base / "missing.tar.gz")

    def test_bad_archive_fails_and_existing_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "invalid.tar.gz"
            archive.write_bytes(b"not an archive")
            result = subprocess.run([sys.executable, SCRIPT, "restore", "--root", base / "restore",
                                     "--archive", archive], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("engine state restore failed", result.stderr)
            root = base / "existing"
            root.mkdir()
            original = root / "source.cc"
            original.write_text("preserve me\n")
            with self.assertRaisesRegex(ValueError, "must be empty"):
                state.restore(root, archive)
            self.assertEqual(original.read_text(), "preserve me\n")


if __name__ == "__main__":
    unittest.main()
