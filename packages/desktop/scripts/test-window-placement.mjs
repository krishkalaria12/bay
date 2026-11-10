#!/usr/bin/env node
// Exercise WindowManager's production placement and frame observers with real AppKit windows.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shell = resolve(import.meta.dirname, "..");
const source = readFileSync(join(shell, "ios/Windows.swift"), "utf8");

const methods = ["isMainWindow", "id", "place", "observeFrame", "frameChanged", "sizeChanged", "reportFrame"].map((name) => {
  const method = source.match(new RegExp(`^  (?:@objc )?(?:private )?func ${name}\\([\\s\\S]*?^  }`, "m"));

  if (!method) throw new Error(`missing WindowManager.${name}`);

  return method[0].replace("private func", "func");
});

const properties = source.slice(0, source.indexOf("  private func isBrowserWindow"));
const root = mkdtempSync(join(tmpdir(), "bay-window-placement-"));

try {
  const main = join(root, "main.swift");
  writeFileSync(
    main,
    properties.replaceAll("private(set) ", "").replaceAll("private ", "") +
      methods.join("\n") +
      "\n  private func relayoutRoot(_ window: NSWindow) {}\n}\n" +
      readFileSync(join(shell, "tests/window-placement.swift"), "utf8"),
  );
  // A unique executable name isolates UserDefaults from Bay and other test runs.
  const binary = join(root, `window-placement-${root.split("-").at(-1)}`);
  execFileSync("swiftc", ["-o", binary, main], { stdio: "inherit" });
  execFileSync(binary, [], { stdio: "inherit" });
  execFileSync(binary, ["--restore"], { stdio: "inherit" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
