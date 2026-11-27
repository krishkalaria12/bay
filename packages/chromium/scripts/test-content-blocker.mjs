#!/usr/bin/env node
// Test the native blocker without building Chromium, opening the app, or using a real profile.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const crate = join(root, "packages/adblock");
const workspace = join(root, "packages/rust");
const env = { ...process.env };

env.DEVELOPER_DIR ??= "/Applications/Xcode.app/Contents/Developer";

// As the app's Rust build (rust.sh), so the archive matches the test binary's deployment target.
env.MACOSX_DEPLOYMENT_TARGET ??= "14.0";

// The app links the desktop library (bay-desktop: the blocker and its lists); so does the test.
execFileSync("cargo", ["build", "--locked", "--package", "bay-desktop", "--manifest-path", join(workspace, "Cargo.toml")], {
  stdio: "inherit",
  env,
});

const library = join(env.CARGO_TARGET_DIR ?? join(workspace, "target"), "debug");
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
      join(workspace, "bay-lists/include"),
      "-I",
      join(root, "packages/chromium/ios"),
      join(root, "packages/chromium/tests/content-blocker.mm"),
      "-L",
      library,
      "-lbay_desktop",
      "-framework",
      "AppKit",
      "-framework",
      "QuartzCore",
      "-o",
      binary,
    ],
    { stdio: "inherit", env },
  );
  execFileSync(binary, [join(temporary, "data")], { stdio: "inherit", env });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
