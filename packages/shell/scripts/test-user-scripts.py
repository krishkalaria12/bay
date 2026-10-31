#!/usr/bin/env python3
"""Exercise the production userscript reader in isolated temporary storage."""
from pathlib import Path
import subprocess
import tempfile

shell = Path(__file__).resolve().parents[1]
source = (shell / "ios/UserScripts.swift").read_text().replace("import ExpoModulesCore\n", "")
shim = """
enum ShellModule {
  static let root = URL(fileURLWithPath: CommandLine.arguments[1])
  static func documentURL(_ name: String) throws -> URL {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root.appendingPathComponent(name)
  }
}
"""
with tempfile.TemporaryDirectory(prefix="bay-user-scripts-test-") as temporary:
    root = Path(temporary)
    main = root / "main.swift"
    main.write_text(source + shim + (shell / "tests/user-scripts.swift").read_text())
    binary = root / "user-scripts-test"
    subprocess.run(["swiftc", "-o", str(binary), str(main)], check=True)
    subprocess.run([str(binary), str(root / "data")], check=True)
