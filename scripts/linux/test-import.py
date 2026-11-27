#!/usr/bin/env python3
"""Run Linux import/sync service fixtures with fake keyring access.

This exercises portable service behavior, not Linux integration. Production uses
BoringSSL; this fixture build reuses the existing OpenSSL test crypto adapter.
No real profile, secret service or desktop operation is used. macOS produces
Mac executables; --services-only also runs directly on Linux.
"""
import argparse
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--services-only", action="store_true",
                        help="skip the macOS-only NSS fixture generator")
    args = parser.parse_args()
    if sys.platform not in ("darwin", "linux"):
        raise RuntimeError("This fixture runner requires macOS or Linux")
    if sys.platform == "linux" and not args.services_only:
        raise RuntimeError("Use --services-only on Linux; the NSS fixture generator is macOS-only")
    compiler = shutil.which("c++")
    if not compiler or not shutil.which("pkg-config"):
        raise RuntimeError("Install a C++17 compiler and pkg-config with OpenSSL and GIO headers")
    flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
    if sys.platform == "linux":
        flags += shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "gio-2.0"], text=True))
        flags += ["-ldl"]
    # The sync format the shared C++ calls is bay-sync's, in Bay's desktop Rust library.
    flags += shlex.split(subprocess.check_output([sys.executable, str(REPO / "scripts/lib/rust_desktop.py")], text=True))
    sources = [
        "packages/import/portable/ImportService.cpp",
        "packages/import/portable/BrowserDiscovery.cpp",
        "packages/import/portable/Readers.cpp",
        "packages/import/portable/Secrets.cpp",
        "packages/import/linux/ChromiumSecrets.cpp",
        "packages/import/linux/SecretService.cpp",
        "packages/sync/portable/SyncCrypto.cpp",
        "packages/sync/portable/tests/OpenSSLBackend.cpp",
    ]
    with tempfile.TemporaryDirectory(prefix="bay-import-service-fixtures-") as directory:
        discovery = Path(directory) / "discovery-tests"
        # Profile listing is bay-import's, in Bay's desktop Rust library.
        subprocess.run([compiler, "-std=c++17", "-Wall", "-Wextra",
                        "-I" + str(REPO / "engine/chromium/src/chrome/browser/bay/data/vendor"),
                        str(REPO / "packages/import/portable/BrowserDiscovery.cpp"),
                        str(REPO / "packages/import/portable/tests/Discovery.cpp"),
                        *shlex.split(subprocess.check_output([sys.executable, str(REPO / "scripts/lib/rust_desktop.py")], text=True)),
                        "-o", str(discovery)], check=True)
        discovery_home = Path(directory) / "discovery-home"
        discovery_home.mkdir()
        subprocess.run([str(discovery), str(discovery_home)], check=True)
        data = REPO / "engine/chromium/src/chrome/browser/bay/data"
        for name, tests in (
            ("service", [REPO / "packages/import/linux/tests/Service.cpp"]),
            ("data", [data / "data_services.cc", data / "tests/Services.cpp"]),
        ):
            binary = Path(directory) / (name + "-tests")
            sync_sources = [] if name == "service" else [
                REPO / "packages/sync/portable" / source for source in
                ("SyncService.cpp", "SyncVault.cpp", "RecoveryKit.cpp")
            ]
            subprocess.run([compiler, "-std=c++17", "-DBAY_IMPORT_LINUX_TEST", "-DBAY_SYNC_PORTABLE_TEST", "-pthread",
                            "-I" + str(data / "vendor"), "-I" + str(data), "-I" + str(REPO),
                            *[str(REPO / source) for source in sources], *map(str, sync_sources), *map(str, tests),
                            "-lsqlite3", *flags, "-o", str(binary)], cwd=REPO, check=True)
            subprocess.run([str(binary), str(Path(directory) / (name + "-home"))], cwd=directory, check=True)
        gio = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "gio-2.0"], text=True))
        for source in ("WalletTest.cpp", "SecretServiceTest.cpp"):
            binary = Path(directory) / source.removesuffix(".cpp")
            subprocess.run([compiler, "-std=c++17", "-I" + str(data / "vendor"),
                            str(REPO / "packages/import/linux/tests" / source),
                            *gio, "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
        if not args.services_only:
            subprocess.run([sys.executable, str(REPO / "packages/import/linux/tests/run-fixtures.py")], check=True)


if __name__ == "__main__":
    main()
