import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { addressBarInSidebar, sidebarSiteControlsGeometry } = await import("./windowLayout.ts");
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
