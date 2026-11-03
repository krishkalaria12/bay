#!/usr/bin/env python3
"""Test the production card renderer and pasteboard formats using real AppKit."""
from pathlib import Path
import subprocess
import sys
import tempfile

shell = Path(__file__).resolve().parents[1]
source = (shell / "ios/QuoteCard.swift").read_text()
module = (shell / "ios/ShellModule.swift").read_text()
color = "extension NSColor {" + module.split("extension NSColor {", 1)[1].split("\nlet installTextFieldSelectAll", 1)[0]
with tempfile.TemporaryDirectory(prefix="bay-quote-test-") as temporary:
    root = Path(temporary)
    main = root / "main.swift"
    main.write_text(source + "\n" + color + "\n" + (shell / "tests/quote-card.swift").read_text())
    binary = root / "quote-card-test"
    subprocess.run(["swiftc", "-o", str(binary), str(main)], check=True)
    subprocess.run([str(binary), *sys.argv[1:]], check=True)
