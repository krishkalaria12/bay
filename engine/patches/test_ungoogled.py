"""Exercise sandbox patch selection without touching a Chromium checkout."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "build/03-ungoogled.py"
SANDBOX_PATCHES = (
    "extra/inox-patchset/0016-chromium-sandbox-pie.patch",
    "extra/ungoogled-chromium/remove-disable-setuid-sandbox-as-bad-flag.patch",
)


class SandboxSelectionTests(unittest.TestCase):
    def test_linux_applies_both_sandbox_patches_other_hosts_skip_them(self):
        for platform in ("linux", "darwin", "win32"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                series = root / "ungoogled/patches/series"
                series.parent.mkdir(parents=True)
                series.write_text("\n".join((*SANDBOX_PATCHES, "portable.patch")) + "\n")
                with mock.patch.dict(os.environ, {"CB": directory, "CHROMIUM_SRC": str(root / "src")}), \
                     mock.patch.object(sys, "platform", platform), \
                     mock.patch.object(sys, "argv", [str(SCRIPT), "--dry-run"]), \
                     mock.patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run, \
                     contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as result:
                        runpy.run_path(str(SCRIPT), run_name="__main__")
                self.assertEqual(result.exception.code, 0)
                selected = {Path(call.args[0][-1]).relative_to(series.parent).as_posix()
                            for call in run.call_args_list}
                expected = {"portable.patch", *SANDBOX_PATCHES} if platform == "linux" else {"portable.patch"}
                self.assertEqual(selected, expected)
                report = (root / "logs/ungoogled-patches.tsv").read_text()
                for name in SANDBOX_PATCHES:
                    self.assertIn(f"{name}\t{'applied' if platform == 'linux' else 'skipped'}\t", report)
                # A dry run must never reach an applying subprocess.
                self.assertTrue(all("--check" in call.args[0] for call in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
