#!/usr/bin/env python3
"""Exercise the production bookmark helper on macOS in isolated temporary storage."""
from pathlib import Path
import subprocess
import tempfile

shell = Path(__file__).resolve().parents[1]
source = (shell / "ios/LocalFiles.swift").read_text()
helper = source.split("public class LocalFilesModule:", 1)[0].replace("import ExpoModulesCore\n", "")
native_views = "final class LocalFilesArea:" + source.split("final class LocalFilesArea:", 1)[1]
shim = """
// Only the Expo event bridge and app-owned window registry are stubbed. NSView, pasteboards,
// NSDraggingInfo, the production LocalFilesArea handlers and bookmark code are real AppKit code.
class ExpoView: NSView {}
final class EventDispatcher {
  var events: [[String: Any]] = []
  func callAsFunction(_ event: [String: Any]) { events.append(event) }
}
final class WindowManager {
  static let shared = WindowManager()
  var windows: [String: NSWindow] = [:]
}
enum ShellModule {
  static func documentURL(_ name: String) throws -> URL {
    let root = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("native-access")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root.appendingPathComponent(name)
  }
}
"""
with tempfile.TemporaryDirectory(prefix="bay-local-files-test-") as temporary:
    root = Path(temporary)
    main = root / "main.swift"
    main.write_text(helper + shim + native_views + (shell / "tests/local-files.swift").read_text())
    binary = root / "local-files-test"
    subprocess.run(["swiftc", "-o", str(binary), str(main)], check=True)
    subprocess.run([str(binary), "seed", str(root)], check=True)
    subprocess.run([str(binary), "restore", str(root)], check=True)
