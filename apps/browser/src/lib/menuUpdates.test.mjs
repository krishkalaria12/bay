import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../store/browserStore.ts";
import { activeTabId } from "../store/model.ts";
import { patchPage, usePages } from "../components/window/pageState.ts";
import { subscribeMenuInputs } from "./menuUpdates.ts";

const S = () => useBrowser.getState();
function setup() {
  S().hydrate({});
  usePages.setState({ pages: {} });
  const windowId = S().createWindow({ url: "https://example.com" });
  S().setFocusedWindow(windowId);
  const active = activeTabId(S(), windowId);
  const background = S().newTab(windowId, { url: "https://background.example", background: true });
  return { windowId, active, background };
}

test("menu inputs ignore progress and audio reports, including the focused tab", () => {
  const { active, background } = setup();
  let calls = 0;
  const stop = subscribeMenuInputs(() => calls++);
  try {
    for (let i = 0; i < 600; i++) S().updateLive(i % 2 ? active : background, { progress: i / 600, playingAudio: !!(i % 3) });
    patchPage(active, { status: "Link target", blocked: 4, fullscreen: true });
    assert.equal(calls, 0);
  } finally {
    stop();
  }
});

test("menu inputs follow loading and history availability for the focused tab", () => {
  const { active, background } = setup();
  let calls = 0;
  const stop = subscribeMenuInputs(() => calls++);
  try {
    S().updateLive(background, { isLoading: true, canGoBack: true, canGoForward: true });
    assert.equal(calls, 0, "a background tab does not control Stop, Back or Forward");
    for (const key of ["isLoading", "canGoBack", "canGoForward"]) {
      S().updateLive(active, { [key]: true });
      const after = calls;
      S().updateLive(active, { [key]: true, progress: 0.5 });
      assert.equal(calls, after, "unchanged availability does not schedule a rebuild");
      S().updateLive(active, { [key]: false });
    }
    assert.equal(calls, 6);
    S().updateLive(active, { isLoading: true });
    const live = { ...S().live };
    delete live[active];
    useBrowser.setState({ live });
    assert.equal(calls, 8, "removing a live record restores idle menu availability");
  } finally {
    stop();
  }
});

test("non-live changes and focus switches still invalidate the menu", () => {
  const { windowId, active, background } = setup();
  const seen = [];
  const stop = subscribeMenuInputs(() => seen.push(activeTabId(S(), S().ui.focusedWindowId)));
  try {
    S().updateSettings({ showFullUrl: !S().settings.showFullUrl });
    S().updateTab(active, { title: "Renamed" });
    useBrowser.setState({ bookmarks: { ...S().bookmarks } });
    useBrowser.setState({ downloads: [...S().downloads] });
    useBrowser.setState({ closedTabs: [...S().closedTabs] });
    assert.equal(seen.length, 5);
    S().activate(background, windowId);
    assert.equal(seen.at(-1), background);
    const other = S().createWindow({ url: "https://other.example" });
    S().setFocusedWindow(other);
    assert.equal(seen.at(-1), activeTabId(S(), other));
    S().closeWindow(other);
    assert.ok(seen.length > 6, "window removal must still schedule synchronization");
  } finally {
    stop();
  }
});

test("engine and new-tab history transitions invalidate without a browser-store update", () => {
  const { active, background } = setup();
  let calls = 0;
  const stop = subscribeMenuInputs(() => calls++);
  try {
    patchPage(background, { backToNewTab: true });
    assert.equal(calls, 0);
    patchPage(active, { backToNewTab: true });
    patchPage(active, { backToNewTab: false });
    patchPage(active, { engineBack: { engine: "webkit", url: "https://example.com" } });
    patchPage(active, { engineBack: { engine: "webkit", url: "https://another.example" } });
    assert.equal(calls, 3, "changing the history target preserves availability");
    patchPage(active, { engineBack: null });
    patchPage(active, { newTabShown: { url: "https://example.com", title: "Example", favicon: null } });
    patchPage(active, { newTabShown: null });
    assert.equal(calls, 6);
    patchPage(active, { backToNewTab: true });
    usePages.setState({ pages: {} });
    assert.equal(calls, 8, "clearing page records restores idle history availability");
  } finally {
    stop();
  }
  S().updateLive(active, { isLoading: true });
  S().updateTab(active, { title: "After unsubscribe" });
  patchPage(active, { backToNewTab: true });
  assert.equal(calls, 8, "all input subscriptions detach together");
});
