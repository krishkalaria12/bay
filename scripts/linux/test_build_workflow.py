"""Run the Linux build workflow's real Compile script and check how its stages hand over."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/linux-build.yml"
BASH = shutil.which("bash")


def step(name):
    source = WORKFLOW.read_text()
    match = re.search(r"^      - name: " + re.escape(name) + r"\n(.*?)(?=^      - |^  packages:|\Z)", source, re.M | re.S)
    if not match:
        raise AssertionError(f"Missing workflow step: {name}")
    return match.group(1)


class LinuxBuildWorkflowTests(unittest.TestCase):
    @unittest.skipUnless(BASH, "bash runs the workflow's steps")
    def test_compile_only_accepts_success_and_deliberate_pause(self):
        body = textwrap.dedent(step("Compile").split("        run: |\n", 1)[1])
        for code in (0, 124, 1, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                driver = root / "scripts/engine.py"
                driver.parent.mkdir(parents=True)
                driver.write_text(f'import sys\nprint("fixture compile exit {code}")\nsys.exit({code})\n')
                prefix = root / "bin"
                prefix.mkdir()
                (prefix / "python").symlink_to(sys.executable)
                output = root / "output"
                env = dict(os.environ, GITHUB_OUTPUT=str(output), ENGINE_ROOT=str(root), JOB_STARTED="0",
                           PATH=str(prefix) + os.pathsep + os.environ["PATH"])
                # Actions runs bash steps with -e and pipefail.
                result = subprocess.run([BASH, "--noprofile", "--norc", "-eo", "pipefail", "-c", body],
                                        cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if code in (0, 124) else code, result.stdout + result.stderr)
                self.assertEqual(output.read_text().strip(), f"code={code}")
                self.assertIn(f"fixture compile exit {code}", (root / "compile.log").read_text())

    def test_state_is_saved_after_any_compile_and_the_engine_only_after_success(self):
        for name in ("Compress state", "Upload state"):
            condition = re.search(r"^        if: (.*)$", step(name), re.M).group(1)
            self.assertEqual(condition, "${{ !cancelled() && steps.compile.outputs.code != '' }}")
        compiled = "env.DONE != 'true' && steps.compile.outputs.code == '0'"
        self.assertIn(f"if: {compiled}\n", step("Archive engine"))
        self.assertIn(f"if: steps.reuse.outputs.reused == 'true' || ({compiled})\n", step("Upload engine"))
        self.assertIn("fail-fast: true", WORKFLOW.read_text())
        self.assertNotIn("continue-on-error:", step("Compile"))
        # zstd state needs GNU tar, which the Linux runner has; the name picks the format.
        self.assertIn("state.tar.zst", step("Compress state"))

    def test_an_engine_with_the_same_id_is_reused_before_any_restore(self):
        source = WORKFLOW.read_text()
        reuse = step("Reuse an engine built from these sources")
        self.assertLess(source.index("Reuse an engine built from these sources"), source.index("Download saved state"))
        self.assertIn("python scripts/engine.py --platform linux pin", reuse)
        self.assertIn('[[ -f "dist/engine/$id.tar.zst" ]]', reuse)
        self.assertIn('"DONE=true" >> "$GITHUB_ENV"', reuse)
        self.assertIn("select(.workflow_run.repository_id == .workflow_run.head_repository_id)", reuse)

    def test_every_stage_installs_build_dependencies_from_the_tree(self):
        source = WORKFLOW.read_text()
        dependencies = step("Install Chromium's build dependencies")
        self.assertIn("if: env.DONE != 'true'\n", dependencies)
        for earlier in ("Restore saved state", "Download sources"):
            self.assertLess(source.index(f"name: {earlier}"), source.index("name: Install Chromium's build dependencies"))
        self.assertLess(source.index("name: Install Chromium's build dependencies"), source.index("name: Patch sources"))

    def test_packages_use_the_engine_this_checkout_builds(self):
        build = step("Build app")
        self.assertIn('archive="dist/engine/$id.tar.zst"', build)
        self.assertIn("scripts/linux/release.sh --app dist/linux-app", step("Package"))
        self.assertIn("continue-on-error: true", step("Check the AppImage opens a window"))


if __name__ == "__main__":
    unittest.main()
