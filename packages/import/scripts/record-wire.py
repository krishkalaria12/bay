#!/usr/bin/env python3
"""Records what the shared C++ readers give for every fixture profile into packages/import/fixtures/wire: the answers a
port of the readers must keep (portable/tests/Dump.cpp says which). Run on macOS or Linux after a reader changes on
purpose, and commit the result with the change.
"""
import importlib.util
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[3]


def main():
    spec = importlib.util.spec_from_file_location("rust_desktop", REPO / "scripts/lib/rust_desktop.py")
    rust = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rust)
    archive, libraries, includes = rust.link_flags()
    openssl = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "openssl"], text=True))
    sources = [REPO / "packages/import/portable" / name for name in ("Readers.cpp", "Sessions.cpp", "Arc.cpp", "Secrets.cpp")]
    sources += [REPO / "packages/sync/portable/SyncCrypto.cpp", REPO / "packages/sync/portable/tests/OpenSSLBackend.cpp",
                REPO / "packages/import/portable/tests/Dump.cpp"]
    output = REPO / "packages/import/fixtures/wire"
    with tempfile.TemporaryDirectory(prefix="bay-import-wire-") as directory:
        binary = Path(directory) / "dump"
        subprocess.run([shutil.which("c++"), "-std=c++17", "-DBAY_SYNC_PORTABLE_TEST",
                        "-I" + str(REPO / "engine/chromium/src/chrome/browser/bay/data/vendor"),
                        *[f"-I{path}" for path in includes], *map(str, sources), "-lsqlite3", *openssl,
                        str(archive), *libraries, "-o", str(binary)], check=True)
        shutil.rmtree(output, ignore_errors=True)
        subprocess.run([str(binary), str(REPO / "packages/import/fixtures"), str(output), str(Path(directory) / "scratch")],
                       check=True)
    print(f"wrote {len(list(output.glob('*.json')))} files to {output.relative_to(REPO)}")


if __name__ == "__main__":
    sys.exit(main())
