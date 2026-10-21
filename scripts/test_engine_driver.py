"""Portable driver regression tests. Fixtures do not establish a Linux build."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bay_engine_driver", HERE / "engine.py")
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)


class PlatformTests(unittest.TestCase):
    def test_windows_lock_remains_flat_and_linux_compatibility_is_unmeasured(self):
        self.assertEqual(engine.LOCK, engine.platform_lock("win"))
        self.assertEqual(engine.LOCK["platform"], "windows")
        self.assertEqual(engine.LOCK["minimumWindowsBuild"], 22621)
        linux = engine.platform_lock("linux")
        self.assertEqual(linux["cefCommit"], engine.LOCK["cefCommit"])
        self.assertIsNone(linux["minimumGlibc"])
        self.assertIsNone(linux["sysroot"]["revision"])
        self.assertNotIn("minimumWindowsBuild", linux)
        with self.assertRaises(ValueError):
            engine.platform_lock("mac")

    def test_windows_entry_point_and_shared_cli_describe_same_pin(self):
        def pin(script, *args):
            return json.loads(subprocess.check_output([sys.executable, HERE / script, *args], text=True))
        windows = pin("windows/engine.py", "pin")
        self.assertEqual(windows, pin("engine.py", "--platform", "win", "pin"))
        linux = pin("engine.py", "pin", "--platform", "linux")
        self.assertIn("-windows-x64-", windows["id"])
        self.assertIn("-linux-x64-", linux["id"])
        self.assertIsNone(linux["minimumGlibc"])

    def test_linux_environment_has_no_windows_toolchain_and_uses_linux_gn_args(self):
        with mock.patch.dict(os.environ, {"DEPOT_TOOLS_WIN_TOOLCHAIN": "inherited"}):
            env = engine.environment(Path("/fixture"), "linux")
        self.assertNotIn("DEPOT_TOOLS_WIN_TOOLCHAIN", env)
        self.assertEqual(env["BAY_ENGINE_PLATFORM"], "linux")
        self.assertTrue(env["NN_SERIES_BASE"].endswith("series-base-linux"))
        for text in ('use_sysroot=true', 'use_vaapi=true', 'rtc_use_pipewire=true', 'enable_cef=false'):
            self.assertIn(text, env["GN_DEFINES"])
        self.assertNotIn("enable_iterator_debugging", env["GN_DEFINES"])
        self.assertNotIn("use_sysroot", engine.GN_ARGS)

    def test_default_roots_and_explicit_environment_override(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(engine.default_root(), Path("C:/bay-engine"))
            self.assertEqual(engine.default_root("linux"), Path.home() / "chromium-build")
        with mock.patch.dict(os.environ, {"BAY_ENGINE_ROOT": "custom-root"}):
            self.assertEqual(engine.default_root("linux"), Path("custom-root"))

    def test_host_guards_reject_cross_platform_and_arm_linux_before_mutation(self):
        for host, target, machine in (("darwin", "linux", "x86_64"), ("linux", "win", "x86_64"),
                                      ("win32", "linux", "AMD64"), ("linux", "linux", "aarch64")):
            with self.subTest(host=host, target=target, machine=machine), \
                 mock.patch.object(sys, "platform", host), \
                 mock.patch.object(sys, "argv", ["engine.py", "--platform", target, "build"]), \
                 mock.patch.object(engine.host_platform, "machine", return_value=machine), \
                 mock.patch.object(engine, "build_lock") as lock, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    engine.main()
                lock.assert_not_called()

    def test_root_refuses_other_platform_and_legacy_windows_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine.check_root_platform(root, "win")
            with self.assertRaisesRegex(RuntimeError, "another platform"):
                engine.check_root_platform(root, "linux")
            (root / ".bay-engine-platform").unlink()
            (root / "bay-prepare-state.json").write_text('["chromium-compat"]')
            with self.assertRaisesRegex(RuntimeError, "Windows preparation"):
                engine.check_root_platform(root, "linux")
            self.assertFalse((root / ".bay-engine-platform").exists())


class BuildTests(unittest.TestCase):
    def test_cli_dispatches_linux_build_options(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(sys, "platform", "linux"), \
             mock.patch.object(engine.host_platform, "machine", return_value="x86_64"), \
             mock.patch.object(sys, "argv", ["engine.py", "--platform", "linux", "build", "--root", directory,
                                            "--jobs", "2", "--target", "chrome_sandbox"]), \
             mock.patch.object(engine, "build") as build:
            engine.main()
            root, env, targets, jobs, platform = build.call_args.args
            self.assertEqual(root, Path(directory).resolve())
            self.assertEqual(env["BAY_ENGINE_PLATFORM"], "linux")
            self.assertEqual((targets, jobs, platform), (["chrome_sandbox"], 2, "linux"))

    def test_linux_prepare_preserves_patch_order_and_records_separate_state(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(engine, "require_linux_integration"), \
             mock.patch.object(engine, "require_tools"), mock.patch.object(engine, "verify_checkout"), \
             mock.patch.object(engine, "source_digest", return_value="digest"):
            root = Path(directory)
            ug = root / "ungoogled"
            ug.mkdir()
            (ug / "domain_substitution.list").write_text("chrome/fixture.cc\n")
            events = mock.Mock()
            with mock.patch.object(engine, "run", events.run), \
                 mock.patch.object(engine, "series", events.series), \
                 mock.patch.object(engine, "generate_gn", events.gn):
                env = engine.environment(root, "linux")
                engine.prepare(root, env, "linux")
            calls = events.mock_calls
            self.assertEqual(Path(calls[0].args[0][1]).as_posix(), "tools/patcher.py")
            self.assertEqual(Path(calls[1].args[0][1]).name, "03-ungoogled.py")
            self.assertEqual(Path(calls[2].args[0][1]).name, "domain_substitution.py")
            self.assertEqual(calls[3], mock.call.series(root, env, "capture-base", "--phase", "chromium"))
            self.assertEqual(calls[4], mock.call.series(root, env, "apply", "--phase", "chromium"))
            self.assertEqual(calls[5], mock.call.gn(root, env, "linux"))
            self.assertFalse((root / "bay-prepare-state.json").exists())
            self.assertEqual(json.loads((root / "bay-prepare-state-linux.json").read_text()),
                             ["chromium-compat", "ungoogled", "domains"])

    def test_linux_prepare_refuses_missing_integration_before_any_patching(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(engine.subprocess, "check_output", return_value="chromium shared.patch:\n"), \
             mock.patch.object(engine, "run") as run, mock.patch.object(engine, "verify_checkout") as verify:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "integration is incomplete"):
                engine.prepare(root, engine.environment(root, "linux"), "linux")
            run.assert_not_called()
            verify.assert_not_called()
            self.assertFalse((root / "bay-prepare-state-linux.json").exists())

    def test_linux_sysroot_and_tools_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = engine.environment(root, "linux")
            with self.assertRaisesRegex(RuntimeError, "sysroot"):
                engine.generate_gn(root, env, "linux")
            self.assertFalse((Path(env["CHROMIUM_SRC"]) / "out").exists())
            with mock.patch.object(engine.shutil, "which", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "missing required tool: gn"):
                    engine.require_tools(("gn",), env)

    def test_gn_generation_uses_selected_platform(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "run") as run:
            root = Path(directory)
            env = engine.environment(root, "linux")
            src = Path(env["CHROMIUM_SRC"])
            (src / "build/linux/debian_fixture_amd64-sysroot").mkdir(parents=True)
            engine.generate_gn(root, env, "linux")
            args = (src / engine.platform_lock("linux")["outputDirectory"] / "args.gn").read_text()
            self.assertIn('use_sysroot = true', args)
            self.assertNotIn('enable_iterator_debugging', args)
            run.assert_called_once_with(["gn", "gen", "out/Release_GN_x64"], cwd=src, env=env)

    def test_series_uses_environment_platform(self):
        with mock.patch.object(engine, "run") as run:
            engine.series(Path("/fixture"), {"BAY_ENGINE_PLATFORM": "linux"}, "check")
            self.assertEqual(run.call_args.args[0][-2:], ["--platform", "linux"])

    def test_build_targets_and_stamp_are_platform_specific(self):
        for platform, targets in (("win", ["chrome"]), ("linux", ["chrome", "chrome_sandbox"])):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(engine, "require_linux_integration"), \
                 mock.patch.object(engine, "require_tools"), mock.patch.object(engine, "verify_checkout"), \
                 mock.patch.object(engine, "series"), mock.patch.object(engine, "generate_gn"), \
                 mock.patch.object(engine, "source_digest", return_value="digest"), \
                 mock.patch.object(engine, "run") as run:
                root = Path(directory)
                env = engine.environment(root, platform)
                engine.build(root, env, [], 4, platform)
                self.assertEqual(run.call_args.args[0], ["autoninja", "-C", "out/Release_GN_x64", "-j", "4", *targets])
                stamp = root / "bay-engine-build.json"
                self.assertEqual(json.loads(stamp.read_text())["lock"], engine.platform_lock(platform))
                run.side_effect = RuntimeError("build failed")
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    engine.build(root, env, ["custom-target"], None, platform)
                self.assertFalse(stamp.exists())

    def test_failed_gn_generation_invalidates_previous_build_stamp(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"), \
             mock.patch.object(engine, "series"), \
             mock.patch.object(engine, "generate_gn", side_effect=RuntimeError("gn failed")):
            root = Path(directory)
            stamp = root / "bay-engine-build.json"
            stamp.write_text("old successful build")
            with self.assertRaisesRegex(RuntimeError, "gn failed"):
                engine.build(root, engine.environment(root), [], None)
            self.assertFalse(stamp.exists())


class LinuxArchiveTests(unittest.TestCase):
    def make_build(self, root):
        binaries = root / "chromium_git/chromium/src/out/Release_GN_x64"
        binaries.mkdir(parents=True)
        for name in ("bay", "chrome_sandbox", "chrome_crashpad_handler"):
            path = binaries / name
            path.write_bytes(b"\x7fELF fixture")
            path.chmod(0o755)
        for name in ("icudtl.dat", "resources.pak", "v8_context_snapshot.bin"):
            (binaries / name).write_bytes(b"fixture resource")
        (binaries / "locales").mkdir()
        (binaries / "locales/en-US.pak").write_bytes(b"locale")
        (binaries / "libvendor.so").write_bytes(b"\x7fELF vendor without symbols")
        generated = binaries / "gen/chrome/browser/bay/webui/resources/tsc"
        generated.mkdir(parents=True)
        (generated / "native_host.mojom-webui.js").write_text('// fixture')
        (root / "bay-engine-build.json").write_text(json.dumps(engine.build_identity("linux")))
        return binaries

    def fake_run(self, command, **kwargs):
        if command[0] == "objcopy" and command[1] == "--only-keep-debug":
            Path(command[3]).write_bytes(b"debug fixture")
        elif command[0] == "strip":
            Path(command[2]).write_bytes(b"\x7fELF stripped fixture")
        elif command[0] == "zstd":
            # Preserve the tar for inspection without requiring native Linux tools.
            shutil.copy2(command[3], command[5])

    def test_archive_separates_symbols_hashes_stripped_copies_and_preserves_modes(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"), \
             mock.patch.object(engine, "require_tools"), mock.patch.object(engine, "source_digest", return_value="digest"), \
             mock.patch.object(engine, "artifact_id", return_value="fixture-linux"), \
             mock.patch.object(engine, "run", side_effect=self.fake_run), \
             mock.patch.object(engine.subprocess, "check_output", side_effect=lambda command, **kwargs:
                               "" if Path(command[-1]).name == "libvendor.so" else ".debug_info"):
            root = Path(directory)
            binaries = self.make_build(root)
            (binaries / "chrome_sandbox").chmod(0o4755)
            original = (binaries / "bay").read_bytes()
            output = root / "archive"
            engine.archive(root, output, "linux")
            runtime = output / "fixture-linux.tar.zst"
            symbols = output / "fixture-linux-symbols.tar.zst"
            with tarfile.open(runtime) as archive:
                manifest = json.load(archive.extractfile("manifest.json"))
                self.assertEqual(manifest["lock"], engine.platform_lock("linux"))
                self.assertIn("runtime/bay-ui/native_host.mojom-webui.js", manifest["files"])
                self.assertEqual(archive.getmember("runtime/chrome_sandbox").mode, 0o755)
                for name, checksum in manifest["files"].items():
                    self.assertEqual(hashlib.sha256(archive.extractfile(name).read()).hexdigest(), checksum)
                self.assertFalse(any(name.endswith(".debug") for name in archive.getnames()))
            with tarfile.open(symbols) as archive:
                self.assertEqual(set(archive.getnames()), {f"runtime/.debug/{name}.debug" for name in
                                                        ("bay", "chrome_sandbox", "chrome_crashpad_handler")})
            for artifact in (runtime, symbols):
                self.assertEqual(artifact.with_suffix(".zst.sha256").read_text(),
                                 f"{engine.sha256(artifact)}  {artifact.name}\n")
            self.assertEqual((binaries / "bay").read_bytes(), original)

    def test_archive_refuses_wrong_stamp_missing_outputs_symbols_and_tools(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"), \
             mock.patch.object(engine, "source_digest", return_value="digest"), \
             mock.patch.object(engine, "require_tools"), mock.patch.object(engine, "run") as run:
            root = Path(directory)
            binaries = self.make_build(root)
            output = root / "archive"
            stamp = root / "bay-engine-build.json"
            stamp.write_text(json.dumps(engine.build_identity("win")))
            with self.assertRaisesRegex(RuntimeError, "sources changed"):
                engine.archive(root, output, "linux")
            stamp.write_text(json.dumps(engine.build_identity("linux")))
            (binaries / "bay").rename(binaries / "chrome")
            with self.assertRaisesRegex(RuntimeError, "missing.*bay"):
                engine.archive(root, output, "linux")
            (binaries / "chrome").rename(binaries / "bay")
            (binaries / "icudtl.dat").unlink()
            (binaries / "icudtl.dat").mkdir()
            with self.assertRaisesRegex(RuntimeError, "missing.*icudtl.dat"):
                engine.archive(root, output, "linux")
            (binaries / "icudtl.dat").rmdir()
            (binaries / "icudtl.dat").write_bytes(b"fixture")
            with mock.patch.object(engine, "require_tools", side_effect=RuntimeError("missing required tool: zstd")):
                with self.assertRaisesRegex(RuntimeError, "zstd"):
                    engine.archive(root, output, "linux")
            with mock.patch.object(engine.subprocess, "check_output", return_value="no debug sections"):
                with self.assertRaisesRegex(RuntimeError, "no debug info"):
                    engine.archive(root, output, "linux")
            self.assertFalse(output.exists())
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
