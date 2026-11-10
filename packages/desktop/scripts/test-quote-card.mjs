#!/usr/bin/env node
// Test the production card renderer and pasteboard formats using real AppKit.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const shell = resolve(import.meta.dirname, "..");
const source = readFileSync(join(shell, "ios/QuoteCard.swift"), "utf8");
const module = readFileSync(join(shell, "ios/ShellModule.swift"), "utf8");
const colorStart = module.indexOf("extension NSColor {");

if (colorStart < 0) throw new Error("missing NSColor extension in ShellModule.swift");

const color = module.slice(colorStart).split("\nlet installTextFieldSelectAll")[0];
const root = mkdtempSync(join(tmpdir(), "bay-quote-test-"));

try {
  const main = join(root, "main.swift");
  writeFileSync(main, source + "\n" + color + "\n" + readFileSync(join(shell, "tests/quote-card.swift"), "utf8"));
  const binary = join(root, "quote-card-test");
  execFileSync("swiftc", ["-o", binary, main], { stdio: "inherit" });
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
