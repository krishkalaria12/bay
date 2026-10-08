import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { addressBarInSidebar, besideRow, sidebarOnRight, sidebarSiteControlsGeometry } = await import("./windowLayout.ts");
const S = () => useBrowser.getState();

test("the sidebar address bar defaults on and falls back for hidden sidebar and top tabs", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "example.com" });
  assert.equal(addressBarInSidebar(S(), w), true);
  S().toggleSidebar(w);
  assert.equal(addressBarInSidebar(S(), w), false);
  S().toggleSidebar(w);
  S().updateSettings({ tabLayout: "top" });
  assert.equal(addressBarInSidebar(S(), w), false);
  S().updateSettings({ tabLayout: "sidebar", addressBar: "toolbar" });
  assert.equal(addressBarInSidebar(S(), w), false);
});

test("a saved toolbar preference survives hydration", () => {
  S().hydrate({ settings: { addressBar: "toolbar" } });
  const w = S().createWindow({ url: "example.com" });
  assert.equal(addressBarInSidebar(S(), w), false);
});

test("site controls align under the field button and stay inside the window", () => {
  const anchor = { left: 8, top: 48, width: 224, sidebar: { height: 34 } };
  const g = sidebarSiteControlsGeometry(anchor, 1280, 800);
  assert.equal(g.top, 91);
  assert.equal(g.left + g.arrowLeft, 215);
  assert.equal(g.maxHeight, 701);
  const narrow = sidebarSiteControlsGeometry(anchor, 280, 300);
  assert.equal(narrow.width, 264);
  assert.equal(narrow.left, 8);
  assert.equal(narrow.maxHeight, 201);
});

test("the sidebar docks on the right only with tabs in the sidebar, and defaults to the left", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "example.com" });
  assert.equal(sidebarOnRight(S(), w), false);
  S().updateSettings({ sidebarPosition: "right" });
  assert.equal(sidebarOnRight(S(), w), true);
  S().toggleSidebar(w);
  assert.equal(sidebarOnRight(S(), w), true);
  S().updateSettings({ tabLayout: "top" });
  assert.equal(sidebarOnRight(S(), w), false);
});

test("a card beside a sidebar row opens toward the page", () => {
  const row = { x: 1000, width: 180 };
  assert.equal(besideRow(row, 300, false), 1188);
  assert.equal(besideRow(row, 300, true), 692);
});

test("with the sidebar on the right the toolbar's toggle moves to its end, clear of the window buttons", async () => {
  const { toolbarGeometry, TRAFFIC_LIGHTS_OFFSET } = await import("./geometry.ts");
  const left = toolbarGeometry({ sidebarButton: true, clearTrafficLights: false });
  assert.notEqual(left.sidebarButton, null);
  assert.equal(left.sidebarButtonEnd, false);
  const right = toolbarGeometry({ sidebarButton: false, sidebarButtonEnd: true, clearTrafficLights: true });
  assert.equal(right.sidebarButton, null);
  assert.equal(right.sidebarButtonEnd, true);
  assert.ok(right.back > TRAFFIC_LIGHTS_OFFSET);
  assert.equal(toolbarGeometry({ sidebarButton: false, sidebarButtonEnd: true, clearTrafficLights: true }), right);
});
