import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTabId } from "../store/model.ts";
import { createBrowserStore } from "../store/browser.ts";
import { createNativeWindowReconciler } from "./nativeWindows.ts";

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function harness({ syncOpen = false, throwOpen = false, holdClose = false } = {}) {
  const store = createBrowserStore();
  const pending = new Map();
  const pendingClose = new Map();
  const calls = [];
  const native = new Set();
  const errors = [];
  const reconciler = createNativeWindowReconciler({
    open(id, options) {
      calls.push(["open", id, options]);
      if (throwOpen) throw new Error("cannot create");
      if (syncOpen) {
        native.add(id);
        return;
      }
      const held = deferred();
      pending.set(id, held);
      return held.promise.then(() => {
        native.add(id);
      });
    },
    close(id) {
      calls.push(["close", id]);
      if (!holdClose) {
        native.delete(id);
        return;
      }
      const held = deferred();
      pendingClose.set(id, held);
      return held.promise.then(() => {
        native.delete(id);
      });
    },
    setTitle(id, title) {
      calls.push(["title", id, title]);
    },
    focus(id) {
      calls.push(["focus", id]);
    },
    openFailed(id) {
      store.getState().closeWindow(id);
    },
    closed(id, options) {
      calls.push(["release", id, options.incognito]);
    },
    report(operation, id, error) {
      errors.push([operation, id, error]);
    },
  });
  const sync = () => {
    const s = store.getState();
    const focused = s.ui.focusedWindowId;
    const order = s.windowOrder.filter((id) => id !== focused);
    if (focused && s.windows[focused]) order.push(focused);
    reconciler.sync(
      order.map((id) => {
        const w = s.windows[id];
        const title = s.tabs[w.activeTabIds[w.spaceId]]?.title ?? "";
        return { id, title, options: { incognito: w.incognito, title, focus: id === focused } };
      }),
      focused,
    );
  };
  const stop = store.subscribe(sync);
  return { store, pending, pendingClose, calls, native, errors, reconciler, sync, stop };
}

test("held opens dispatch once and close after acknowledgement when removed from the store", async (t) => {
  const h = harness({ holdClose: true });
  t.after(h.stop);
  const id = h.store.getState().createWindow({ incognito: true });
  h.store.getState().updateSettings({ appearance: "dark" });
  h.sync();
  assert.equal(h.calls.filter(([method]) => method === "open").length, 1);
  h.store.getState().closeWindow(id);
  assert.equal(h.calls.filter(([method]) => method === "close").length, 0);
  assert.equal(h.calls.filter(([method]) => method === "release").length, 0);
  h.pending.get(id).resolve();
  await settle();
  assert.equal(h.calls.filter(([method]) => method === "close").length, 1);
  assert.equal(h.calls.filter(([method]) => method === "release").length, 0);
  h.pendingClose.get(id).resolve();
  await settle();
  assert.deepEqual(h.calls.slice(-2), [
    ["close", id],
    ["release", id, true],
  ]);
  assert.deepEqual([...h.native], h.store.getState().windowOrder);
});

test("rejected opens remove invisible windows, clean up once and never retry on store updates", async (t) => {
  const h = harness();
  t.after(h.stop);
  const id = h.store.getState().createWindow({ url: "https://recoverable.example/" });
  h.pending.get(id).reject(new Error("native unavailable"));
  await settle();
  assert.equal(h.store.getState().windows[id], undefined);
  assert.deepEqual([...h.native], h.store.getState().windowOrder);
  const state = h.store.getState();
  const closed = state.closedWindows.at(-1);
  assert.equal(state.tabs[closed.window.shownTabId].url, "https://recoverable.example/");
  assert.ok(state.tabLists[closed.window.spaceId].includes(closed.window.shownTabId));
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0], "open");
  h.store.getState().updateSettings({ appearance: "dark" });
  h.sync();
  assert.equal(h.calls.filter(([method]) => method === "open").length, 1);
  assert.equal(h.calls.filter(([method]) => method === "close").length, 1);
});

