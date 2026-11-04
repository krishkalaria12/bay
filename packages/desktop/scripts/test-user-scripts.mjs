#!/usr/bin/env node
// Exercise the production userscript reader in isolated temporary storage.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shell = resolve(import.meta.dirname, "..");
const source = readFileSync(join(shell, "ios/UserScripts.swift"), "utf8").replaceAll("import ExpoModulesCore\n", "");
const shim = `
enum ShellModule {
  static let root = URL(fileURLWithPath: CommandLine.arguments[1])
  static func documentURL(_ name: String) throws -> URL {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root.appendingPathComponent(name)
  }
}
`;
const root = mkdtempSync(join(tmpdir(), "bay-user-scripts-test-"));
try {
  const main = join(root, "main.swift");
  writeFileSync(main, source + shim + readFileSync(join(shell, "tests/user-scripts.swift"), "utf8"));
  const binary = join(root, "user-scripts-test");
  execFileSync("swiftc", ["-o", binary, main], { stdio: "inherit" });
  execFileSync(binary, [join(root, "data")], { stdio: "inherit" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
