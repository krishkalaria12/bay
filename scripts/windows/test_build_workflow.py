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

    def test_downstream_work_is_gated_by_valid_compile_outcomes(self):
        for name in ('Compress state', 'Upload state'):
            condition = re.search(r'^        if: (.*)$', step(name), re.M).group(1)
            self.assertEqual(condition, "steps.compile.outputs.code == '0' || steps.compile.outputs.code == '124'")
        for name in ('Archive engine', 'Upload engine'):
            self.assertIn("if: steps.compile.outputs.code == '0'", step(name))
        self.assertIn('fail-fast: true', WORKFLOW.read_text())
        self.assertNotIn('continue-on-error:', step('Compile'))


if __name__ == '__main__':
    unittest.main()
