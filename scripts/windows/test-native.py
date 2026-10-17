#!/usr/bin/env python3
"""Compile and run shared native algorithms on macOS or the Windows CNG backend.

Windows requires a Visual Studio Developer PowerShell. The only test dependency
is nlohmann/json 3.11.3, verified by SHA-256 before use. macOS uses OpenSSL only
for the test adapter; the shipped Windows code uses CNG.
"""
from __future__ import annotations
import argparse
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request

REPO = Path(__file__).resolve().parents[2]
JSON_SHA256 = "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6"
JSON_URL = "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp"


def json_include(override):
    root = Path(override) if override else Path(tempfile.gettempdir()) / "bay-native-tests-deps" / JSON_SHA256
    header = root / "nlohmann/json.hpp"
    if not header.exists():
        if override:
            raise RuntimeError(f"Missing {header}")
        header.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(JSON_URL, timeout=60) as response:
            contents = response.read(2 * 1024 * 1024)
        if hashlib.sha256(contents).hexdigest() != JSON_SHA256:
            raise RuntimeError("nlohmann/json test dependency checksum mismatch")
        header.write_bytes(contents)
    if hashlib.sha256(header.read_bytes()).hexdigest() != JSON_SHA256:
        raise RuntimeError(f"Checksum mismatch: {header}")
    return root


def run(command):
    subprocess.run([str(part) for part in command], check=True, cwd=REPO)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=("sync", "import", "all"), default="all")
    parser.add_argument("--json-include", type=Path)
    args = parser.parse_args()
    include = json_include(args.json_include)
    windows = sys.platform == "win32"
    compiler = shutil.which("cl" if windows else "c++")
    if not compiler:
        raise RuntimeError("Open a Visual Studio Developer PowerShell" if windows else "Install a C++17 compiler")
    with tempfile.TemporaryDirectory(prefix="bay-native-tests-") as temporary:
        root = Path(temporary)
        def compile(sources, binary, libraries=()):
            sources = [REPO / source for source in sources]
            if windows:
                run([compiler, "/nologo", "/EHsc", "/std:c++17", "/DNOMINMAX", "/DWIN32_LEAN_AND_MEAN", f"/I{include}", f"/Fo{root}{os.sep}", *sources, f"/Fe{binary}", "/link", *libraries])
            else:
                run([compiler, "-std=c++17", f"-I{include}", *sources, *libraries, "-o", binary])
        if args.suite in ("sync", "all"):
            sources = ["packages/sync/windows/SyncCrypto.cpp", "packages/sync/windows/SyncVault.cpp", "packages/sync/windows/tests/Compatibility.cpp"]
            libraries = ["bcrypt.lib", "crypt32.lib", "advapi32.lib"]
            if not windows:
                sources.append("packages/sync/windows/tests/OpenSSLBackend.cpp")
                libraries = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
            binary = root / ("sync-test.exe" if windows else "sync-test")
            compile(sources, binary, libraries)
            run([binary, REPO / "packages/sync/windows/tests/golden.json", root / "vault"])
        if args.suite in ("import", "all"):
            binary = root / ("import-test.exe" if windows else "import-test")
            compile(["packages/import/windows/Readers.cpp", "packages/import/windows/Sessions.cpp", "packages/import/windows/tests/Readers.cpp"], binary, ["winsqlite3.lib"] if windows else ["-lsqlite3"])
            run([binary, REPO / "packages/import/fixtures", root / "import-db"])


if __name__ == "__main__":
    main()
