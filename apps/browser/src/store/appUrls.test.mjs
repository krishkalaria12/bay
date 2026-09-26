// Run from apps/browser:  node --import ./src/store/test-loader.mjs --test src/store/appUrls.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { setAppUrlOpener } = await import("./tabs.ts");

const S = () => useBrowser.getState();
const reset = () => S().hydrate({});

test("chrome:// and about: input is stored, loaded and labelled as bay://", () => {
  reset();
  const w = S().createWindow({ url: "chrome://version" });
  const tab = S().tabs[model.activeTabId(S(), w)];
  assert.equal(tab.url, "bay://version");
  assert.equal(tab.navigation.url, "bay://version");
  S().navigate(tab.id, "about:gpu");
  assert.equal(S().tabs[tab.id].navigation.url, "bay://gpu");
  assert.equal(model.tabLabel({ url: "bay://gpu/", title: "GPU Internals", customTitle: null }), "bay://gpu");
  assert.match(model.windowTitle(S(), w), /bay:\/\/version$/);
});

test("history and bookmarks keep the bay:// form, so they reopen", () => {
  reset();
  const w = S().createWindow({ url: "bay://version" });
  const tab = S().tabs[model.activeTabId(S(), w)];
  S().updateTab(tab.id, { url: "bay://version/", title: "About Version" });
  S().recordVisit(tab.profileId, "bay://version/", "About Version", null, true);
  assert.equal(S().history[tab.profileId][0].url, "bay://version/");
  const id = S().addBookmark({ profileId: tab.profileId, url: S().tabs[tab.id].url, title: "Version" });
  assert.equal(S().bookmarks.nodes[id].url, "bay://version/");
  const again = S().newTab(w, { url: S().bookmarks.nodes[id].url });
  assert.equal(S().tabs[again].navigation.url, "bay://version/");
});

test("app URLs that open elsewhere never make or change a tab", () => {
  reset();
  const opened = [];
  setAppUrlOpener((url, windowId) => {
    if (!url.startsWith("bay://settings")) return false;
    opened.push([url, windowId]);
    return true;
  });
  try {
    const w = S().createWindow({ url: "example.com" });
    const tab = model.activeTabId(S(), w);
    const before = S().tabs[tab];
    S().openPanel(w, "");
    S().navigate(tab, "chrome://settings");
    assert.equal(S().tabs[tab], before);
    assert.equal(S().windowUi[w].panel.open, false);
    assert.equal(S().newTab(w, { url: "bay://settings/passwords" }), "");
    assert.equal(model.viewTabIds(S(), w).length, 1);
    assert.deepEqual(opened, [
      ["bay://settings", w],
      ["bay://settings/passwords", w],
    ]);
    S().navigate(tab, "bay://extensions");
    assert.equal(S().tabs[tab].navigation.url, "bay://extensions");
  } finally {
    setAppUrlOpener(() => false);
  }
});
