import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Each platform's own words: the platform is bound when the module loads, so each one gets its own process.
const wordsOn = (platform) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "./src/test-loader.mjs",
        "--input-type=module",
        "-e",
        'console.log(JSON.stringify((await import("./src/lib/platformWords.ts")).platformWords))',
      ],
      { env: { ...process.env, BAY_TEST_PLATFORM: platform }, encoding: "utf8" },
    ),
  );

test("Linux and Windows never name the other's file manager, or a Mac", () => {
  const linux = wordsOn("linux");
  const windows = wordsOn("windows");
  assert.equal(linux.osName, "Linux");
  assert.equal(windows.osName, "Windows");
  assert.doesNotMatch(JSON.stringify(linux), /Mac|Finder|File Explorer|Windows/);
  assert.doesNotMatch(JSON.stringify(windows), /Mac|Finder|Linux/);
});

test("macOS keeps its own words", () => {
  const mac = wordsOn("macos");
  assert.equal(mac.revealTitle, "Show in Finder");
  assert.equal(mac.thisComputer, "this Mac");
});
