#!/usr/bin/env python3
"""Fetch pinned engine sources. The macOS path retains its existing build lock."""
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
if sys.platform == "win32":
    command = [sys.executable, str(REPO / "scripts/windows/engine.py"), "download", *sys.argv[1:]]
elif sys.platform == "darwin":
    command = ["bash", str(REPO / "scripts/download-engine"), *sys.argv[1:]]
else:
    sys.exit("Bay supports macOS and Windows desktop only")
sys.exit(subprocess.call(command))
