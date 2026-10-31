import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Platform policy is fixed at import, so each host runs in its own process.
if (!process.env.BAY_WINDOW_BUTTONS_CHILD) {
  for (const platform of ["linux", "windows", "macos"]) {
    test(`${platform} caption geometry`, () => {
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
  const windows = platform === "windows";
  const { CAPTION_BUTTON_WIDTH, captionMaximizeRect, getWindowButtonLayout, LIGHTS_WIDTH, useWindowButtonLayout, windowButtonRoom } =
    await import("./windowButtons.ts");
  const { noToolbarGeometry, NO_TOOLBAR, paneButtonClearance, sidebarButtonRoom, toolbarEndRoom, toolbarGeometry } = await import("./geometry.ts");
  const { SIDEBAR_BUTTON_END_ROOM, TRAFFIC_LIGHTS_OFFSET } = await import("./constants.ts");
  const { capabilities } = await import("@bay/platform");
  const right3 = { left: [], right: ["minimize", "maximize", "close"] };
  const empty = { left: [], right: [] };
  const buttons = windows ? right3 : empty;

  test("Windows draws its caption buttons; macOS has traffic lights and Linux no buttons", () => {
    assert.equal(capabilities.captionButtons, windows);
    assert.deepEqual(getWindowButtonLayout(), buttons);
    assert.equal(useWindowButtonLayout(), getWindowButtonLayout(), "one stable layout");
    assert.ok(Object.isFrozen(getWindowButtonLayout()) && Object.isFrozen(getWindowButtonLayout().right));
    assert.equal(LIGHTS_WIDTH, mac ? 78 : 0);
    assert.equal(TRAFFIC_LIGHTS_OFFSET, mac ? 70 : 0);
    assert.equal(CAPTION_BUTTON_WIDTH, 46);
  });

  test("edge room and maximize target", () => {
    const left = mac ? 78 : 0;
    const right = windows ? 138 : 0;
    assert.deepEqual(windowButtonRoom(buttons), { left, right });
    assert.deepEqual(captionMaximizeRect(buttons, 1000, 40), windows ? [908, 0, CAPTION_BUTTON_WIDTH, 40] : null);
    assert.deepEqual(sidebarButtonRoom(buttons, false), { left, right: 0 });
    assert.deepEqual(sidebarButtonRoom(buttons, true), { left: 0, right });
  });

  test("toolbars clear the window's buttons with a sidebar on either side", () => {
    const right = windows ? 138 : 0;
    const baseline = toolbarGeometry({ sidebarButton: false, clearTrafficLights: false }, buttons);
    for (const sidebarRight of [false, true]) {
      for (const sidebarOpen of [false, true]) {
        const clearance = paneButtonClearance(true, true, "sidebar", sidebarOpen, sidebarRight);
        const start = !sidebarOpen || sidebarRight;
        const end = !sidebarOpen || !sidebarRight;
        assert.deepEqual(clearance, { clearTrafficLights: start, captionEnd: end });
        const options = { sidebarButton: false, sidebarButtonEnd: sidebarRight, ...clearance };
        const g = toolbarGeometry(options, buttons);
        assert.equal(g.back, baseline.back + (start && mac ? 70 : 0));
        assert.equal(g.captionRoom, end ? Math.max(0, right - 7) : 0);
        assert.equal(toolbarEndRoom(g), g.captionRoom + (sidebarRight ? SIDEBAR_BUTTON_END_ROOM : 0));
        assert.equal(toolbarGeometry(options, structuredClone(buttons)), g, "same geometry stays shared");
        const bare = noToolbarGeometry(start, buttons);
        assert.equal(bare.urlLeft, start && mac ? 70 : 8);
        assert.equal(bare.captionRoom, 0);
        assert.equal(noToolbarGeometry(start, buttons), bare);
      }
    }
    assert.equal(noToolbarGeometry(false, buttons), NO_TOOLBAR);
  });

  test("top strips hold both corners; only outer top split panes clear window buttons", () => {
    assert.deepEqual(paneButtonClearance(true, true, "top", true, false), { clearTrafficLights: false, captionEnd: false });
    assert.deepEqual(paneButtonClearance(true, true, "top", false, false), { clearTrafficLights: false, captionEnd: true });
    assert.deepEqual(paneButtonClearance(false, false, "sidebar", false, false), { clearTrafficLights: false, captionEnd: false });
    assert.deepEqual(paneButtonClearance(true, false, "sidebar", false, false), { clearTrafficLights: true, captionEnd: false });
    assert.deepEqual(paneButtonClearance(false, true, "sidebar", false, false), { clearTrafficLights: false, captionEnd: true });
  });
}
