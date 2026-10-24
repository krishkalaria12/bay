import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Platform policy is fixed at import, so each host runs in its own process.
if (!process.env.BAY_WINDOW_BUTTONS_CHILD) {
  for (const platform of ["linux", "windows", "macos"]) {
    test(`${platform} caption geometry and subscriptions`, () => {
      const env = { ...process.env, BAY_WINDOW_BUTTONS_CHILD: "1", BAY_TEST_PLATFORM: platform };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(
        process.execPath,
        ["--no-warnings", "--import", "./src/test-loader.mjs", "--test", "src/components/layout/windowButtons.test.mjs"],
        { cwd: new URL("../../../", import.meta.url), env, encoding: "utf8" },
      );
      assert.match(output, /fail 0\n/);
      assert.match(output, /pass [1-9]\d*\n/);
    });
  }
} else {
  const platform = process.env.BAY_TEST_PLATFORM;
  const mac = platform === "macos";
  const linux = platform === "linux";
  const { captionMaximizeRect, captionPeekInsets, getWindowButtonLayout, LIGHTS_WIDTH, subscribeWindowButtonLayout, utilityCaptionHeight, windowButtonRoom } =
    await import("./windowButtons.ts");
  const { noToolbarGeometry, NO_TOOLBAR, paneButtonClearance, sidebarButtonRoom, toolbarEndRoom, toolbarGeometry } = await import("./geometry.ts");
  const { SIDEBAR_BUTTON_END_ROOM, TRAFFIC_LIGHTS_OFFSET } = await import("./constants.ts");
  const { appEventListeners, emitAppEvent, windowButtonLayoutState } = await import("../../test-native-stub.mjs");
  const right3 = { left: [], right: ["minimize", "maximize", "close"] };
  const empty = { left: [], right: [] };
  const fixtures = linux
    ? [
        { name: "left", buttons: { left: ["close", "minimize", "maximize"], right: [] }, left: 138, right: 0, max: 92 },
        { name: "right", buttons: right3, left: 0, right: 138, max: 908 },
        { name: "split", buttons: { left: ["close"], right: ["maximize", "minimize"] }, left: 46, right: 92, max: 908 },
        { name: "close only", buttons: { left: ["close"], right: [] }, left: 46, right: 0, max: null },
        { name: "empty", buttons: empty, left: 0, right: 0, max: null },
      ]
    : [{ name: platform, buttons: mac ? empty : right3, left: mac ? 78 : 0, right: mac ? 0 : 138, max: mac ? null : 908 }];

  test("native platform defaults and macOS spacing remain unchanged", () => {
    assert.deepEqual(getWindowButtonLayout(), mac ? empty : right3);
    assert.equal(LIGHTS_WIDTH, mac ? 78 : 0);
    assert.equal(TRAFFIC_LIGHTS_OFFSET, mac ? 70 : 0);
    assert.equal(utilityCaptionHeight(getWindowButtonLayout(), 32), linux ? 32 : 0);
  });

  for (const { name, buttons, left, right, max } of fixtures) {
    test(`${name}: edge room, maximize target and utility origin`, () => {
      assert.deepEqual(windowButtonRoom(buttons), { left, right });
      assert.deepEqual(captionMaximizeRect(buttons, 1000, 40), max === null ? null : [max, 0, 46, 40]);
      assert.equal(utilityCaptionHeight(buttons, 32), linux && left + right > 0 ? 32 : 0);
      assert.deepEqual(sidebarButtonRoom(buttons, false), { left, right: 0 });
      assert.deepEqual(sidebarButtonRoom(buttons, true), { left: 0, right });
    });

    test(`${name}: toolbar and developer bars clear both corners with a sidebar on either side`, () => {
      const baseline = toolbarGeometry({ sidebarButton: false, clearTrafficLights: false }, buttons);
      const offset = mac ? 70 : Math.max(0, left - 7);
      for (const sidebarRight of [false, true]) {
        for (const sidebarOpen of [false, true]) {
          const clearance = paneButtonClearance(true, true, "sidebar", sidebarOpen, sidebarRight);
          const start = !sidebarOpen || sidebarRight;
          const end = !sidebarOpen || !sidebarRight;
          assert.deepEqual(clearance, { clearTrafficLights: start, captionEnd: end });
          const options = { sidebarButton: false, sidebarButtonEnd: sidebarRight, ...clearance };
          const g = toolbarGeometry(options, buttons);
          assert.equal(g.back, baseline.back + (start ? offset : 0));
          assert.equal(g.urlLeft, baseline.urlLeft + (start ? offset : 0));
          assert.equal(g.captionRoom, end ? Math.max(0, right - 7) : 0);
          assert.equal(toolbarEndRoom(g), g.captionRoom + (sidebarRight ? SIDEBAR_BUTTON_END_ROOM : 0));
          assert.equal(toolbarGeometry(options, structuredClone(buttons)), g, "same geometry stays shared");
          const bare = noToolbarGeometry(start, end, buttons);
          assert.equal(bare.urlLeft, start ? Math.max(8, offset) : 8);
          assert.equal(bare.captionRoom, linux ? g.captionRoom : 0);
          assert.equal(noToolbarGeometry(start, end, buttons), bare);
        }
      }
      assert.equal(noToolbarGeometry(false, false, buttons), NO_TOOLBAR);
    });

    test(`${name}: collapsed top-tabs peek clears captions without shifting Windows/macOS`, () => {
      const insets = captionPeekInsets(buttons, 6);
      assert.deepEqual(insets, linux ? { left: Math.max(6, left), right: Math.max(6, right) } : { left: 6, right: 6 });
      if (linux) {
        const width = 1000 - insets.left - insets.right;
        assert.ok(insets.left + 8 >= left, "first floating tab is past left captions");
        assert.ok(insets.left + width - 8 <= 1000 - right, "trailing floating controls precede right captions");
      }
    });
  }

  test("top strips hold both corners; only outer top split panes clear window buttons", () => {
    assert.deepEqual(paneButtonClearance(true, true, "top", true, false), { clearTrafficLights: false, captionEnd: false });
    assert.deepEqual(paneButtonClearance(true, true, "top", false, false), { clearTrafficLights: linux, captionEnd: true });
    assert.deepEqual(paneButtonClearance(false, false, "sidebar", false, false), { clearTrafficLights: false, captionEnd: false });
    assert.deepEqual(paneButtonClearance(true, false, "sidebar", false, false), { clearTrafficLights: true, captionEnd: false });
    assert.deepEqual(paneButtonClearance(false, true, "sidebar", false, false), { clearTrafficLights: false, captionEnd: true });
  });

  test("collapsed top-tabs keep the macOS toolbar origin; bare Windows developer bars keep their right edge", () => {
    const clearance = paneButtonClearance(true, true, "top", false, false);
    const collapsed = toolbarGeometry({ sidebarButton: false, ...clearance });
    const baseline = toolbarGeometry({ sidebarButton: false, clearTrafficLights: false });
    if (!linux) assert.equal(collapsed.urlLeft, baseline.urlLeft, "non-Linux collapsed top tabs keep their original start");
    const bare = noToolbarGeometry(true, true);
    if (platform === "windows") {
      assert.equal(bare, NO_TOOLBAR, "Windows address-in-sidebar developer bars retain their original geometry");
      assert.equal(6 + bare.captionRoom, 6, "Windows developer actions keep the original right inset");
    }
    if (mac) assert.equal(bare.urlLeft, 70, "macOS no-toolbar traffic-light spacing is unchanged");
  });

  if (linux) {
    test("layout subscriptions read after registering, share immutable snapshots and remove the native listener", () => {
      let firstUpdates = 0;
      let secondUpdates = 0;
      const changed = { left: ["close"], right: ["minimize"] };
      windowButtonLayoutState.read = () => {
        assert.equal(appEventListeners.size, 1, "native listener exists before snapshot read");
        return changed;
      };
      const stopFirst = subscribeWindowButtonLayout(() => firstUpdates++);
      const stopSecond = subscribeWindowButtonLayout(() => secondUpdates++);
      assert.equal(appEventListeners.size, 1, "all consumers share one native listener");
      assert.deepEqual(getWindowButtonLayout(), changed, "change missed before mount is refreshed");
      const snapshot = getWindowButtonLayout();
      assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.left) && Object.isFrozen(snapshot.right));
      changed.left.push("maximize");
      assert.deepEqual(snapshot.left, ["close"], "event arrays are copied");
      emitAppEvent({ type: "windowButtonLayout", layout: structuredClone(snapshot) });
      assert.equal(getWindowButtonLayout(), snapshot);
      assert.equal(firstUpdates, 1);
      assert.equal(secondUpdates, 0);
      const before = toolbarGeometry({ sidebarButton: false, clearTrafficLights: true, captionEnd: true });
      emitAppEvent({ type: "windowButtonLayout", layout: empty });
      const after = toolbarGeometry({ sidebarButton: false, clearTrafficLights: true, captionEnd: true });
      assert.notEqual(before, after, "desktop changes replace geometry for mounted consumers");
      assert.equal(after.captionRoom, 0);
      assert.equal(firstUpdates, 2);
      assert.equal(secondUpdates, 1);
      stopFirst();
      assert.equal(appEventListeners.size, 1);
      emitAppEvent({ type: "windowButtonLayout", layout: right3 });
      assert.equal(firstUpdates, 2);
      assert.equal(secondUpdates, 2);
      stopSecond();
      assert.equal(appEventListeners.size, 0);
      windowButtonLayoutState.read = null;
    });

    test("a layout event during snapshot read wins over the older bootstrap value", () => {
      const newest = { left: ["maximize", "close"], right: [] };
      windowButtonLayoutState.read = () => {
        emitAppEvent({ type: "windowButtonLayout", layout: newest });
        return right3;
      };
      const stop = subscribeWindowButtonLayout(() => {});
      assert.deepEqual(getWindowButtonLayout(), newest);
      stop();
      windowButtonLayoutState.read = null;
      windowButtonLayoutState.layout = empty;
      const resume = subscribeWindowButtonLayout(() => {});
      assert.deepEqual(getWindowButtonLayout(), empty, "remount refreshes changes made while unsubscribed");
      resume();
      assert.equal(appEventListeners.size, 0);
    });
  }
}
