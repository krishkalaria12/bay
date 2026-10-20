import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Each platform's policy is fixed at import, so each runs in its own process.
if (!process.env.BAY_WINDOW_BUTTONS_CHILD) {
  for (const platform of ["windows", "macos"]) {
    test(`${platform} layouts clear only the window buttons it has`, () => {
      const env = { ...process.env, BAY_WINDOW_BUTTONS_CHILD: "1", BAY_TEST_PLATFORM: platform };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(
        process.execPath,
        ["--no-warnings", "--import", "./src/test-loader.mjs", "--test", "src/components/layout/windowButtons.test.mjs"],
        {
          cwd: new URL("../../../", import.meta.url),
          env,
          encoding: "utf8",
        },
      );
      assert.match(output, /pass 2\n/, "the platform child must run its geometry assertions");
    });
  }
} else {
  const windows = process.env.BAY_TEST_PLATFORM === "windows";
  const { CAPTION_BUTTONS_WIDTH, LIGHTS_WIDTH } = await import("./windowButtons.ts");
  const { CAPTION_END_ROOM, NO_TOOLBAR, NO_TOOLBAR_PAST_LIGHTS, toolbarEndRoom, toolbarGeometry } = await import("./geometry.ts");
  const { SIDEBAR_BUTTON_END_ROOM, TRAFFIC_LIGHTS_OFFSET } = await import("./constants.ts");

  test("the window's buttons take one corner", () => {
    assert.equal(CAPTION_BUTTONS_WIDTH, windows ? 138 : 0);
    assert.equal(LIGHTS_WIDTH, windows ? 0 : 78);
    assert.equal(TRAFFIC_LIGHTS_OFFSET, windows ? 0 : 70);
    // A pane without a toolbar starts at its edge where no traffic lights cover its corner.
    assert.equal(NO_TOOLBAR_PAST_LIGHTS === NO_TOOLBAR, windows);
  });

  test("the top-right pane's toolbar ends before the caption buttons, then its sidebar toggle", () => {
    const leading = toolbarGeometry({ sidebarButton: true, clearTrafficLights: true });
    assert.equal(leading.captionEnd, false);
    assert.equal(toolbarEndRoom(leading), 0);
    const corner = toolbarGeometry({ sidebarButton: false, clearTrafficLights: false, captionEnd: true });
    assert.equal(corner.captionEnd, true);
    assert.equal(CAPTION_END_ROOM, windows ? 131 : 0);
    assert.equal(toolbarEndRoom(corner), CAPTION_END_ROOM);
    const toggled = toolbarGeometry({ sidebarButton: false, clearTrafficLights: false, sidebarButtonEnd: true, captionEnd: true });
    assert.equal(toolbarEndRoom(toggled), CAPTION_END_ROOM + SIDEBAR_BUTTON_END_ROOM);
    // Geometries stay shared per layout, so panes given one can skip re-rendering.
    assert.equal(toolbarGeometry({ sidebarButton: false, clearTrafficLights: false, captionEnd: true }), corner);
  });
}
