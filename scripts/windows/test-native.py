#!/usr/bin/env python3
"""Compile and run shared native algorithms on macOS or the Windows CNG backend.

Windows requires a Visual Studio Developer PowerShell. The vendored dependency
is nlohmann/json 3.11.3, verified by SHA-256 before use. macOS uses OpenSSL only
for the test adapter; the shipped Windows code uses CNG.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
JSON_SHA256 = "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6"


def json_include(override):
    root = Path(override) if override else REPO / "engine/chromium/src/chrome/browser/bay/data/vendor"
    header = root / "nlohmann/json.hpp"
    if not header.exists():
        raise RuntimeError(f"Missing {header}")
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
        def compile(sources, binary, libraries=(), extra_includes=()):
            sources = [REPO / source for source in sources]
            if windows:
                # One object per source: Readers.cpp and tests/Readers.cpp would otherwise both write Readers.obj.
                objects = [root / f"{binary.stem}-{index}-{source.stem}.obj" for index, source in enumerate(sources)]
                for source, obj in zip(sources, objects):
                    run([compiler, "/nologo", "/c", "/EHsc", "/std:c++17", "/DNOMINMAX", "/DWIN32_LEAN_AND_MEAN", f"/I{include}", *[f"/I{path}" for path in extra_includes], f"/Fo{obj}", source])
                run([compiler, "/nologo", *objects, f"/Fe{binary}", "/link", *libraries])
            else:
                run([compiler, "-std=c++17", f"-I{include}", *[f"-I{path}" for path in extra_includes], *sources, *libraries, "-o", binary])
        if args.suite in ("sync", "all"):
            sources = ["packages/sync/windows/SyncCrypto.cpp", "packages/sync/windows/SyncVault.cpp", "packages/sync/windows/RecoveryKit.cpp", "packages/sync/windows/vendor/qrcodegen.cpp", "packages/sync/windows/tests/Compatibility.cpp"]
            libraries = ["bcrypt.lib", "crypt32.lib", "advapi32.lib"]
            if not windows:
                sources.append("packages/sync/windows/tests/OpenSSLBackend.cpp")
                libraries = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
            binary = root / ("sync-test.exe" if windows else "sync-test")
            compile(sources, binary, libraries)
            run([binary, REPO / "packages/sync/windows/tests/golden.json", root / "vault"])
        if args.suite in ("import", "all"):
            binary = root / ("import-test.exe" if windows else "import-test")
            sources = ["packages/import/windows/Readers.cpp", "packages/import/windows/Sessions.cpp", "packages/import/windows/Arc.cpp", "packages/import/windows/Secrets.cpp", "packages/sync/windows/SyncCrypto.cpp", "packages/import/windows/tests/Readers.cpp"]
            libraries = ["winsqlite3.lib", "bcrypt.lib", "crypt32.lib", "advapi32.lib"]
            if not windows:
                sources.append("packages/sync/windows/tests/OpenSSLBackend.cpp")
                libraries = ["-lsqlite3", *shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))]
            compile(sources, binary, libraries)
            run([binary, REPO / "packages/import/fixtures", root / "import-db"])
        if args.suite == "all":
            spec = importlib.util.spec_from_file_location("bay_chromium_apply", REPO / "engine/chromium/apply.py")
            overlay = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(overlay)
            with overlay.layer_source(REPO / "engine/chromium", "chrome/browser/bay") as layer:
                data = layer / "data"
                production = data / "packages"
                sources = [data / "data_services.cc", data / "tests/Services.cpp"]
                sources.extend(production / "import/windows" / name for name in ("ImportService.cpp", "Readers.cpp", "Sessions.cpp", "Arc.cpp", "Secrets.cpp"))
                sources.extend(production / "sync/windows" / name for name in ("SyncService.cpp", "SyncCrypto.cpp", "SyncVault.cpp", "RecoveryKit.cpp", "vendor/qrcodegen.cpp"))
                libraries = ["winsqlite3.lib", "bcrypt.lib", "crypt32.lib", "advapi32.lib", "gdi32.lib", "ole32.lib", "shell32.lib", "user32.lib", "uuid.lib"]
                if windows:
                    sources.append(production / "sync/windows/RecoveryKitWindows.cpp")
                else:
                    sources.append(REPO / "packages/sync/windows/tests/OpenSSLBackend.cpp")
                    libraries = ["-lsqlite3", *shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))]
                binary = root / ("data-services-test.exe" if windows else "data-services-test")
                compile(sources, binary, libraries, [data])
                run([binary, root / "service-data"])


if __name__ == "__main__":
    main()
