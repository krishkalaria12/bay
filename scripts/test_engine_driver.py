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

SYSROOT_REVISION = "52d61d4446ffebfaa3dda2cd02da4ab4876ff237853f46d273e7f9b666652e1d"
SYSROOT_URL = "https://commondatastorage.googleapis.com/chrome-linux-sysroot"
SYSROOT_METADATA = {
    "Sha256Sum": SYSROOT_REVISION,
    "SysrootDir": "debian_bullseye_amd64-sysroot",
    "Tarball": "debian_bullseye_amd64_sysroot.tar.xz",
    "URL": SYSROOT_URL,
}


def make_linux_sysroot(src, install="installer"):
    metadata = src / "build/linux/sysroot_scripts/sysroots.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text(json.dumps({"bullseye_amd64": SYSROOT_METADATA}))
    directory = src / "build/linux" / SYSROOT_METADATA["SysrootDir"]
    directory.mkdir()
    if install == "gcs":
        (directory / f".{SYSROOT_REVISION}_hash").write_text(SYSROOT_REVISION + "\n")
        (directory / f".{SYSROOT_REVISION}_is_first_class_gcs").write_text("1\n")
    else:
        (directory / ".stamp").write_text(f"{SYSROOT_URL}/{SYSROOT_REVISION}")
    return directory


class PlatformTests(unittest.TestCase):
    def test_windows_lock_remains_flat_and_linux_compatibility_is_unmeasured(self):
        self.assertEqual(engine.LOCK, engine.platform_lock("win"))
        self.assertEqual(engine.LOCK["platform"], "windows")
        self.assertEqual(engine.LOCK["minimumWindowsBuild"], 22621)
        linux = engine.platform_lock("linux")
        self.assertEqual(linux["cefCommit"], engine.LOCK["cefCommit"])
        self.assertIsNone(linux["minimumGlibc"])
        self.assertEqual(linux["sysroot"], {
            "useSysroot": True,
            "revision": SYSROOT_REVISION,
            "revisionType": "sha256",
            "chromiumCommit": "a654841425914cbb703a2931e07b70a83aedbafd",
            "metadataFile": "build/linux/sysroot_scripts/sysroots.json",
            "metadataKey": "bullseye_amd64",
            "directory": SYSROOT_METADATA["SysrootDir"],
            "tarball": SYSROOT_METADATA["Tarball"],
            "url": SYSROOT_URL,
        })
        self.assertNotIn("sysroot", engine.LOCK)
        self.assertNotIn("minimumGlibc", engine.LOCK)
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
        self.assertEqual(linux["sysroot"], engine.platform_lock("linux")["sysroot"])

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
        self.assertNotIn("target_sysroot", engine.gn_args("win"))

    def test_default_roots_and_explicit_environment_override(self):
        home = HERE / "fixture-home"
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(Path, "home", return_value=home):
            self.assertEqual(engine.default_root(), Path("C:/bay-engine"))
            self.assertEqual(engine.default_root("linux"), home / "chromium-build")
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


