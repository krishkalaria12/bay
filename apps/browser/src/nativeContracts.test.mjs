import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { nativeContracts } from "../../../packages/platform/src/nativeContracts.ts";
import { assertNativeStub } from "./test-native-stub.mjs";

test("every registered desktop native module and view has a written contract", () => {
  const registered = new Set();
  for (const name of ["shell", "nncore", "shaders", "import", "sync"]) {
    const directory = new URL(`../../../packages/${name}/ios/`, import.meta.url);
    const config = JSON.parse(readFileSync(new URL(`../../../packages/${name}/expo-module.config.json`, import.meta.url), "utf8"));
    assert.deepEqual(config.platforms, ["apple"]);
    assert.ok(config.apple.modules.length);
    for (const file of readdirSync(directory).filter((file) => file.endsWith(".swift"))) {
      for (const match of readFileSync(new URL(file, directory), "utf8").matchAll(/^\s*Name\("(Bay\w+)"\)/gm)) {
        registered.add(match[1]);
        assert.ok(nativeContracts.modules[match[1]] || nativeContracts.views[match[1]], `${match[1]} has no typed contract`);
      }
    }
  }
  assert.equal(registered.size, 32);
});
test("injected native stubs reject wrong method and constant shapes", () => {
  assert.throws(() => assertNativeStub("BayApp", { apiVersion: "8" }, { partial: true }), /apiVersion must be number/);
  assert.throws(() => assertNativeStub("BayShell", { openWindow: null }, { partial: true }), /openWindow must be a function/);
  assert.throws(() => assertNativeStub("BayApp", {}), /must be a function/);
  assert.throws(() => assertNativeStub("BayUnknown", {}), /Unknown native stub/);
  const stub = { openWindow: async () => {} };
  assert.equal(assertNativeStub("BayShell", stub, { partial: true }), stub);
});
