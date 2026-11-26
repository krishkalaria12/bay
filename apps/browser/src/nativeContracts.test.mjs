import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { nativeContracts } from "../../../packages/platform/src/nativeContracts.ts";
import { assertNativeStub } from "./test-native-stub.mjs";

test("every registered desktop native module and view has a written contract", () => {
  const registered = new Set();

  for (const name of ["desktop", "chromium", "shaders", "import", "sync"]) {
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

  assert.equal(registered.size, 37);
});

// What macOS doesn't register, and why. Anything else in a contract must be in a Swift module.
const WINDOWS_AND_LINUX = "Windows and Linux only: the WebUI host's own window, drag and sharing plumbing";

const MAC_ABSENT = {
  BayWebView: "the WebUI host's embedded tabs; macOS embeds native views",
  "BayShell.minimizeWindow": WINDOWS_AND_LINUX,
  "BayShell.toggleMaximizeWindow": WINDOWS_AND_LINUX,
  "BayShell.windowState": WINDOWS_AND_LINUX,
  "BayShell.windowButtonLayout": WINDOWS_AND_LINUX,
  "BayShell.setWindowCaption": WINDOWS_AND_LINUX,
  "BayShell.setKeyShortcuts": "macOS takes shortcuts from its menus",
  "BayApp.documentSpecks": WINDOWS_AND_LINUX,
  "BayEasel.requestShare": WINDOWS_AND_LINUX,
  "BayEasel.readImage": WINDOWS_AND_LINUX,
  "BayEasel.storeImage": WINDOWS_AND_LINUX,
  "BayEasel.saveDownload": WINDOWS_AND_LINUX,
  "BayLocalFiles.acceptDrop": WINDOWS_AND_LINUX,
  "BayLocalFiles.startDrag": WINDOWS_AND_LINUX,
  "BayCEF.startPageEvents": WINDOWS_AND_LINUX,
  "BayCEF.stopPageEvents": WINDOWS_AND_LINUX,
  "BayCEF.finishPageOpen": WINDOWS_AND_LINUX,
  "BayCEF.listDownloads": WINDOWS_AND_LINUX,
  "BayCEF.secretStorage": WINDOWS_AND_LINUX,
};

// The methods each macOS module declares (Expo's Function, AsyncFunction, Property and Constant).
function macMethods() {
  const methods = {};

  for (const name of ["desktop", "chromium", "shaders", "import", "sync"]) {
    const directory = new URL(`../../../packages/${name}/ios/`, import.meta.url);

    for (const file of readdirSync(directory).filter((file) => file.endsWith(".swift"))) {
      const parts = readFileSync(new URL(file, directory), "utf8").split(/^\s*Name\("(Bay\w+)"\)/m);

      for (let i = 1; i < parts.length; i += 2) {
        const declared = (methods[parts[i]] ??= new Set());

        for (const match of parts[i + 1].matchAll(/\b(?:(?:Async)?Function|Property|Constant)\("(\w+)"/g)) declared.add(match[1]);
      }
    }
  }

  return methods;
}

test("macOS registers every contract method it isn't known to lack", () => {
  const declared = macMethods();
  const absent = [];

  for (const [module, contract] of Object.entries(nativeContracts.modules)) {
    for (const [method, spec] of Object.entries(contract.methods ?? {})) {
      if (declared[module]?.has(method)) continue;

      const known = MAC_ABSENT[module] ?? MAC_ABSENT[`${module}.${method}`];
      assert.ok(known, `macOS has no ${module}.${method}${spec.optional ? "" : " (required)"}`);
      absent.push(MAC_ABSENT[module] ? module : `${module}.${method}`);
    }
  }
  // Each known absence is still absent: one macOS gains comes off the list.

  assert.deepEqual([...new Set(absent)].sort(), Object.keys(MAC_ABSENT).sort());
});

test("injected native stubs reject wrong method and constant shapes", () => {
  assert.throws(() => assertNativeStub("BayApp", { apiVersion: "8" }, { partial: true }), /apiVersion must be number/);
  assert.throws(() => assertNativeStub("BayShell", { openWindow: null }, { partial: true }), /openWindow must be a function/);
  assert.throws(() => assertNativeStub("BayApp", {}), /must be a function/);
  assert.throws(() => assertNativeStub("BayUnknown", {}), /Unknown native stub/);
  const stub = { openWindow: async () => {} };
  assert.equal(assertNativeStub("BayShell", stub, { partial: true }), stub);
});
