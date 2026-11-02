#!/usr/bin/env python3
"""Test the native blocker without building Chromium, opening the app, or using a real profile."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
crate = root / "packages/adblock"
env = os.environ.copy()
env.setdefault("DEVELOPER_DIR", "/Applications/Xcode.app/Contents/Developer")
subprocess.run(["cargo", "build", "--locked", "--manifest-path", str(crate / "Cargo.toml")], check=True, env=env)
library = Path(env.get("CARGO_TARGET_DIR", crate / "target")) / "debug"
with tempfile.TemporaryDirectory(prefix="bay-content-blocker-test-") as temporary:
    binary = Path(temporary) / "content-blocker-test"
    subprocess.run([
        "xcrun", "clang++", "-std=c++20", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=14.0",
        "-Wno-nullability-completeness", "-Wno-incomplete-implementation", "-Wno-objc-property-implementation",
        "-I", str(root / "engine/nncore/src/bay/core/public"),
        "-I", str(crate / "include"), "-I", str(root / "packages/chromium/ios"),
        str(root / "packages/chromium/tests/content-blocker.mm"),
        "-L", str(library), "-lbay_adblock", "-framework", "AppKit", "-framework", "QuartzCore",
        "-o", str(binary),
    ], check=True, env=env)
    env["DYLD_LIBRARY_PATH"] = str(library)
    subprocess.run([str(binary), str(Path(temporary) / "data")], check=True, env=env)
