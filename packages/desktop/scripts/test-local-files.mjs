#!/usr/bin/env node
// Exercise the production bookmark helper on macOS in isolated temporary storage.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shell = resolve(import.meta.dirname, "..");
const source = readFileSync(join(shell, "ios/LocalFiles.swift"), "utf8");
const helper = source.split("public class LocalFilesModule:")[0].replaceAll("import ExpoModulesCore\n", "");
const nativeViewsStart = source.indexOf("final class LocalFilesArea:");
if (nativeViewsStart < 0) throw new Error("missing LocalFilesArea in LocalFiles.swift");
const nativeViews = source.slice(nativeViewsStart);
const shim = `
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
`;
const root = mkdtempSync(join(tmpdir(), "bay-local-files-test-"));
try {
  const main = join(root, "main.swift");
  writeFileSync(main, helper + shim + nativeViews + readFileSync(join(shell, "tests/local-files.swift"), "utf8"));
  const binary = join(root, "local-files-test");
  execFileSync("swiftc", ["-o", binary, main], { stdio: "inherit" });
  execFileSync(binary, ["seed", root], { stdio: "inherit" });
  execFileSync(binary, ["restore", root], { stdio: "inherit" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
