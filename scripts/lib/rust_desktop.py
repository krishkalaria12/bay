#!/usr/bin/env python3
"""Bay's desktop Rust library (packages/rust, bay-desktop) for the native tests that compile the shared C++ without
Chromium: builds it for this machine and says how to link it.

    from rust_desktop import link_flags      # or: python3 scripts/lib/rust_desktop.py  (prints the flags)
    archive, libraries, includes = link_flags()

On Windows it builds with the static C runtime, which cl uses by default (and Chrome links). The system libraries
come from rustc's --print native-static-libs, kept beside the archive because a build with nothing to do prints none.
"""
from __future__ import annotations

import os
import pathlib
import shlex
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKSPACE = REPO / "packages/rust"
HEADERS = [REPO / "packages/adblock/include", WORKSPACE / "bay-import/include", WORKSPACE / "bay-lists/include",
           WORKSPACE / "bay-sync/include"]


def link_flags() -> tuple[pathlib.Path, list[str], list[pathlib.Path]]:
    """The archive, the system libraries it needs (as linker arguments) and the header folders."""
    windows = sys.platform == "win32"
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(pathlib.Path.home() / ".cargo/bin"), env.get("PATH", "")])
    if windows:
        env["RUSTFLAGS"] = "-C target-feature=+crt-static"
    built = subprocess.run(
        ["cargo", "rustc", "--locked", "--package", "bay-desktop", "--lib", "--crate-type", "staticlib", "--",
         "--print", "native-static-libs"],
        cwd=WORKSPACE, env=env, check=True, capture_output=True, text=True)
    directory = WORKSPACE / "target/debug"
    archive = directory / ("bay_desktop.lib" if windows else "libbay_desktop.a")
    remembered = directory / "bay_desktop.native-libs"
    for line in built.stderr.splitlines():
        if "native-static-libs:" in line:
            remembered.write_text(line.split("native-static-libs:", 1)[1].strip())
    if not remembered.exists():
        raise RuntimeError(f"no native library list for {archive}; remove {directory} and run again")
    libraries = shlex.split(remembered.read_text(), posix=not windows)
    return archive, libraries, HEADERS


if __name__ == "__main__":
    archive, libraries, includes = link_flags()
    print(" ".join(shlex.quote(str(part)) for part in [*[f"-I{path}" for path in includes], archive, *libraries]))
