"""The unit test runner builds and runs each platform's list, under Xvfb on Linux."""

import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("unit_tests", HERE / "unit-tests.py")
unit_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(unit_tests)


class UnitTestRunnerTests(unittest.TestCase):
    def run_platform(self, platform, built):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            out = root / "chromium_git/chromium/src" / unit_tests.OUTPUT_DIRECTORY
            out.mkdir(parents=True)
            suffix = ".exe" if platform == "win" else ""
            for test in built:
                (out / f"{test}{suffix}").write_text("")
            listing = "".join(f"{test}: phony\n" for test in unit_tests.TESTS[platform])
            calls = []

            def run(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command, 0, stdout=listing)

            with mock.patch.object(unit_tests.subprocess, "run", side_effect=run), \
                 mock.patch.object(unit_tests.subprocess, "NORMAL_PRIORITY_CLASS", 0x20, create=True):
                code = unit_tests.main(["--platform", platform, "--root", str(root), "--minutes", "30"])
            return code, calls, root

    def test_linux_runs_its_own_tests_under_chromiums_xvfb_wrapper(self):
        self.assertIn("sync_ui_linux_unittests", unit_tests.TESTS["linux"])
        self.assertNotIn("sync_ui_linux_unittests", unit_tests.TESTS["win"])
        self.assertTrue(set(unit_tests.TESTS["win"]) <= set(unit_tests.TESTS["linux"]))
        code, calls, root = self.run_platform("linux", unit_tests.TESTS["linux"])
        self.assertEqual(code, 0)
        src = root / "chromium_git/chromium/src"
        self.assertEqual(calls[0][0], str(src / "third_party/ninja/ninja"))
        runs = calls[2:]
        self.assertEqual(len(runs), len(unit_tests.TESTS["linux"]))
        self.assertEqual(runs[0][:2], [sys.executable, str(src / "testing/xvfb.py")])

    def test_windows_runs_the_executables_directly(self):
        code, calls, root = self.run_platform("win", unit_tests.TESTS["win"])
        self.assertEqual(code, 0)
        self.assertTrue(calls[0][0].endswith("ninja.exe"))
        self.assertTrue(all(len(run) == 1 and run[0].endswith(".exe") for run in calls[2:]))

    def test_a_test_that_did_not_build_fails_the_run(self):
        code, _, _ = self.run_platform("linux", unit_tests.TESTS["linux"][1:])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
