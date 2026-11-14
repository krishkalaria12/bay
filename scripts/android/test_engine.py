"""Check the Android engine pin, its identities and the build driver's parsing."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("engine.py")
SPEC = importlib.util.spec_from_file_location("bay_android_engine", SCRIPT)
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)

GN_WARNING = """WARNING at build arg file (use "gn args <out_dir>" to edit):12:27: Build argument has no effect.
enable_bay_magic = true
                   ^---
The variable "enable_bay_magic" was set as a build argument
but never appeared in a declare_args() block in any buildfile.
Done. Made 41321 targets from 3211 files in 9154ms
"""


class LockTests(unittest.TestCase):
    def test_lock_pins_an_exact_commit_for_its_version(self):
        lock = engine.LOCK
        self.assertRegex(lock["chromiumCommit"], r"^[0-9a-f]{40}$")
        self.assertRegex(lock["depotToolsCommit"], r"^[0-9a-f]{40}$")
        self.assertEqual(lock["chromiumRef"], f"refs/tags/{lock['chromium']}")

    def test_lock_builds_arm64_android_without_remote_execution(self):
        args = engine.LOCK["gnArgs"]
        self.assertEqual((args["target_os"], args["target_cpu"]), ("android", "arm64"))
        self.assertEqual(engine.LOCK["abi"], "arm64-v8a")
        self.assertFalse(args["is_debug"])
        self.assertFalse(args["is_component_build"])
        self.assertFalse(args["use_remoteexec"])
        # Ninja's log survives a saved and restored tree, which is how a stage resumes.
        self.assertFalse(args["use_siso"])


class IdentityTests(unittest.TestCase):
    def test_pin_command_prints_ids(self):
        pin = json.loads(subprocess.check_output([sys.executable, SCRIPT, "pin"], text=True))
        self.assertEqual(pin["stateArtifact"], f"android-engine-state-{pin['baseId']}")
        self.assertTrue(pin["id"].startswith(f"bay-android-engine-{engine.LOCK['chromium']}-arm64-"))
        self.assertEqual(pin["target"], "bay/mobile:aar")

    def test_gn_args_change_the_saved_tree_and_artifact(self):
        changed = copy.deepcopy(engine.LOCK)
        changed["gnArgs"]["symbol_level"] = 1
        self.assertNotEqual(engine.base_id(changed), engine.base_id())
        self.assertNotEqual(engine.engine_id(changed), engine.engine_id())

    def test_target_and_sources_change_the_artifact_not_the_saved_tree(self):
        retargeted = copy.deepcopy(engine.LOCK)
        retargeted["target"] = "bay/mobile:other"
        self.assertEqual(engine.base_id(retargeted), engine.base_id())
        self.assertNotEqual(engine.engine_id(retargeted), engine.engine_id())
        with tempfile.TemporaryDirectory() as directory:
            overlay = Path(directory)
            (overlay / "bay/mobile").mkdir(parents=True)
            (overlay / "bay/mobile/a.cc").write_text("one")
            with mock.patch.object(engine, "OVERLAY", overlay):
                before = engine.engine_id()
                (overlay / "bay/mobile/a.cc").write_text("two")
                self.assertNotEqual(engine.engine_id(), before)

    def test_overlay_replaces_only_its_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            overlay = base / "overlay"
            for directory in engine.OVERLAY_DIRECTORIES:
                (overlay / directory).mkdir(parents=True)
                (overlay / directory / "BUILD.gn").write_text("new")
            shared = base / "shared"
            for directory in engine.SHARED_DIRECTORIES:
                (shared / directory / "mojom").mkdir(parents=True)
                (shared / directory / "nn_request_filter.cc").write_text("shared filter")
                (shared / directory / "mojom/scriptlets.mojom").write_text("shared mojom")
            src = base / "root/chromium/src"
            (src / "bay/mobile").mkdir(parents=True)
            (src / "bay/mobile/stale.cc").write_text("old")
            (src / "content").mkdir()
            (src / "content/keep.cc").write_text("chromium")
            (src / "bay/filter").mkdir(parents=True)
            (src / "bay/filter/stale.cc").write_text("old")
            with mock.patch.object(engine, "OVERLAY", overlay), mock.patch.object(engine, "SHARED", shared):
                engine.apply_overlay(base / "root")
            self.assertEqual((src / "bay/mobile/BUILD.gn").read_text(), "new")
            self.assertEqual((src / "bay/filter/nn_request_filter.cc").read_text(), "shared filter")
            self.assertEqual((src / "bay/filter/mojom/scriptlets.mojom").read_text(), "shared mojom")
            self.assertFalse((src / "bay/filter/stale.cc").exists())
            self.assertFalse((src / "bay/mobile/stale.cc").exists())
            self.assertEqual((src / "content/keep.cc").read_text(), "chromium")

    def test_elf_alignment_reads_load_segments(self):
        header = bytearray(64)
        header[:5] = b"\x7fELF\x02"
        header[0x20:0x28] = (64).to_bytes(8, "little")
        header[0x36:0x38] = (56).to_bytes(2, "little")
        header[0x38:0x3a] = (2).to_bytes(2, "little")
        segments = b""
        for align in (16384, 65536):
            entry = bytearray(56)
            entry[0:4] = (1).to_bytes(4, "little")
            entry[48:56] = align.to_bytes(8, "little")
            segments += bytes(entry)
        with tempfile.TemporaryDirectory() as directory:
            library = Path(directory) / "lib.so"
            library.write_bytes(bytes(header) + segments)
            self.assertEqual(engine.elf_alignment(library), 16384)
            library.write_bytes(b"not an elf")
            self.assertIsNone(engine.elf_alignment(library))

    def test_ids_ignore_key_order(self):
        reordered = dict(reversed(list(engine.LOCK.items())))
        self.assertEqual(engine.base_id(reordered), engine.base_id())


class ParsingTests(unittest.TestCase):
    def test_gn_args_are_written_as_gn_literals(self):
        text = engine.gn_args_text({"gnArgs": {"target_os": "android", "is_debug": False, "symbol_level": 0}})
        self.assertEqual(text, 'target_os = "android"\nis_debug = false\nsymbol_level = 0\n')

    def test_unused_gn_args_are_named(self):
        self.assertEqual(engine.unused_gn_args(GN_WARNING), ["enable_bay_magic"])
        self.assertEqual(engine.unused_gn_args("Done. Made 41321 targets\n"), [])

    def test_versions_and_toolchains_are_read_from_the_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            src = Path(directory)
            (src / "chrome").mkdir()
            (src / "chrome/VERSION").write_text("MAJOR=154\nMINOR=0\nBUILD=8037\nPATCH=58\n")
            (src / "build/config/android").mkdir(parents=True)
            (src / "build/config/android/config.gni").write_text("    default_min_sdk_version = 29\n")
            ndk = src / "third_party/android_toolchain/ndk"
            ndk.mkdir(parents=True)
            (ndk / "source.properties").write_text("Pkg.Desc = Android NDK\nPkg.Revision = 29.0.14033849\n")
            (src / "third_party/android_sdk/public/platforms/android-36").mkdir(parents=True)
            self.assertEqual(engine.chromium_version(src), "154.0.8037.58")
            self.assertEqual(engine.min_sdk_version(src), 29)
            found = engine.toolchains(src)
            self.assertEqual(found["ndk"], "29.0.14033849")
            self.assertEqual(found["sdkPlatforms"], ["android-36"])
            self.assertIsNone(found["jdk"])


if __name__ == "__main__":
    unittest.main()
