import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

if (!process.env.BAY_PLACEMENT_CHILD) {
  for (const [platform, coordinates] of [
    ["macos", true],
    ["windows", true],
    ["linux", true],
    ["linux", false],
  ]) {
    test(`${platform} coordinates=${coordinates}: placement and session policy`, () => {
      const env = { ...process.env, BAY_PLACEMENT_CHILD: "1", BAY_TEST_PLATFORM: platform, BAY_TEST_GLOBAL_COORDINATES: String(coordinates) };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--test", "src/lib/windowPlacement.test.mjs"], {
        cwd: new URL("../../", import.meta.url),
        env,
        encoding: "utf8",
      });
      assert.match(output, /fail 0\n/);
      assert.match(output, /pass [1-9]\d*\n/);
    });
  }
} else {
  const { capabilities } = await import("../test-platform-stub.mjs");
  const { createBrowserStore } = await import("../store/browser.ts");
  const { activeTabId } = await import("../store/model.ts");
  const { nativeWindowPlacement, restorableWindow, restorableClosedWindow, restoredWindowPlacement } = await import("../store/windowPlacement.ts");
  const { createPersistence, loadSession } = await import("./persist.ts");
  const { startWindowPlacementSync } = await import("./windowPlacementSync.ts");
  const { createNativeWindowReconciler } = await import("./nativeWindows.ts");
  const { docs, captionState, emitWindowEvent, windowEventListeners } = await import("../test-native-stub.mjs");
  const global = capabilities.globalWindowCoordinates;
  const frame = [300, -200, 1100, 750];
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const setup = () => {
    const store = createBrowserStore();
    const id = store.getState().createWindow({ frame, url: "https://restore.example/" });
    return { store, id };
  };
  const save = async (store) => {
    const owner = createPersistence({ store, restoreSession: false });
    try {
      await owner.flush({ final: true });
    } finally {
      owner.dispose();
    }
    return JSON.parse(docs.get("session.json"));
  };

  test("create and reopen retain frame on global hosts and only size/maximized otherwise", () => {
    const { store, id } = setup();
    if (!global) store.getState().setWindowPlacement(id, { size: [1000, 700], maximized: true, fullscreen: true, x: 999 });
    const w = store.getState().windows[id];
    assert.deepEqual(nativeWindowPlacement(w), global ? { frame } : { size: [1000, 700], maximized: true });
    store.getState().closeWindow(id);
    const closed = store.getState().closedWindows.at(-1);
    assert.deepEqual(closed.window.frame, global ? frame : null);
    store.getState().reopenClosedWindow();
    const reopened = store.getState().windows[store.getState().windowOrder.at(-1)];
    assert.deepEqual(nativeWindowPlacement(reopened), global ? { frame } : { size: [1000, 700], maximized: true });
    assert.equal("fullscreen" in reopened, false);
    assert.equal("x" in reopened, false);
  });

  test("v2 load converts legacy frames and filters placement keys, preserving legacy tab order", async () => {
    const { store, id } = setup();
    const initial = activeTabId(store.getState(), id);
    const second = store.getState().newTab(id, { url: "https://second.example/" });
    const saved = await save(store);
    const legacy = {
      ...saved.windows[0],
      frame,
      size: [0, 200],
      maximized: true,
      fullscreen: true,
      minimized: true,
      position: [99, 88],
      placement: { x: 77 },
      tabIds: [second, initial],
    };
    saved.windows = [legacy];
    saved.tabLists = {};
    saved.closedWindows = [{ kind: "window", id: "closed", window: { ...legacy, shownTabId: initial }, tabs: [], groups: [], closedAt: 1 }];
    docs.set("session.json", JSON.stringify(saved));
    const loaded = loadSession();
    const w = loaded.windows[id];
    assert.deepEqual(w.frame, global ? frame : null);
    if (!global) {
      assert.deepEqual(w.size, [1100, 750]);
      assert.equal(w.maximized, true);
      for (const key of ["fullscreen", "minimized", "position", "placement"]) {
        assert.equal(key in w, false);
        assert.equal(key in loaded.closedWindows[0].window, false);
      }
    }
    const restored = createBrowserStore();
    restored.getState().hydrate(loaded);
    const ids = Object.values(restored.getState().tabLists).flat();
    assert.ok(ids.indexOf(second) < ids.indexOf(initial));
    const disk = await save(restored);
    assert.equal(disk.version, 2);
    if (!global) {
      assert.equal(disk.windows[0].frame, null);
      assert.deepEqual(disk.windows[0].size, [1100, 750]);
      assert.equal(disk.windows[0].maximized, true);
      assert.equal("fullscreen" in disk.windows[0], false);
      assert.equal("minimized" in disk.windows[0], false);
      assert.equal(disk.closedWindows[0].window.frame, null);
    }
  });

  test("malformed and sparse size tuples are never restored or forwarded", () => {
    for (const size of [[0, 1], [-1, 1], [1, Infinity], [1, NaN], [1, "2"], [1], [1, 2, 3], Array(2), null, { width: 1, height: 2 }]) {
      assert.deepEqual(restoredWindowPlacement({ frame: null, size, maximized: "true" }), {});
      assert.deepEqual(restoredWindowPlacement({ frame, size }), { size: [1100, 750] });
    }
    const { store, id } = setup();
    const w = store.getState().windows[id];
    if (global) {
      assert.strictEqual(restorableWindow(w), w);
      assert.strictEqual(restorableClosedWindow(w), w);
    } else {
      store.getState().setWindowFrame(id, [999, 888, 1, 1]);
      assert.deepEqual(store.getState().windows[id].size, [1100, 750]);
      assert.equal(store.getState().windows[id].frame, null);
      store.getState().setWindowPlacement(id, { size: [-1, 10], maximized: "true", minimized: true });
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1100, 750] });
    }
  });

  test("disabling session restore parks size/maximized without coordinates", async () => {
    const { store, id } = setup();
    if (!global) store.getState().setWindowPlacement(id, { size: [900, 600], maximized: true });
    store.getState().updateSettings({ restoreSession: false });
    await save(store);
    const loaded = loadSession();
    assert.deepEqual(loaded.windows, {});
    const parked = loaded.closedWindows.at(-1).window;
    assert.deepEqual(parked.frame, global ? frame : null);
    if (!global) assert.deepEqual(nativeWindowPlacement(parked), { size: [900, 600], maximized: true });
  });

  for (const shared of [false, true]) {
    test(`${shared ? "shared coordinator" : "local authority"} FakeNative opens using supported placement and bootstraps after acknowledgement`, async (t) => {
      const { store, id } = setup();
      const sync = startWindowPlacementSync(store);
      t.after(() => sync.dispose());
      const open = deferred(),
        query = deferred(),
        calls = [];
      captionState.query = (windowId) => {
        calls.push(["query", windowId]);
        assert.ok(windowEventListeners.size);
        return query.promise;
      };
      const native = createNativeWindowReconciler({
        open: async (windowId, options) => {
          calls.push(["open", windowId, options]);
          await open.promise;
          sync.opened(windowId);
        },
        close() {},
        setTitle() {},
        focus() {},
        openFailed() {},
        closed() {},
        report: (_op, _id, error) => {
          throw error;
        },
      });
      t.after(() => native.dispose());
      const reconcile = () => native.sync([{ id, title: "test", options: nativeWindowPlacement(store.getState().windows[id]) }], id);
      // Shared authority reconciliation is driven by accepted commits; local authority subscribes directly.
      const stop = shared ? () => {} : store.subscribe(reconcile);
      t.after(stop);
      reconcile();
      assert.deepEqual(calls, [["open", id, global ? { frame } : { size: [1100, 750] }]]);
      open.resolve();
      await settle();
      assert.equal(calls.filter(([op]) => op === "query").length, global ? 0 : 1);
      query.resolve({ maximized: true, fullscreen: false, size: [800, 500] });
      await settle();
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), global ? { frame } : { size: [800, 500], maximized: true });
    });
  }

  if (!global) {
    test("events before/during bootstrap win, including maximized->fullscreen/minimized", async (t) => {
      const { store, id } = setup();
      const sync = startWindowPlacementSync(store);
      t.after(() => sync.dispose());
      const query = deferred();
      captionState.query = () => query.promise;
      sync.opened(id);
      emitWindowEvent({ type: "state", id: "other", maximized: false, fullscreen: false, size: [1, 1] });
      emitWindowEvent({ type: "state", id, maximized: true, fullscreen: false, size: [1000, 700] });
      for (const transient of [{ fullscreen: true }, { minimized: true }]) {
        emitWindowEvent({ type: "state", id, maximized: false, fullscreen: false, size: [1900, 1000], ...transient });
        assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1000, 700], maximized: true });
      }
      query.resolve({ maximized: false, fullscreen: false, size: [800, 500] });
      await settle();
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1000, 700], maximized: true });
      const saved = await save(store);
      assert.deepEqual(saved.windows[0].size, [1000, 700]);
      assert.equal(saved.windows[0].maximized, true);
      assert.equal("minimized" in saved.windows[0], false);
      emitWindowEvent({ type: "state", id, maximized: false, fullscreen: false, size: [900, 650] });
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [900, 650], maximized: false });
      // Events during native open precede the post-open bootstrap call too.
      captionState.query = () => {
        throw new Error("event already supplied placement");
      };
      sync.opened(id);
    });

    test("closing/removing windows and teardown invalidate pending queries and old listeners", async () => {
      for (const action of ["close", "remove", "dispose"]) {
        const { store, id } = setup();
        const before = windowEventListeners.size;
        const sync = startWindowPlacementSync(store);
        const listener = [...windowEventListeners].at(-1);
        const query = deferred();
        captionState.query = () => query.promise;
        sync.opened(id);
        if (action === "close") emitWindowEvent({ type: "close", id });
        if (action === "remove") store.getState().closeWindow(id);
        if (action === "dispose") sync.dispose();
        query.resolve({ maximized: true, fullscreen: false, size: [800, 500] });
        await settle();
        if (action !== "remove") assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1100, 750] });
        sync.dispose();
        sync.dispose();
        listener({ type: "state", id, maximized: true, fullscreen: false, size: [800, 500] });
        assert.equal(windowEventListeners.size, before);
      }
    });

    test("failed bootstrap leaves state events live and legacy hosts may omit optional flags/size", async (t) => {
      const { store, id } = setup();
      const sync = startWindowPlacementSync(store);
      t.after(() => sync.dispose());
      captionState.query = () => Promise.reject(new Error("not available"));
      sync.opened(id);
      await settle();
      emitWindowEvent({ type: "state", id, maximized: true, fullscreen: false });
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1100, 750], maximized: true });
      emitWindowEvent({ type: "state", id, maximized: false, fullscreen: false, size: [0, 400], unknown: true });
      assert.deepEqual(nativeWindowPlacement(store.getState().windows[id]), { size: [1100, 750], maximized: true });
    });
  }
}
