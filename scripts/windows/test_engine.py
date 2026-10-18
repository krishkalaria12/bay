"""Cross-platform regression tests for Windows engine artifacts and patch routing."""
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


engine = load("engine", HERE / "engine.py")
fetch = load("fetch", HERE / "fetch-engine.py")
series = load("series", engine.REPO / "engine/patches/series.py")
build_app = load("build_app", HERE / "build-app.py")
embed_config = load("embed_config", HERE / "embed-update-config.py")


class PatchPlatformTests(unittest.TestCase):
    def test_mac_data_encryption_patch_stays_mac_only(self):
        mac = {step.name for step in series.read_series("mac")}
        win = {step.name for step in series.read_series("win")}
        self.assertIn("chromium-safe-storage-name.patch", mac)
        self.assertNotIn("chromium-safe-storage-name.patch", win)
        self.assertIn("chromium-bay-layer-win.patch", win)
        self.assertNotIn("chromium-bay-layer-win.patch", mac)
        self.assertIn("cef-chrome-tabs.patch", mac)
        self.assertNotIn("cef-chrome-tabs.patch", win)
        self.assertFalse(any(step.kind == "cef" for step in series.read_series("win")))
        self.assertIn("chromium-extension-updates.patch", win & mac)
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
        binary = directory / "runtime/chrome.dll"
        binary.write_bytes(b"test engine")
        manifest = {"schemaVersion": 1, "id": "fixture", "lock": engine.LOCK,
                    "files": {"runtime/chrome.dll": engine.sha256(binary)}}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        return manifest

    def test_modified_binary_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            self.make_artifact(directory)
            fetch.verify(directory, "fixture")
            (pathlib.Path(directory) / "runtime/chrome.dll").write_bytes(b"tampered")
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

    def test_chrome_app_staging_preserves_matching_mojo_and_renames_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact, web, destination = root / "engine", root / "web", root / "app"
            manifest = self.make_artifact(artifact)
            for name in ("chrome.exe", "chrome_elf.dll", "resources.pak", "icudtl.dat", "bay-ui/native_host.mojom-webui.js"):
                path = artifact / "runtime" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(name.encode())
                manifest["files"][f"runtime/{name}"] = engine.sha256(path)
            (artifact / "manifest.json").write_text(json.dumps(manifest))
            web.mkdir()
            self.make_web_entry(web)
            (web / "native_host.mojom-webui.js").write_text("stale binding")
            with mock.patch.object(build_app.fetch.engine, "artifact_id", return_value="fixture"):
                build_app.stage(artifact, web, destination)
            self.assertEqual((destination / "Bay.exe").read_bytes(), b"chrome.exe")
            self.assertFalse((destination / "chrome.exe").exists())
            self.assertEqual((destination / "bay-ui/native_host.mojom-webui.js").read_text(), "bay-ui/native_host.mojom-webui.js")
            self.assertTrue((destination / "bay-ui/index.html").is_file())
            self.assertEqual(build_app.web_artifacts.verify_manifest(destination)["engineId"], "fixture")

    @staticmethod
    def make_web_entry(directory):
        (directory / "index.html").write_text('<div id="root"></div><script type="module" src="/bay-native-host.js"></script><script defer src="/app.js"></script>')
        (directory / "bay-native-host.js").write_text('import("/native_host.mojom-webui.js");')
        (directory / "app.js").write_text("// app fixture")

    def test_generated_mojo_graph_collects_local_modules_and_shared_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "native_host.mojom-webui.js").write_text('import {mojo} from "//resources/mojo/mojo/public/js/bindings.js";\nexport {Kind} from "./types/value.js";')
            (root / "types").mkdir()
            (root / "types/value.js").write_text('import "../native_host.mojom-webui.js";\nexport const Kind = 0;')
            files, shared = build_app.web_artifacts.mojo_files(root)
            self.assertEqual(set(files), {"native_host.mojom-webui.js", "types/value.js"})
            self.assertEqual(shared, ["//resources/mojo/mojo/public/js/bindings.js"])
            (root / "types/value.js").unlink()
            with self.assertRaisesRegex(ValueError, "dependency is missing"):
                build_app.web_artifacts.mojo_files(root)

    def test_generated_mojo_rejects_remote_and_escaping_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for reference in ("https://example.test/module.js", "../../outside.js", "file:///tmp/module.js", "/%2e%2e/outside.js"):
                with self.subTest(reference=reference):
                    (root / "native_host.mojom-webui.js").write_text(f'import "{reference}";')
                    with self.assertRaises(ValueError):
                        build_app.web_artifacts.mojo_files(root)

    def test_web_entry_requires_local_bundle_and_mojo_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_web_entry(root)
            build_app.web_artifacts.validate_entrypoint(root)
            for html in ('<script src="/app.js"></script>',
                         '<div id="root"></div><script>window.boot()</script>',
                         '<div id="root"></div><script type="module" src="https://example.test/app.js"></script>',
                         '<div id="root"></div><script type="module" src="/bay-native-host.js"></script><script src="/missing.js"></script>'):
                with self.subTest(html=html):
                    (root / "index.html").write_text(html)
                    with self.assertRaises(ValueError):
                        build_app.web_artifacts.validate_entrypoint(root)

    def test_app_manifest_rejects_changed_or_unlisted_ui_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            ui = root / "bay-ui"
            ui.mkdir()
            self.make_web_entry(ui)
            (ui / "native_host.mojom-webui.js").write_text('// Mojo fixture')
            build_app.web_artifacts.write_manifest(root, "fixture")
            build_app.web_artifacts.verify_manifest(root)
            (ui / "app.js").write_text("// changed")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                build_app.web_artifacts.verify_manifest(root)
            build_app.web_artifacts.write_manifest(root, "fixture")
            (ui / "stale.js").write_text("// stale")
            with self.assertRaisesRegex(ValueError, "do not match"):
                build_app.web_artifacts.verify_manifest(root)

    def test_archive_packages_transpiled_mojo_dependency_graph(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"), \
                mock.patch.object(engine, "source_digest", return_value="digest"), \
                mock.patch.object(engine, "artifact_id", return_value="fixture"):
            root = pathlib.Path(directory)
            (root / "bay-engine-build.json").write_text(json.dumps({"lock": engine.LOCK, "sourceDigest": "digest"}))
            binaries = root / "chromium_git/chromium/src" / engine.LOCK["outputDirectory"]
            binaries.mkdir(parents=True)
            for name in ("chrome.exe", "chrome.dll", "chrome_elf.dll", "icudtl.dat", "resources.pak", "chrome.pdb"):
                (binaries / name).write_bytes(name.encode())
            (binaries / "locales").mkdir()
            generated = binaries / "gen/chrome/browser/bay/webui/resources/tsc"
            generated.mkdir(parents=True)
            (generated / "native_host.mojom-webui.js").write_text('import "./helper.js";\nimport "//resources/mojo/mojo/public/js/bindings.js";')
            (generated / "helper.js").write_text("// dependency fixture")
            output = root / "archive"
            engine.archive(root, output)
            with zipfile.ZipFile(output / "fixture.zip") as archive:
                self.assertIn("runtime/bay-ui/helper.js", archive.namelist())
                self.assertIn("runtime/bay-ui/native_host.mojom-webui.js", archive.namelist())
                self.assertNotIn("runtime/chrome.pdb", archive.namelist())
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(manifest["mojo"]["sharedImports"], ["//resources/mojo/mojo/public/js/bindings.js"])
            (generated / "helper.js").unlink()
            with self.assertRaisesRegex(ValueError, "dependency is missing"):
                engine.archive(root, root / "missing-output")
            self.assertFalse((root / "missing-output").exists())

    def test_signed_updater_policy_rejects_unsafe_or_incomplete_configuration(self):
        config = {"enabled": True, "version": "1.2.3", "appVersion": "1.2.3", "buildNumber": "0",
                  "channel": "beta", "feedUrl": "https://updates.example.test/beta.json",
                  "publisherThumbprints": ["trusted"], "allowedOrigins": ["https://updates.example.test"],
                  "scriptSha256": "a" * 64}
        self.assertEqual(json.loads(embed_config.validate_config(config))["appVersion"], "1.2.3")
        for change in ({"enabled": "true"}, {"allowedOrigins": []}, {"allowedOrigins": ["http://example.test"]},
                       {"allowedOrigins": ["https://user:password@example.test"]}, {"appVersion": "1.2.2"},
                       {"scriptSha256": ""}, {"scriptSha256": "x" * 64}, {"scriptSha256": 12}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                embed_config.validate_config({**config, **change})

    def test_archive_refuses_stale_or_unbuilt_source(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"):
            with self.assertRaisesRegex(RuntimeError, "sources changed"):
                engine.archive(pathlib.Path(directory), pathlib.Path(directory) / "output")

    def test_fresh_clone_checks_out_pin_instead_of_rejecting_default_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "source"
            source.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=Bay Test", "-c", "user.email=test@example.invalid", *args], cwd=source, text=True).strip()
            git("init", "--quiet")
            (source / "version.txt").write_text("pinned")
            git("add", "version.txt")
            git("commit", "--quiet", "-m", "test: pin fixture")
            revision = git("rev-parse", "HEAD")
            (source / "version.txt").write_text("remote default")
            git("commit", "--quiet", "-am", "test: advance fixture")
            destination = root / "clone"
            engine.clone_pin(str(source), destination, revision)
            self.assertEqual((destination / "version.txt").read_text(), "pinned")
            self.assertEqual(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=destination, text=True).strip(), revision)
            # Reusing a valid pin is permitted, but local tracked edits survive
            # and cause an error rather than being reset by the downloader.
            engine.clone_pin(str(source), destination, revision)
            (destination / "version.txt").write_text("local work")
            with self.assertRaisesRegex(RuntimeError, "modified tracked files"):
                engine.clone_pin(str(source), destination, revision)
            self.assertEqual((destination / "version.txt").read_text(), "local work")

    def test_gn_arguments_use_windows_x64_and_real_symbols(self):
        self.assertEqual(engine.GN_ARGS["target_cpu"], "x64")
        self.assertGreater(engine.GN_ARGS["symbol_level"], 0)
        self.assertIs(engine.GN_ARGS["enable_cef"], False)
        self.assertNotIn("cef_api_version", engine.GN_ARGS)
        with tempfile.TemporaryDirectory() as directory:
            env = engine.environment(pathlib.Path(directory))
            self.assertIn('target_cpu="x64"', env["GN_DEFINES"])
            self.assertIn("is_debug=false", env["GN_DEFINES"])
            self.assertEqual(env["DEPOT_TOOLS_WIN_TOOLCHAIN"], "0")


if __name__ == "__main__":
    unittest.main()
