import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";

if (!process.env.BAY_DROP_CHILD) {
  for (const [platform, coordinates] of [
    ["macos", true],
    ["windows", true],
    ["linux", true],
    ["linux", false],
  ]) {
    test(`${platform} coordinates=${coordinates}: drag placement policy`, () => {
      const env = { ...process.env, BAY_DROP_CHILD: "1", BAY_TEST_PLATFORM: platform, BAY_TEST_GLOBAL_COORDINATES: String(coordinates) };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(
        process.execPath,
        ["--no-warnings", "--import", "./src/test-loader.mjs", "--test", "src/components/layout/windowDrop.test.mjs"],
        {
          cwd: new URL("../../../", import.meta.url),
          env,
          encoding: "utf8",
        },
      );
      assert.match(output, /fail 0\n/);
      assert.match(output, /pass [1-9]\d*\n/);
    });
  }
} else {
  const { capabilities } = await import("../../test-platform-stub.mjs");
  const { useBrowser } = await import("../../store/browser.ts");
  const { activeTabId, viewTabIds } = await import("../../store/model.ts");
  const { installBrowserCommands } = await import("../../runtime/commands.ts");
  const { tabDragNative, focusedWindows } = await import("../../test-native-stub.mjs");
  const { dropTabsOutside, windowUnder, screenPoint } = await import("./windowDrop.ts");
  const global = capabilities.globalWindowCoordinates;
  // Keep drag coordination real while replacing only picture/UI effects and renderer dimensions.
  globalThis.__DEV__ = false;
  globalThis.nnDragLocalSize = { width: 600, height: 400 };
  const stubURL = new URL("../../test-native-stub.mjs", import.meta.url).href;
  const modules = {
    "react-native": "export const Dimensions = { get: () => globalThis.nnDragLocalSize };",
    "../../lib/actions": `export { focusWindow as focus } from ${JSON.stringify(stubURL)};`,
    "../../lib/tabPictures": "export const startTabPictures = () => {}; export const lastPicture = () => null;",
    "../../lib/webviews": "export const webviews = new Map();",
    "./splitActions": "export const dropTabIntoSplit = () => {};",
  };
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("/tabDrag.ts") && specifier in modules)
        return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
      return next(specifier, context);
    },
  });
  const { beginTabDrag, updateTabDrag, endTabDrag, cancelTabDrag, setDragPicture, useTabDrag } = await import("./tabDrag.ts");
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const setup = () => {
    cancelTabDrag();
    useBrowser.getState().hydrate({});
    const source = useBrowser.getState().createWindow({ frame: [100, 100, 600, 400], url: "https://one.example/" });
    const tabId = activeTabId(useBrowser.getState(), source);
    useBrowser.getState().newTab(source, { url: "https://two.example/" });
    const other = useBrowser.getState().createWindow({ frame: [800, 100, 600, 400], url: "https://other.example/" });
    tabDragNative.calls.length = 0;
    focusedWindows.length = 0;
    tabDragNative.frame = () => Promise.resolve(global ? [100, 100, 600, 400] : null);
    globalThis.nnDragLocalSize = { width: 600, height: 400 };
    return { source, other, tabId };
  };

  test("screen hit testing uses global coordinates only when advertised", () => {
    const { source, other } = setup();
    const s = useBrowser.getState();
    assert.deepEqual(screenPoint(s, source, 750, 20, [100, 100, 600, 400]), global ? [850, 480] : null);
    assert.deepEqual(windowUnder(s, source, 750, 20), { outside: true, overWindow: global ? other : null });
    assert.deepEqual(windowUnder(s, source, 800, 50, null, [1000, 900]), { outside: false, overWindow: null });
    assert.deepEqual(windowUnder(s, source, -1, 50), { outside: true, overWindow: null });
    assert.deepEqual(windowUnder(s, source, 600, 400), { outside: false, overWindow: null });
  });

  test("drop-out moves into the hit window on global hosts and creates a size-only window otherwise", async () => {
    const { source, other, tabId } = setup();
    let callback = false;
    const moved = await dropTabsOutside([tabId], source, 750, 20, () => {
      callback = true;
    });
    assert.ok(moved);
    const w = useBrowser.getState().windows[moved];
    assert.equal(useBrowser.getState().tabs[tabId].windowId, moved);
    assert.equal(callback, false);
    if (global) assert.equal(moved, other);
    else {
      assert.notEqual(moved, other);
      assert.equal(w.frame, null);
      assert.deepEqual(w.size, [600, 400]);
      assert.equal(w.maximized, undefined);
    }
  });

  test("fresh desktop windows have a global frame only when supported", async () => {
    const { source, tabId } = setup();
    let asked = null;
    const moved = await dropTabsOutside([tabId], source, -100, 20, (frame) => {
      asked = frame;
    });
    const w = useBrowser.getState().windows[moved];
    if (global) {
      assert.deepEqual(asked, [-90, 150, 600, 400]);
      assert.deepEqual(w.frame, asked);
    } else {
      assert.equal(asked, null);
      assert.deepEqual(w.size, [600, 400]);
      assert.equal(w.frame, null);
    }
  });

  test("whole-window/private guards and missing source never create a window", async () => {
    const { source, tabId } = setup();
    const s = useBrowser.getState();
    const all = viewTabIds(s, source);
    const count = s.windowOrder.length;
    assert.equal(await dropTabsOutside(all, source, -200, 20), null);
    const privateId = s.createWindow({ incognito: true });
    assert.equal(await dropTabsOutside([activeTabId(useBrowser.getState(), privateId)], privateId, -200, 20), null);
    assert.equal(await dropTabsOutside([tabId], "missing", -200, 20), null);
    assert.equal(useBrowser.getState().windowOrder.length, count + 1);
  });

  test("same-window reorder stays local and Wayland drag-out uses live renderer size without desktop preview", async () => {
    const { source, tabId } = setup();
    beginTabDrag(tabId);
    await settle();
    updateTabDrag(300, 20, false);
    assert.equal(endTabDrag(), false);
    assert.deepEqual(tabDragNative.calls, []);
    assert.equal(useBrowser.getState().tabs[tabId].windowId, source);
    const sequence = beginTabDrag(tabId);
    await settle();
    setDragPicture(sequence, [10, 10, 150, 30], [20, 20]);
    if (!global) {
      globalThis.nnDragLocalSize = { width: 1000, height: 800 };
      updateTabDrag(900, 20, false);
      assert.equal(useTabDrag.getState().outside, false, "restored 600px width must not replace actual maximized width");
    }
    updateTabDrag(-200, 20, true);
    assert.equal(useTabDrag.getState().outside, true);
    assert.equal(endTabDrag(), true);
    await settle();
    const moved = useBrowser.getState().tabs[tabId].windowId;
    assert.notEqual(moved, source);
    assert.deepEqual(focusedWindows, [moved]);
    if (!global) assert.deepEqual(tabDragNative.calls, [], "no begin/update/end/page native preview calls without global coordinates");
  });

  for (const interrupt of ["cancel", "next drag"]) {
    test(`${interrupt} prevents a late acknowledged drop from focusing or ending the new drag`, async (t) => {
      const { tabId } = setup();
      let resolve;
      const stop = installBrowserCommands({
        dispatch: () =>
          new Promise((yes) => {
            resolve = yes;
          }),
      });
      t.after(stop);
      beginTabDrag(tabId);
      await settle();
      updateTabDrag(-100, 20, true);
      endTabDrag();
      if (interrupt === "cancel") cancelTabDrag();
      else beginTabDrag(tabId);
      const before = tabDragNative.calls.length;
      resolve("new-window");
      await settle();
      assert.deepEqual(focusedWindows, []);
      assert.equal(tabDragNative.calls.length, before);
      cancelTabDrag();
    });
  }

  test("late frame queries from a previous drag cannot change a new source's geometry", async () => {
    const { tabId } = setup();
    let reply;
    tabDragNative.frame = () =>
      new Promise((resolve) => {
        reply = resolve;
      });
    beginTabDrag(tabId);
    if (!global) return cancelTabDrag();
    cancelTabDrag();
    tabDragNative.frame = () => Promise.resolve([100, 100, 600, 400]);
    beginTabDrag(tabId);
    await settle();
    reply([0, 0, 5000, 5000]);
    await settle();
    updateTabDrag(700, 20, false);
    assert.equal(useTabDrag.getState().outside, true);
    cancelTabDrag();
  });
}
