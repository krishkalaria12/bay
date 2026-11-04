// Exercise layer lookup and freshness failures without touching the shared Chromium tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("layers and stale framework", () => {
  const layers = readFileSync(path.join(ROOT, "engine/patches/series"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("layer "))
    .map((line) => line.trim().split(/\s+/)[2]);
  for (const layer of layers) assert.ok(statSync(path.join(ROOT, layer, "apply.sh")).isFile(), layer);
  const root = mkdtempSync(path.join(tmpdir(), "bay-engine-fresh-test-"));
  try {
    const helper = path.join(root, "scripts/lib/engine-fresh.sh");
    mkdirSync(path.dirname(helper), { recursive: true });
    copyFileSync(path.join(ROOT, "scripts/lib/engine-fresh.sh"), helper);
    for (const layer of layers) {
      const apply = path.join(root, layer, "apply.sh");
      mkdirSync(path.dirname(apply), { recursive: true });
      writeFileSync(apply, '#!/bin/sh\n[ "$1" = --check ] && [ ! -f "$0.fail" ]\n');
      chmodSync(apply, 0o755);
    }
    const source = path.join(root, "chromium");
    mkdirSync(path.join(source, "bay"), { recursive: true });
    mkdirSync(path.join(source, "chrome/browser/bay"), { recursive: true });
    const binary = path.join(root, "framework/Versions/Current/Chromium Framework");
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "");
    const check = () => {
      const result = spawnSync("bash", [helper, path.join(root, "framework"), source], { encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.signal, null);
      return result;
    };
    assert.equal(check().status, 0);
    for (const layer of layers) {
      const marker = path.join(root, layer, "apply.sh.fail");
      writeFileSync(marker, "");
      const result = check();
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`tree differs from ${layer}`), result.stderr);
      unlinkSync(marker);
    }
    writeFileSync(path.join(source, "bay/changed.cc"), "");
    utimesSync(binary, 1, 1);
    const result = check();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("newer than the framework"), result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
