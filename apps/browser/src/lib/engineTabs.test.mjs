import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browserStore.ts";
import { activeTabId } from "../store/model.ts";

const tick = () => new Promise(setImmediate);
function fixture({ held = false } = {}) {
  const store = createBrowserStore();
  const windowId = store.getState().createWindow({ url: "first.example" });
  const first = activeTabId(store.getState(), windowId);
  const second = store.getState().newTab(windowId, { url: "https://second.example", background: true });
  store.getState().activate(first, windowId);
  let listener;
  let resolve;
  const commands = [];
  const strip = (active = first) => ({
    strip: 1,
    window: 1,
    appWindow: windowId,
    profile: "",
    tabs: [first, second].map((key, index) => ({ key, browser: index + 1, index, active: key === active, pinned: false, group: null })),
    groups: [],
  });
  const snapshot = { rev: 0, cmd: null, strips: [strip()] };
  const engine = {
    listeners: 0,
    listen(callback) {
      listener = callback;
      engine.listeners++;
      return {
        remove: () => {
          engine.listeners--;
        },
      };
    },
    snapshot: () =>
      held
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(snapshot),
    command: (command) => {
      commands.push(command);
      return commands.length;
    },
  };
  globalThis.nnTestTabStrip = engine;
  return {
    store,
    windowId,
    first,
    second,
    commands,
    engine,
    finish: () => resolve(snapshot),
    activate: (key, rev = 1) => listener({ rev, cmd: null, strips: [strip(key)] }),
  };
}

globalThis.__DEV__ = false;
const { startChromeTabs } = await import("./engineTabs.ts");

test("the coordinator mirror writes its supplied authority and removes its subscriptions", async () => {
  const f = fixture();
  const legacy = useBrowser.getState();
  const stop = startChromeTabs({ store: f.store, shared: true });
  assert.equal(startChromeTabs({ store: f.store, shared: true }), stop);
  assert.equal(f.engine.listeners, 1);
  await tick();
  f.activate(f.second);
  assert.equal(activeTabId(f.store.getState(), f.windowId), f.second);
  assert.equal(useBrowser.getState(), legacy);
  stop();
  stop();
  assert.equal(f.engine.listeners, 0);
  f.activate(f.first, 2);
  assert.equal(activeTabId(f.store.getState(), f.windowId), f.second);
  const count = f.commands.length;
  f.store.getState().activate(f.first, f.windowId);
  await tick();
  assert.equal(f.commands.length, count);
});

test("a disposed mirror ignores a late snapshot and a replacement can start", async () => {
  const f = fixture({ held: true });
  const stop = startChromeTabs({ store: f.store, shared: true });
  f.activate(f.second);
  stop();
  f.finish();
  await tick();
  assert.equal(activeTabId(f.store.getState(), f.windowId), f.first);
  assert.equal(f.engine.listeners, 0);
  const next = startChromeTabs({ store: f.store, shared: true });
  assert.notEqual(next, stop);
  assert.equal(f.engine.listeners, 1);
  f.activate(f.second);
  f.finish();
  await tick();
  assert.equal(activeTabId(f.store.getState(), f.windowId), f.second);
  next();
});
