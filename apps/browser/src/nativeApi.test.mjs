import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBrowserStore } from "./store/browser.ts";
import { createBrowserProjector } from "./runtime/projection.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// The bundle checks its version against the build's at launch; the two sides must move together.
test("the JS bundle and the native build declare the same API version", () => {
  const js = read("./nativeApi.tsx").match(/export const NATIVE_API_VERSION = (\d+);/)?.[1];
  const native = read("../../../packages/shell/ios/AppModule.swift").match(/Constant\("apiVersion"\) \{ \(\) -> Int in (\d+) \}/)?.[1];
  assert.ok(js && native, "both declarations found");
  assert.equal(js, native);
  const chrome = read("../../../engine/chromium/src/chrome/browser/bay/webui/native_host.cc").match(/Set\("apiVersion", (\d+)\)/)?.[1];
  assert.equal(js, chrome, "Chrome WebUI and macOS must expose the same application API");
});

test("the native runtime accepts every slice of the coordinator's current state schema", () => {
  const native = read("../../../engine/chromium/src/chrome/browser/bay/webui/runtime_state.cc");
  const fields = (name) => {
    const body = native.match(new RegExp(`${name}\\[\\]\\s*=\\s*\\{([^}]+)\\}`))?.[1];
    assert.ok(body, `${name} declaration found`);
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  };
  const state = createBrowserProjector()(createBrowserStore().getState());
  for (const [name, isList] of [["kRecords", false], ["kLists", true]]) {
    const expected = Object.keys(state).filter((key) => Array.isArray(state[key]) === isList).sort();
    assert.deepEqual(fields(name), expected, `${name} must match the published coordinator projection`);
  }
});