class LinuxPreflightTests(unittest.TestCase):
    def make_series(self, repo):
        patches = repo / "engine/patches"
        patches.mkdir(parents=True)
        shutil.copy2(engine.REPO / "engine/patches/series.py", patches / "series.py")
        names = ("chromium-bay-layer-linux.patch", "chromium-bay-branding-linux.patch")
        for name in names:
            (patches / name).write_text("diff --git a/chrome/BUILD.gn b/chrome/BUILD.gn\n"
                                        "--- a/chrome/BUILD.gn\n+++ b/chrome/BUILD.gn\n"
                                        "@@ -1 +1 @@\n-old\n+new\n")
        (patches / "series").write_text("".join(f"chromium linux {name}\n" for name in names))
        return patches, names

    def test_selected_linux_integration_patches_pass_read_only_preflight(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "run") as run:
            root = Path(directory)
            self.make_series(root / "repo")
            env = engine.environment(root, "linux")
            make_linux_sysroot(Path(env["CHROMIUM_SRC"]))
            with mock.patch.object(engine, "REPO", root / "repo"):
                engine.require_linux_integration(env, "linux")
            run.assert_not_called()

    def test_missing_or_wrongly_routed_patch_stops_prepare_and_build_before_mutation(self):
        for action in ("prepare", "build"):
            for patch in (0, 1):
                for failure in ("route", "missing", "empty"):
                    with self.subTest(action=action, patch=patch, failure=failure), \
                         tempfile.TemporaryDirectory() as directory, \
                         mock.patch.object(engine, "run") as run, \
                         mock.patch.object(engine, "verify_checkout") as verify:
                        root = Path(directory)
                        patches, names = self.make_series(root / "repo")
                        if failure == "route":
                            (patches / "series").write_text("".join(
                                f"chromium {'win' if i == patch else 'linux'} {name}\n"
                                for i, name in enumerate(names)))
                        elif failure == "missing":
                            (patches / names[patch]).unlink()
                        else:
                            (patches / names[patch]).write_text("# unfinished patch\n")
                        env = engine.environment(root, "linux")
                        make_linux_sysroot(Path(env["CHROMIUM_SRC"]))
                        message = {"route": "series must route", "missing": "no such patch", "empty": "no target files"}[failure]
                        with mock.patch.object(engine, "REPO", root / "repo"):
                            with self.assertRaisesRegex(RuntimeError, message):
                                if action == "prepare":
                                    engine.prepare(root, env, "linux")
                                else:
                                    engine.build(root, env, [], None, "linux")
                        run.assert_not_called()
                        verify.assert_not_called()
                        self.assertFalse((root / "bay-prepare-state-linux.json").exists())
                        self.assertFalse((root / "bay-engine-build.json").exists())

    def test_sysroot_requires_exact_directory_and_install_stamp(self):
        for failure in (None, "missing", "other-release", "other-arch", "not-directory",
                        "no-stamp", "empty-stamp", "wrong-revision", "wrong-url", "newline"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                env = engine.environment(Path(directory), "linux")
                sysroot = make_linux_sysroot(Path(env["CHROMIUM_SRC"]))
                stamp = sysroot / ".stamp"
                if failure in ("missing", "other-release", "other-arch", "not-directory"):
                    shutil.rmtree(sysroot)
                    if failure == "other-release":
                        (sysroot.parent / "debian_bookworm_amd64-sysroot").mkdir()
                    elif failure == "other-arch":
                        (sysroot.parent / "debian_bullseye_arm64-sysroot").mkdir()
                    elif failure == "not-directory":
                        sysroot.touch()
                elif failure == "no-stamp":
                    stamp.unlink()
                elif failure == "empty-stamp":
                    stamp.write_text("")
                elif failure == "wrong-revision":
                    stamp.write_text(f"{SYSROOT_URL}/{'0' * 64}")
                elif failure == "wrong-url":
                    stamp.write_text(f"https://other.example/{SYSROOT_REVISION}")
                elif failure == "newline":
                    stamp.write_text(f"{SYSROOT_URL}/{SYSROOT_REVISION}\n")
                if failure is None:
                    engine.require_linux_sysroot(env, "linux")
                else:
                    with self.assertRaisesRegex(RuntimeError, "sysroot"):
                        engine.require_linux_sysroot(env, "linux")

    def test_sysroot_metadata_must_match_pin(self):
        invalid = [None, "invalid-json", {}, [], {"bullseye_amd64": None}]
        for key in SYSROOT_METADATA:
            invalid.append({"bullseye_amd64": {**SYSROOT_METADATA, key: "unexpected"}})
        for metadata in invalid:
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as directory:
                env = engine.environment(Path(directory), "linux")
                src = Path(env["CHROMIUM_SRC"])
                make_linux_sysroot(src)
                path = src / "build/linux/sysroot_scripts/sysroots.json"
                if metadata is None:
                    path.unlink()
                else:
                    path.write_text(metadata if isinstance(metadata, str) else json.dumps(metadata))
                with self.assertRaisesRegex(RuntimeError, "sysroot metadata"):
                    engine.require_linux_sysroot(env, "linux")

    def test_first_class_gcs_requires_exact_receipt_pair_and_overrides_stale_stamp(self):
        for failure in (None, "no-hash", "no-marker", "wrong-hash", "empty-hash", "no-hash-newline",
                        "wrong-marker", "empty-marker", "no-marker-newline", "other-revision",
                        "other-revision-with-valid-stamp", "wrong-hash-with-valid-stamp"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                env = engine.environment(Path(directory), "linux")
                sysroot = make_linux_sysroot(Path(env["CHROMIUM_SRC"]), "gcs")
                receipt = sysroot / f".{SYSROOT_REVISION}_hash"
                marker = sysroot / f".{SYSROOT_REVISION}_is_first_class_gcs"
                if failure is None:
                    # A complete gclient install supersedes an older installer stamp.
                    (sysroot / ".stamp").write_text("stale installer URL")
                    engine.require_linux_sysroot(env, "linux")
                    (sysroot / ".stamp").unlink()
                    engine.require_linux_sysroot(env, "linux")
                    continue
                if failure == "no-hash":
                    receipt.unlink()
                elif failure == "no-marker":
                    marker.unlink()
                elif failure in ("wrong-hash", "wrong-hash-with-valid-stamp"):
                    receipt.write_text("0" * 64 + "\n")
                elif failure == "empty-hash":
                    receipt.write_text("")
                elif failure == "no-hash-newline":
                    receipt.write_text(SYSROOT_REVISION)
                elif failure == "wrong-marker":
                    marker.write_text("0\n")
                elif failure == "empty-marker":
                    marker.write_text("")
                elif failure == "no-marker-newline":
                    marker.write_text("1")
                elif failure.startswith("other-revision"):
                    receipt.rename(sysroot / f".{('0' * 64)}_hash")
                    marker.rename(sysroot / f".{('0' * 64)}_is_first_class_gcs")
                if failure.endswith("with-valid-stamp"):
                    (sysroot / ".stamp").write_text(f"{SYSROOT_URL}/{SYSROOT_REVISION}")
                with self.assertRaisesRegex(RuntimeError, "sysroot GCS receipts"):
                    engine.require_linux_sysroot(env, "linux")

    def test_windows_does_not_inspect_linux_integration_or_sysroot(self):
        with mock.patch.object(engine.subprocess, "check_output") as check, \
             mock.patch.object(Path, "read_text") as read:
            engine.require_linux_integration({}, "win")
            engine.require_linux_sysroot({}, "win")
            check.assert_not_called()
            read.assert_not_called()


class BuildTests(unittest.TestCase):
    def test_linux_download_resumes_sync_before_automate_and_limits_initial_sync(self):
        for resumed in (False, True):
            with self.subTest(resumed=resumed), tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(engine, "clone_pin"), mock.patch.object(engine, "require_tools"), \
                 mock.patch.object(engine, "verify_checkout"), mock.patch.object(engine, "run") as run, \
                 mock.patch.object(engine.urllib.request, "urlopen") as urlopen:
                root = Path(directory)
                chromium = root / "chromium_git/chromium"
                chromium.mkdir(parents=True)
                if resumed:
                    (chromium / ".gclient").write_text("solutions = []")
                urlopen.return_value.__enter__.return_value.read.return_value = \
                    b'run("gclient sync %s" % sync_args, chromium_dir)\n'
                engine.download(root, engine.environment(root, "linux"), "linux")
                commands = [call.args[0] for call in run.call_args_list]
                self.assertEqual(commands[0], [root / "depot_tools/ensure_bootstrap"])
                syncs = [cmd for cmd in commands if cmd[0] == "gclient"]
                self.assertEqual(syncs, [["gclient", "sync", "--no-history", "--jobs=1"]] if resumed else [])
                self.assertIn("gclient sync --jobs=1 %s", (root / "automate/automate-git.py").read_text())
                self.assertEqual(commands[-1][1], root / "automate/automate-git.py")

    def test_download_refuses_prepared_tree_before_sync_or_cloning(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "run") as run, \
             mock.patch.object(engine, "clone_pin") as clone, mock.patch.object(engine, "require_tools"):
            root = Path(directory)
            (root / "bay-prepare-state-linux.json").write_text('["chromium-compat"]')
            with self.assertRaisesRegex(RuntimeError, "prepared tree"):
                engine.download(root, engine.environment(root, "linux"), "linux")
            run.assert_not_called()
            clone.assert_not_called()

    def test_missing_cef_paths_are_generated_before_gn_and_failure_stops_gn(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine.linux_sysroot, "install"), \
             mock.patch.object(engine, "require_tools"):
            root = Path(directory)
            env = engine.environment(root, "linux")
            src = Path(env["CHROMIUM_SRC"])
            make_linux_sysroot(src)
            (src / "cef").mkdir()
            def generate(command, **kwargs):
                if command[1] == "tools/version_manager.py":
                    (src / "cef/cef_paths.gypi").write_text("generated")
            with mock.patch.object(engine, "run", side_effect=generate) as run:
                engine.generate_gn(root, env, "linux")
                self.assertEqual(run.call_args_list[0].args[0][1:], ["tools/version_manager.py", "-u", "--fast-check"])
                self.assertEqual(run.call_args_list[1].args[0][0], "gn")
            (src / "cef/cef_paths.gypi").unlink()
            with mock.patch.object(engine, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "did not create"):
                    engine.generate_gn(root, env, "linux")
                self.assertEqual(run.call_count, 1)

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
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "run") as run, \
             mock.patch.object(engine.linux_sysroot, "install"), mock.patch.object(engine, "require_tools"):
            root = Path(directory)
            env = engine.environment(root, "linux")
            src = Path(env["CHROMIUM_SRC"])
            make_linux_sysroot(src)
            (src / "cef").mkdir()
            (src / "cef/cef_paths.gypi").write_text("generated")
            engine.generate_gn(root, env, "linux")
            args = (src / engine.platform_lock("linux")["outputDirectory"] / "args.gn").read_text()
            self.assertIn('use_sysroot = true', args)
            self.assertNotIn('target_sysroot', args)
            self.assertIn('clang_use_chrome_plugins = false', args)
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
                self.assertEqual(manifest["lock"]["sysroot"]["revision"], SYSROOT_REVISION)
                self.assertEqual(manifest["lock"]["sysroot"]["directory"], SYSROOT_METADATA["SysrootDir"])
                self.assertIsNone(manifest["lock"]["minimumGlibc"])
                self.assertIn("runtime/bay-ui/native_host.mojom-webui.js", manifest["files"])
                xdg_utils = engine.REPO / "engine/patches/build/linux/xdg-utils"
                for name in ("xdg-settings", "xdg-mime"):
                    member = archive.getmember(f"runtime/{name}")
                    if os.name != "nt":
                        # Windows chmod/stat cannot represent POSIX execute bits.
                        self.assertEqual(member.mode, 0o755)
                    self.assertEqual(archive.extractfile(member).read(), (xdg_utils / name).read_bytes())
                for name in ("LICENSE", "README.chromium", "README.bay"):
                    member = f"runtime/licenses/xdg-utils/{name}"
                    self.assertIn(member, manifest["files"])
                    self.assertEqual(archive.extractfile(member).read(), (xdg_utils / name).read_bytes())
                if os.name != "nt":
                    # Windows chmod/stat cannot model POSIX execute/setuid bits.
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

    def test_archive_refuses_build_stamp_with_stale_sysroot_provenance(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(engine, "verify_checkout"), \
             mock.patch.object(engine, "source_digest", return_value="digest"), \
             mock.patch.object(engine, "run") as run:
            root = Path(directory)
            self.make_build(root)
            identity = engine.build_identity("linux")
            # Copy through JSON so this deliberately stale stamp cannot mutate the lock.
            stale = json.loads(json.dumps(identity))
            stale["lock"]["sysroot"]["revision"] = None
            (root / "bay-engine-build.json").write_text(json.dumps(stale))
            with self.assertRaisesRegex(RuntimeError, "sources changed"):
                engine.archive(root, root / "archive", "linux")
            run.assert_not_called()
            self.assertFalse((root / "archive").exists())

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

    def test_archive_requires_bundled_helpers_and_attribution_before_publishing(self):
        for missing in ("xdg-settings", "xdg-mime", "LICENSE", "README.chromium", "README.bay"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(engine, "verify_checkout"), mock.patch.object(engine, "require_tools"), \
                 mock.patch.object(engine, "source_digest", return_value="digest"), \
                 mock.patch.object(engine, "run") as run:
                root = Path(directory)
                self.make_build(root)
                helpers = root / "repo/engine/patches/build/linux/xdg-utils"
                helpers.mkdir(parents=True)
                for name in ("xdg-settings", "xdg-mime", "LICENSE", "README.chromium", "README.bay"):
                    if name != missing:
                        (helpers / name).write_text("fixture")
                with mock.patch.object(engine, "REPO", root / "repo"), \
                     self.assertRaisesRegex(RuntimeError, f"bundled XDG helper:.*{missing}"):
                    engine.archive(root, root / "archive", "linux")
                self.assertFalse((root / "archive").exists())
                run.assert_not_called()


class BundledXdgTests(unittest.TestCase):
    def test_vendored_sources_match_documented_pin_except_sibling_mime_calls(self):
        helpers = engine.REPO / "engine/patches/build/linux/xdg-utils"
        provenance = (helpers / "README.bay").read_text()
        self.assertIn("f16d51e9ce95f4173ba878a61b59317f73005562", provenance)
        self.assertIn("473c0f72d7db2e8492f0fa975b8544bc719bb027", provenance)
        for line in provenance.splitlines():
            if len(line) < 66 or line[64:66] != "  ":
                continue
            checksum, name = line.split("  ", 1)
            data = (helpers / name).read_bytes()
            if name == "xdg-settings":
                self.assertEqual(data.count(b'"$(dirname "$0")/xdg-mime" '), 3)
                data = data.replace(b'"$(dirname "$0")/xdg-mime" ', b'xdg-mime ')
            self.assertEqual(hashlib.sha256(data).hexdigest(), checksum)

    @unittest.skipUnless(shutil.which("sh"), "requires a POSIX shell")
    def test_scripts_parse_without_running_external_desktop_commands(self):
        for name in ("xdg-settings", "xdg-mime"):
            subprocess.run(["sh", "-n", engine.REPO / "engine/patches/build/linux/xdg-utils" / name],
                           check=True, capture_output=True)

    @unittest.skipUnless(os.name == "posix", "requires executable shell fixtures")
    def test_settings_queries_sibling_mime_instead_of_path_decoy(self):
        with tempfile.TemporaryDirectory(prefix="bay xdg ") as directory:
            root = Path(directory)
            settings = root / "xdg-settings"
            shutil.copy2(engine.REPO / "engine/patches/build/linux/xdg-utils/xdg-settings", settings)
            settings.chmod(0o755)
            decoy = root / "distro"
            decoy.mkdir()
            for path, answer in ((root / "xdg-mime", "bay.desktop"), (decoy / "xdg-mime", "wrong.desktop")):
                path.write_text(f"#!/bin/sh\necho {answer}\n")
                path.chmod(0o755)
            # DE avoids desktop detection. Both MIME backends are harmless
            # scripts; no real desktop setting is read or changed.
            env = {"HOME": directory, "DE": "gnome3", "PATH": f"{decoy}:/usr/bin:/bin"}
            result = subprocess.run([settings, "get", "default-web-browser"], env=env,
                                    check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout, "bay.desktop\n")


if __name__ == "__main__":
    unittest.main()
