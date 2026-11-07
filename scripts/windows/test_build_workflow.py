"""Run the workflow's real Compile script against native process exit codes."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / '.github/workflows/windows-build.yml'
PWSH = os.environ.get('PWSH') or shutil.which('pwsh')


def step(name):
    source = WORKFLOW.read_text()
    match = re.search(r'^      - name: ' + re.escape(name) + r'\n(.*?)(?=^      - |^  installer:|\Z)', source, re.M | re.S)
    if not match:
        raise AssertionError(f'Missing workflow step: {name}')
    return match.group(1)


class WindowsBuildWorkflowTests(unittest.TestCase):
    @unittest.skipUnless(PWSH, 'PowerShell is required to exercise the Windows workflow')
    def test_compile_only_accepts_success_and_deliberate_pause(self):
        body = textwrap.dedent(step('Compile').split('        run: |\n', 1)[1])
        for code in (0, 124, 1, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                driver = root / 'scripts/windows/engine.py'
                driver.parent.mkdir(parents=True)
                driver.write_text(f'import sys\nprint("fixture compile exit {code}")\nsys.exit({code})\n')
                script = root / 'compile.ps1'
                script.write_text(body)
                output = root / 'output'
                env = dict(os.environ, GITHUB_OUTPUT=str(output), ENGINE_ROOT=str(root),
                           JOB_STARTED='2099-01-01T00:00:00Z')
                # Match the runner's native Python command without depending on
                # a second interpreter selected by the developer's shell.
                prefix = root / 'bin'
                prefix.mkdir()
                if os.name != 'nt':
                    (prefix / 'python').symlink_to(sys.executable)
                    env['PATH'] = str(prefix) + os.pathsep + env['PATH']
                result = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', script],
                                        cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if code in (0, 124) else code,
                                 result.stdout + result.stderr)
                self.assertEqual(output.read_text().strip(), f'code={code}')
                self.assertIn(f'fixture compile exit {code}', (root / 'compile.log').read_text())

    def test_state_is_saved_after_any_compile_and_the_engine_only_after_success(self):
        for name in ('Compress state', 'Upload state'):
            condition = re.search(r'^        if: (.*)$', step(name), re.M).group(1)
            # A compile error still fails the job, but its progress is kept for the fix.
            self.assertEqual(condition, "${{ !cancelled() && steps.compile.outputs.code != '' }}")
        # A stage after the engine exists skips Compile, whose null output equals '0'.
        compiled = "env.DONE != 'true' && steps.compile.outputs.code == '0'"
        self.assertIn(f"if: {compiled}\n", step('Archive engine'))
        # A reused engine is published as this run's without being archived again.
        self.assertIn(f"if: steps.reuse.outputs.reused == 'true' || ({compiled})\n", step('Upload engine'))
        self.assertIn('fail-fast: true', WORKFLOW.read_text())
        self.assertNotIn('continue-on-error:', step('Compile'))

    def test_an_engine_with_the_same_id_is_reused_before_any_restore(self):
        source = WORKFLOW.read_text()
        reuse = step('Reuse an engine built from these sources')
        self.assertLess(source.index('Reuse an engine built from these sources'), source.index('Download saved state'))
        self.assertIn('python scripts/windows/engine.py pin', reuse)
        # Only an archive named for this checkout's id counts; it then skips every compile step.
        self.assertIn('Test-Path "dist/engine/$id.zip"', reuse)
        self.assertIn('"DONE=true" >> $env:GITHUB_ENV', reuse)
        self.assertIn('select(.workflow_run.repository_id == .workflow_run.head_repository_id)', reuse)


if __name__ == '__main__':
    unittest.main()
