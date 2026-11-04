#!/usr/bin/env node
// Test the native blocker without building Chromium, opening the app, or using a real profile.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const crate = join(root, "packages/adblock");
const env = { ...process.env };
env.DEVELOPER_DIR ??= "/Applications/Xcode.app/Contents/Developer";
execFileSync("cargo", ["build", "--locked", "--manifest-path", join(crate, "Cargo.toml")], { stdio: "inherit", env });
const library = join(env.CARGO_TARGET_DIR ?? join(crate, "target"), "debug");
const temporary = mkdtempSync(join(tmpdir(), "bay-content-blocker-test-"));
try {
  const binary = join(temporary, "content-blocker-test");
  execFileSync(
    "xcrun",
    [
      "clang++",
      "-std=c++20",
      "-fobjc-arc",
      "-fblocks",
      "-mmacosx-version-min=14.0",
      "-Wno-nullability-completeness",
      "-Wno-incomplete-implementation",
      "-Wno-objc-property-implementation",
      "-I",
      join(root, "engine/nncore/src/bay/core/public"),
      "-I",
      join(crate, "include"),
      "-I",
      join(root, "packages/chromium/ios"),
      join(root, "packages/chromium/tests/content-blocker.mm"),
      "-L",
      library,
      "-lbay_adblock",
      "-framework",
      "AppKit",
      "-framework",
      "QuartzCore",
      "-o",
      binary,
    ],
    { stdio: "inherit", env },
  );
  env.DYLD_LIBRARY_PATH = library;
  execFileSync(binary, [join(temporary, "data")], { stdio: "inherit", env });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
