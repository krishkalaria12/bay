"""Cross-platform regression tests for Windows engine artifacts and patch routing."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

HERE = pathlib.Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = load("engine", HERE / "engine.py")
fetch = load("fetch", HERE / "fetch-engine.py")
series = load("series", engine.REPO / "engine/patches/series.py")


class PatchPlatformTests(unittest.TestCase):
    def test_mac_data_encryption_patch_stays_mac_only(self):
        mac = {step.name for step in series.read_series("mac")}
        win = {step.name for step in series.read_series("win")}
        self.assertIn("chromium-safe-storage-name.patch", mac)
        self.assertNotIn("chromium-safe-storage-name.patch", win)
        self.assertIn("chromium-bay-layer-win.patch", win)
        self.assertNotIn("chromium-bay-layer-win.patch", mac)
        self.assertIn("cef-chrome-tabs.patch", win & mac)
        self.assertEqual({step.name for step in series.read_series()}, win | mac)

    def test_windows_nncore_has_no_mac_hooks(self):
        step = next(step for step in series.read_series("win") if step.name == "engine/nncore")
        self.assertEqual(step.paths(), [("bay", True)])

    def test_windows_exports_patch_applies_to_pinned_target(self):
        step = next(step for step in series.read_series("win") if step.name == "chromium-bay-layer-win.patch")
        original = '\n'.join([
            '      "//chrome/browser:chrome_content_browser_client",',
            '      "//chrome/browser:chrome_process_singleton",',
            '      "//chrome/browser:process_singleton",',
            '      "//chrome/browser:startup_data",',
            '      "//chrome/browser/lifetime",',
            '      "//chrome/browser/win/isolated_browser:isolated_browser_support",', ''])
        with tempfile.TemporaryDirectory() as directory:
            chrome = pathlib.Path(directory) / "chrome"
            chrome.mkdir()
            (chrome / "BUILD.gn").write_text(original)
            self.assertIsNone(series.apply_step(step, directory))
            self.assertTrue(series.is_applied(step, directory))


class ArtifactTests(unittest.TestCase):
    def make_artifact(self, directory):
        directory = pathlib.Path(directory)
        (directory / "runtime").mkdir(parents=True)
        binary = directory / "runtime/nncore.dll"
        binary.write_bytes(b"test engine")
        manifest = {"schemaVersion": 1, "id": "fixture", "lock": engine.LOCK,
                    "files": {"runtime/nncore.dll": engine.sha256(binary)}}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        return manifest

    def test_modified_binary_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            self.make_artifact(directory)
            fetch.verify(directory, "fixture")
            (pathlib.Path(directory) / "runtime/nncore.dll").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                fetch.verify(directory, "fixture")

    def test_wrong_pin_and_unlisted_files_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            self.make_artifact(directory)
            with self.assertRaisesRegex(ValueError, "does not match"):
                fetch.verify(directory, "another-engine")
            (pathlib.Path(directory) / "runtime/unlisted.dll").write_bytes(b"unlisted")
            with self.assertRaisesRegex(ValueError, "do not match"):
                fetch.verify(directory, "fixture")

    def test_archive_traversal_and_duplicate_windows_paths_rejected(self):
        for names in (("../outside.dll",), ("runtime/engine.dll", "runtime/ENGINE.dll"), ("C:/escape.dll",)):
            with self.subTest(names=names), tempfile.TemporaryDirectory() as directory:
                archive = pathlib.Path(directory) / "engine.zip"
                with zipfile.ZipFile(archive, "w") as output:
                    for name in names:
                        output.writestr(name, "malicious")
                destination = pathlib.Path(directory) / "staged"
                with self.assertRaises(ValueError):
                    fetch.extract(archive, destination, "fixture")
                self.assertFalse(destination.exists())

    def test_verified_archive_extracted_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            source = directory / "source"
            self.make_artifact(source)
            archive = directory / "engine.zip"
            with zipfile.ZipFile(archive, "w") as output:
                for file in source.rglob("*"):
                    if file.is_file():
                        output.write(file, file.relative_to(source).as_posix())
            destination = directory / "staged"
            fetch.extract(archive, destination, "fixture")
            self.assertEqual(fetch.verify(destination, "fixture")["id"], "fixture")
            with self.assertRaisesRegex(ValueError, "already exists"):
                fetch.extract(archive, destination, "fixture")

    def test_concurrent_build_refused_without_deleting_existing_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with engine.build_lock(root):
                with self.assertRaisesRegex(RuntimeError, "Another build"):
                    with engine.build_lock(root):
                        self.fail("a second build acquired the lock")
                self.assertTrue((root / ".bay-build.lock").exists())
            self.assertFalse((root / ".bay-build.lock").exists())

    def test_gn_arguments_use_windows_x64_and_real_symbols(self):
        self.assertEqual(engine.GN_ARGS["target_cpu"], "x64")
        self.assertEqual(engine.GN_ARGS["cef_api_version"], "999999")
        self.assertGreater(engine.GN_ARGS["symbol_level"], 0)
        with tempfile.TemporaryDirectory() as directory:
            env = engine.environment(pathlib.Path(directory))
            self.assertIn('target_cpu="x64"', env["GN_DEFINES"])
            self.assertIn("is_debug=false", env["GN_DEFINES"])
            self.assertEqual(env["DEPOT_TOOLS_WIN_TOOLCHAIN"], "0")


if __name__ == "__main__":
    unittest.main()
