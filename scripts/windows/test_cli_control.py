"""Portable CLI control-file discovery and token-file security checks."""
from pathlib import Path
import shutil
import subprocess
import unittest

REPO = Path(__file__).resolve().parents[2]
BUN = shutil.which("bun")


@unittest.skipUnless(BUN, "requires Bun for CLI endpoint tests")
class CliControlTests(unittest.TestCase):
    def test_endpoint_discovery_and_private_token_file(self):
        subprocess.run([BUN, "test", "tests/endpoint.test.ts"],
                       cwd=REPO / "apps/cli", check=True, capture_output=True)
