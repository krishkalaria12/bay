import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

// The native apps run these scripts from packages/mobile-pagescripts' resource file, so it has to match them.
test("the native apps' page-script resource matches src/pagescripts", () => {
  const build = join(import.meta.dirname, "../../../packages/mobile-pagescripts/scripts/build.mjs");
  const result = spawnSync(process.execPath, ["--no-warnings", build, "--check"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});