test("synchronous native returns and throws follow the same acknowledgement path", async (t) => {
  const success = harness({ syncOpen: true });
  const failure = harness({ throwOpen: true });
  t.after(success.stop);
  t.after(failure.stop);
  const id = success.store.getState().createWindow();
  const failed = failure.store.getState().createWindow();
  await settle();
  assert.deepEqual([...success.native], [id]);
  success.store.getState().closeWindow(id);
  await settle();
  assert.deepEqual([...success.native], []);
  assert.equal(failure.store.getState().windows[failed], undefined);
  assert.equal(failure.errors[0][2].message, "cannot create");
});

test("an acknowledged open receives the latest title and repairs stale requested focus", async (t) => {
  const h = harness();
  t.after(h.stop);
  const first = h.store.getState().createWindow();
  const firstTab = activeTabId(h.store.getState(), first);
  h.store.getState().updateTab(firstTab, { title: "Latest title" });
  const second = h.store.getState().createWindow();
  h.pending.get(second).resolve();
  await settle();
  h.pending.get(first).resolve();
  await settle();
  assert.ok(h.calls.some((call) => call[0] === "title" && call[1] === first && call[2] === "Latest title"));
  assert.deepEqual(h.calls.at(-1), ["focus", second]);
  assert.equal(h.store.getState().ui.focusedWindowId, second);
});

test("native close before held creation cannot release its profile early or resurrect the window", async (t) => {
  const h = harness({ holdClose: true });
  t.after(h.stop);
  const id = h.store.getState().createWindow({ incognito: true });
  h.reconciler.nativeClosed(id);
  h.store.getState().closeWindow(id);
  assert.equal(h.calls.filter(([method]) => method === "release").length, 0);
  h.pending.get(id).resolve();
  await settle();
  assert.equal(h.calls.filter(([method]) => method === "close").length, 1);
  assert.equal(h.calls.filter(([method]) => method === "release").length, 0);
  h.pendingClose.get(id).resolve();
  await settle();
  assert.equal(h.calls.filter(([method]) => method === "release").length, 1);
  assert.deepEqual([...h.native], h.store.getState().windowOrder);
});

test("a desired ID restored while closing reopens only after the successful close without another store change", async (t) => {
  const h = harness({ holdClose: true });
  t.after(h.stop);
  const id = h.store.getState().createWindow();
  h.pending.get(id).resolve();
  await settle();
  const previous = h.store.getState();
  h.store.getState().closeWindow(id);
  h.store.setState({ windows: previous.windows, windowOrder: previous.windowOrder, tabs: previous.tabs, ui: previous.ui });
  assert.equal(h.calls.filter(([method]) => method === "open").length, 1);
  h.pendingClose.get(id).resolve();
  await settle();
  assert.equal(h.calls.filter(([method]) => method === "open").length, 2);
  h.pending.get(id).resolve();
  await settle();
  assert.deepEqual([...h.native], h.store.getState().windowOrder);
});

test("a failed close is reported once and never retried automatically", async (t) => {
  const h = harness({ holdClose: true });
  t.after(h.stop);
  const id = h.store.getState().createWindow();
  h.pending.get(id).resolve();
  await settle();
  h.store.getState().closeWindow(id);
  h.pendingClose.get(id).reject(new Error("uncertain close"));
  await settle();
  h.store.getState().updateSettings({ appearance: "dark" });
  h.sync();
  assert.equal(h.calls.filter(([method]) => method === "close").length, 1);
  assert.equal(h.calls.filter(([method]) => method === "release").length, 0);
  assert.equal(h.errors[0][0], "close");
  h.reconciler.nativeClosed(id);
  h.native.delete(id);
  await settle();
  assert.equal(h.calls.filter(([method]) => method === "release").length, 1);
});

test("initial reconciliation dispatches the focused window last with the original flags", async (t) => {
  const h = harness();
  t.after(h.stop);
  h.stop();
  const focused = h.store.getState().createWindow();
  const background = h.store.getState().createWindow({ background: true });
  h.sync();
  assert.deepEqual(
    h.calls.filter(([method]) => method === "open").map(([, id, options]) => [id, options.focus]),
    [
      [background, false],
      [focused, true],
    ],
  );
  h.pending.get(background).resolve();
  h.pending.get(focused).resolve();
  await settle();
});
