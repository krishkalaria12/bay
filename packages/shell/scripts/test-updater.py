#!/usr/bin/env python3
"""Check channel changes against the production updater and real Sparkle framework."""
from pathlib import Path
import subprocess
import tempfile

shell = Path(__file__).resolve().parents[1]
frameworks = shell.parents[1] / "apps/browser/macos/Pods/Sparkle"
with tempfile.TemporaryDirectory(prefix="bay-updater-test-") as temporary:
    root = Path(temporary)
    main = root / "main.swift"
    main.write_text((shell / "ios/Updater.swift").read_text() + (shell / "tests/updater.swift").read_text())
    binary = root / "updater-test"
    subprocess.run([
        "swiftc", "-F", str(frameworks), "-framework", "Sparkle",
        "-Xlinker", "-rpath", "-Xlinker", str(frameworks), "-o", str(binary), str(main),
    ], check=True)
    subprocess.run([str(binary)], check=True)
