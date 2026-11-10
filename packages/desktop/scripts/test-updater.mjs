#!/usr/bin/env node
// Check channel changes against the production updater and real Sparkle framework.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shell = resolve(import.meta.dirname, "..");
const frameworks = resolve(shell, "../../apps/browser/macos/Pods/Sparkle");
const root = mkdtempSync(join(tmpdir(), "bay-updater-test-"));

try {
  const main = join(root, "main.swift");
  writeFileSync(main, readFileSync(join(shell, "ios/Updater.swift"), "utf8") + readFileSync(join(shell, "tests/updater.swift"), "utf8"));
  const binary = join(root, "updater-test");
  execFileSync("swiftc", ["-F", frameworks, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", frameworks, "-o", binary, main], {
    stdio: "inherit",
  });
  execFileSync(binary, [], { stdio: "inherit" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
