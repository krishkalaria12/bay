import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

process.env.BAY_TEST_PLATFORM = "windows";
globalThis.__DEV__ = false;
const native = new URL("../../test-native-stub.mjs", import.meta.url).href;
const motion =
  "data:text/javascript," +
  encodeURIComponent(`
export const makeMutable = (initial) => { let value = initial; return {get: () => value, set: (next) => {value = next;}}; };
export const withTiming = (value) => value;
export const Easing = {out: (value) => value, cubic: (value) => value};
export const Extrapolation = {CLAMP: 0};
export const interpolate = () => 0;
export const useAnimatedStyle = (update) => update();
`);
registerHooks({
  load(url, context, next) {
    if (url.endsWith("/spacePager.ts"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
          .outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
  resolve(specifier, context, next) {
    if (specifier === "@bay/platform/motion") return { url: motion, shortCircuit: true };
    if (specifier === "@bay/nncore" && context.parentURL?.endsWith("/spacePager.ts"))
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(`
export * from ${JSON.stringify(native)};
export const switchPager = async () => { throw new Error("a nonnative click must dispatch directly"); };
export const stepPager = async () => false;
export const selectPager = async () => false;
export const pagerState = () => null;
`),
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { createBrowserStore } = await import("../../store/browser.ts");
const { installBrowserReadSource, createLocalBrowserReadSource } = await import("../../store/read.ts");
const { createLocalBrowserCommands, installBrowserCommands } = await import("../../runtime/commands.ts");
const { pagerFor } = await import("./spacePager.ts");

test("mounted web sidebar switches canonical space and reconciles its visual pager position", () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow();
  const spaceId = store.getState().createSpace({ name: "Second" });
  const removeRead = installBrowserReadSource(createLocalBrowserReadSource(store));
  const removeCommands = installBrowserCommands(createLocalBrowserCommands(store));
  const pager = pagerFor(windowId);
  const detach = pager.attach();
  try {
    assert.equal(pager.active, false);
    pager.switchTo(spaceId);
    assert.equal(store.getState().windows[windowId].spaceId, spaceId);
    assert.equal(pager.pos.get(), store.getState().spaceOrder.indexOf(spaceId));
    const original = store.getState().spaceOrder[0];
    store.getState().switchSpace(windowId, original);
    assert.equal(pager.pos.get(), 0);
  } finally {
    detach();
    store.getState().closeWindow(windowId);
    removeCommands();
    removeRead();
  }
});

test("web wheel input crosses the existing pager threshold once per cooldown", async () => {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow();
  const next = store.getState().createSpace({ name: "Second" });
  store.getState().createSpace({ name: "Third" });
  const removeRead = installBrowserReadSource(createLocalBrowserReadSource(store));
  const removeCommands = installBrowserCommands(createLocalBrowserCommands(store));
  const pager = pagerFor(windowId);
  const detach = pager.attach();
  const wheel = () => pager.wheel({ phase: "wheel", direction: "forward", distance: 0.5, dy: 0, velocity: 0, available: true, width: 300 });
  try {
    wheel();
    wheel();
    assert.notEqual(store.getState().windows[windowId].spaceId, next);
    wheel();
    await new Promise(setImmediate);
    assert.equal(store.getState().windows[windowId].spaceId, next);
    for (let i = 0; i < 20; i++) wheel();
    await new Promise(setImmediate);
    assert.equal(store.getState().windows[windowId].spaceId, next);
    assert.equal(pager.pos.get(), store.getState().spaceOrder.indexOf(next));
  } finally {
    detach();
    store.getState().closeWindow(windowId);
    removeCommands();
    removeRead();
  }
});
