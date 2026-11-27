import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

// The apps run these scripts from resources/pagescripts.json, so it has to match src.
test("resources/pagescripts.json matches src", () => {
  const build = join(import.meta.dirname, "../scripts/build.mjs");
  const result = spawnSync(process.execPath, ["--no-warnings", build, "--check"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
});
