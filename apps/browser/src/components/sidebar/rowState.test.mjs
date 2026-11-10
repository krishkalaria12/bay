import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../../store/browserStore.ts";
import { browserRead, createLocalBrowserReadSource } from "../../store/read.ts";
import { ACTIVE, SELECTED, PLAYING, LOADING, rowFlags, tabRowStore } from "./rowState.ts";

const S = () => useBrowser.getState();

test("tab row notifications ignore progress and route only display flags to the affected row", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://active.example" });
  const active = S().windows[w].activeTabIds.default;
  const other = S().newTab(w, { url: "https://other.example", background: true });
  const shown = tabRowStore(w, active);
  const background = tabRowStore(w, other);
  const seen = [];
  let unrelated = 0;
  const stops = [shown.subscribe(() => unrelated++), background.subscribe((value) => seen.push(value))];

  try {
    for (let i = 1; i <= 60; i++) S().updateLive(other, { progress: i / 100 });
    assert.deepEqual(seen, []);
    assert.equal(unrelated, 0);
    S().updateLive(other, { isLoading: true, playingAudio: true });
    assert.deepEqual(seen, [LOADING | PLAYING]);
    assert.equal(unrelated, 0);
    S().setSelection(w, [other]);
    assert.equal(seen.at(-1), LOADING | PLAYING | SELECTED);
    S().activate(other, w);
    assert.equal(seen.at(-1), ACTIVE | LOADING | PLAYING | SELECTED);
    assert.equal(unrelated, 1, "the row that lost activation updates as well");
    const count = seen.length;
    S().toggleSidebar(w);
    S().updateTab(other, { title: "new title" });
    assert.equal(seen.length, count, "unchanged flags never publish a new row snapshot");
    S().hydrate({});
    assert.equal(background.getState(), 0);
    assert.equal(seen.at(-1), 0);
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("row snapshots preserve window ownership, per-space activation and reentrant selection", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://first.example" });
  const tab = S().windows[w].activeTabIds.default;
  const second = S().createWindow({ url: "https://second.example" });
  const own = tabRowStore(w, tab);
  const elsewhere = tabRowStore(second, tab);
  const stops = [own.subscribe(() => {}), elsewhere.subscribe(() => {})];

  try {
    assert.equal(own.getState(), ACTIVE);
    assert.equal(elsewhere.getState(), 0);
    S().activate(tab, second);
    assert.equal(elsewhere.getState() & ACTIVE, ACTIVE);
    assert.equal(own.getState() & ACTIVE, ACTIVE, "the source window keeps its selected open-elsewhere row");

    const stop = elsewhere.subscribe((flags) => {
      if (flags & SELECTED) S().setSelection(second, []);
    });

    S().setSelection(second, [tab]);
    assert.equal(elsewhere.getState(), rowFlags(S(), second, tab));
    assert.equal(elsewhere.getState() & SELECTED, 0);
    stop();
    const space = S().createSpace({ name: "Other" });
    S().switchSpace(second, space);
    assert.equal(elsewhere.getState(), rowFlags(S(), second, tab));
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("tab row flags follow the installed window reader instead of the local singleton", () => {
  S().hydrate({});
  const store = createBrowserStore();
  const state = () => store.getState();
  const windowId = state().createWindow({ url: "https://remote.example" });
  const tabId = state().windows[windowId].activeTabIds.default;
  const restore = browserRead.install(createLocalBrowserReadSource(store));
  const row = tabRowStore(windowId, tabId);
  const seen = [];
  const stop = row.subscribe((value) => seen.push(value));
  try {
    assert.equal(row.getState(), ACTIVE);
    assert.equal(S().tabs[tabId], undefined);
    state().updateLive(tabId, { isLoading: true });
    assert.deepEqual(seen, [ACTIVE | LOADING]);
    state().setSelection(windowId, [tabId]);
    assert.equal(seen.at(-1), ACTIVE | LOADING | SELECTED);
    for (let i = 1; i <= 10; i++) state().updateLive(tabId, { progress: i / 10 });
    assert.equal(seen.length, 2);
  } finally {
    stop();
    restore();
  }
});
