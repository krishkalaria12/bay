"""Exercise layer lookup and freshness failures without touching the shared Chromium tree."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class EngineFreshTests(unittest.TestCase):
    def test_committed_engine_has_prebuilt(self):
        tree = subprocess.check_output(['git', 'rev-parse', 'HEAD:engine'], cwd=ROOT, text=True).strip()
        entries = [line.split() for line in (ROOT / 'packages/chromium/prebuilt-engines.tsv').read_text().splitlines()
                   if line.strip() and not line.startswith('#')]
        self.assertTrue(any(entry[0] == tree for entry in entries),
                        'publish and register a prebuilt engine for ' + tree)

    def test_layers_and_stale_framework(self):
        layers = [line.split()[1] for line in (ROOT / 'engine/patches/series').read_text().splitlines()
                  if line.startswith('layer ')]
        for layer in layers:
            self.assertTrue((ROOT / layer / 'apply.sh').is_file(), layer)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            helper = root / 'scripts/lib/engine-fresh.sh'
            helper.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / 'scripts/lib/engine-fresh.sh', helper)
            for layer in layers:
                apply = root / layer / 'apply.sh'
                apply.parent.mkdir(parents=True)
                apply.write_text('#!/bin/sh\n[ "$1" = --check ] && [ ! -f "$0.fail" ]\n')
                apply.chmod(0o755)
            source = root / 'chromium'
            (source / 'bay').mkdir(parents=True)
            (source / 'chrome/browser/bay').mkdir(parents=True)
            binary = root / 'framework/Versions/Current/Chromium Framework'
            binary.parent.mkdir(parents=True)
            binary.touch()
            def check():
                return subprocess.run(['bash', str(helper), str(root / 'framework'), str(source)],
                                      capture_output=True, text=True)
            self.assertEqual(check().returncode, 0)
            for layer in layers:
                marker = root / layer / 'apply.sh.fail'
                marker.touch()
                result = check()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('tree differs from ' + layer, result.stderr)
                marker.unlink()
            newer = source / 'bay/changed.cc'
            newer.touch()
            os.utime(binary, (1, 1))
            result = check()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('newer than the framework', result.stderr)


if __name__ == '__main__':
    unittest.main()
