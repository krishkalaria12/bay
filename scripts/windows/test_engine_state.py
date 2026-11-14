"""Exercise the archive that resumes Windows engine jobs across runner stages."""
import builtins
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import unicodedata
from unittest import mock


SCRIPT = Path(__file__).with_name("engine-state.py")
SPEC = importlib.util.spec_from_file_location("bay_engine_state", SCRIPT)
state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(state)
# A multiple of 100ns, the resolution NTFS keeps.
MODIFIED_NS = 1700000000123456700


def make_tree(root):
    (root / "source").mkdir(parents=True)
    source = root / "source/hello ü.txt"
    source.write_text("engine source\n", encoding="utf-8")
    os.utime(source, ns=(MODIFIED_NS, MODIFIED_NS))
    os.link(source, root / "source/hard-link.txt")
    (root / ".build-state").write_text("saved\n")
    (root / "empty").mkdir()
    (root / "file-link").symlink_to("source/hello ü.txt")
    (root / "directory-link").symlink_to("source", target_is_directory=True)
    (root / "dangling-file").symlink_to("missing.txt")
    (root / "dangling-directory").symlink_to("missing-directory", target_is_directory=True)
    return source


class EngineStateTests(unittest.TestCase):
    def test_round_trip_preserves_links_and_exact_times(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            source = make_tree(root)
            archive = base / "state.tar.gz"
            subprocess.run([sys.executable, SCRIPT, "create", "--root", root,
                            "--archive", archive], check=True)
            with tarfile.open(archive) as tar:
                self.assertNotIn("directory-link/hello ü.txt", tar.getnames())
            restored = base / "restored"
            subprocess.run([sys.executable, SCRIPT, "restore", "--root", restored,
                            "--archive", archive], check=True)
            copy = restored / "source/hello ü.txt"
            self.assertEqual(copy.read_bytes(), source.read_bytes())
            self.assertEqual(copy.stat().st_mtime_ns, MODIFIED_NS)
            self.assertEqual((restored / "source/hard-link.txt").read_bytes(), source.read_bytes())
            self.assertEqual((restored / ".build-state").read_text(), "saved\n")
            self.assertTrue((restored / "empty").is_dir())
            for name in ("file-link", "directory-link", "dangling-file", "dangling-directory"):
                with self.subTest(name=name):
                    self.assertTrue((restored / name).is_symlink())
                    # Windows restores native separators; the target must be the same path.
                    self.assertEqual(unicodedata.normalize("NFC", os.path.normpath(os.readlink(restored / name))),
                                     unicodedata.normalize("NFC", os.path.normpath(os.readlink(root / name))))
            # Resuming a build needs restored links that resolve, not just their text.
            self.assertEqual((restored / "file-link").read_bytes(), source.read_bytes())
            self.assertEqual((restored / "directory-link/hello ü.txt").read_bytes(), source.read_bytes())
            self.assertFalse((restored / "dangling-file").exists())
            self.assertFalse((restored / "dangling-directory").exists())

    @unittest.skipUnless(os.name == "nt", "junctions exist only on Windows")
    def test_junction_is_kept_as_a_link_and_not_entered(self):
        import _winapi
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            (root / "source").mkdir(parents=True)
            (root / "source/file.txt").write_text("through a junction\n")
            _winapi.CreateJunction(str(root / "source"), str(root / "junction"))
            archive = base / "state.tar.gz"
            state.create(root, archive)
            with tarfile.open(archive) as tar:
                self.assertNotIn("junction/file.txt", tar.getnames())
            restored = base / "restored"
            state.restore(restored, archive)
            self.assertEqual((restored / "junction/file.txt").read_text(), "through a junction\n")

    def test_failed_write_keeps_previous_archive_and_removes_partial_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            root.mkdir()
            (root / "source.cc").write_text("source\n")
            archive = base / "state.tar.gz"
            state.create(root, archive)
            previous = archive.read_bytes()
            with mock.patch.object(tarfile.TarFile, "addfile", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    state.create(root, archive)
            self.assertEqual(archive.read_bytes(), previous)
            self.assertEqual(list(base.glob("*.partial")), [])

    def test_unreadable_file_is_reported_and_the_rest_is_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            root.mkdir()
            (root / "held.obj").write_text("held\n")
            (root / "source.cc").write_text("source\n")
            native_open = builtins.open

            def held_open(path, *args, **kwargs):
                if str(path).endswith("held.obj"):
                    raise PermissionError(13, "held by another process")
                return native_open(path, *args, **kwargs)

            archive = base / "state.tar.gz"
            with mock.patch.object(builtins, "open", side_effect=held_open), \
                 mock.patch.object(builtins, "print") as printed:
                state.create(root, archive)
            self.assertIn("held.obj", printed.call_args.args[0])
            self.assertTrue(printed.call_args.args[0].startswith("::warning::"))
            restored = base / "restored"
            state.restore(restored, archive)
            self.assertEqual([path.name for path in restored.iterdir()], ["source.cc"])

    def test_check_proves_the_round_trip_and_leaves_nothing_behind(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            make_tree(root)
            read_only = root / "source/read-only.txt"
            read_only.write_text("pack\n")
            read_only.chmod(stat.S_IREAD)
            scratch = base / "state"
            with mock.patch.object(builtins, "print"):
                state.check(root, scratch / "state.tar.gz")
            self.assertEqual(list(scratch.iterdir()), [])
            self.assertTrue(read_only.exists())

    def test_check_fails_when_the_round_trip_loses_an_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "engine"
            make_tree(root)
            scratch = base / "state"
            native_restore = state.restore

            def lossy_restore(destination, archive):
                native_restore(destination, archive)
                (destination / ".build-state").unlink()

            with mock.patch.object(state, "restore", side_effect=lossy_restore), \
                 mock.patch.object(builtins, "print"):
                with self.assertRaisesRegex(ValueError, r"1 entries changed.*\.build-state"):
                    state.check(root, scratch / "state.tar.gz")
            self.assertEqual(list(scratch.iterdir()), [])

    def test_check_reports_a_failed_archive_rather_than_its_clean_up(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            with self.assertRaisesRegex(ValueError, "not a directory"):
                state.check(base / "missing", base / "state.tar.gz")

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
