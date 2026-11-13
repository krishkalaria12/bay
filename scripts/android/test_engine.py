"""Check the Android engine pin, its identities and the build driver's parsing."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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

    def test_gn_args_change_the_saved_tree_and_artifact(self):
        changed = copy.deepcopy(engine.LOCK)
        changed["gnArgs"]["symbol_level"] = 1
        self.assertNotEqual(engine.base_id(changed), engine.base_id())
        self.assertNotEqual(engine.engine_id(changed), engine.engine_id())

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
