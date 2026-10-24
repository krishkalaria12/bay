import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../test-native-stub.mjs");
const { useBrowser } = await import("../store/browser.ts");
const { loadSession, startPersistence } = await import("./persist.ts");
const { engineProfile } = await import("../store/model.ts");

const legacy = () => ({
  version: 2,
  profiles: {
    default: { id: "default", name: "Personal", color: "blue", icon: null, createdAt: 0 },
    work: { id: "work", name: "Work", color: "green", icon: null, createdAt: 1, profileId: "default" },
  },
  profileOrder: ["work", "default"],
  windows: [],
  tabs: [],
  groups: [],
  splits: [],
  closedTabs: [],
  closedWindows: [],
});

test("legacy profile names restore, shared profiles split durably, and original session stays backed up", () => {
  stub.docs.clear();
  const original = JSON.stringify(legacy());
  stub.docs.set("session.json", original);
  const stop = startPersistence();
  assert.notEqual(engineProfile("default"), engineProfile("work"));
  const saved = JSON.parse(stub.docs.get("session.json"));
  assert.ok(saved.spaces.work);
  assert.equal(saved.spaces.work.profileId, undefined);
  assert.equal(stub.docs.get("session.before-space-isolation.json"), original);
  stop();
  const restored = loadSession();
  useBrowser.getState().hydrate(restored);
  assert.equal(engineProfile("work"), "work");
  assert.equal(stub.docs.get("session.before-space-isolation.json"), original);
});

test("legacy cache migrations retain shared data only in the original owner", () => {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(legacy()));
  const list = [{ url: "https://private.example", title: "Private", visits: 1, lastVisit: 100 }];
  const history = JSON.stringify({ history: { work: list } });
  const roots = { bar: "old-bar", other: "old-other" };
  const bookmarks = JSON.stringify({ bookmarks: { nodes: {}, roots: { work: roots } } });
  stub.docs.set("history.json", history);
  stub.docs.set("bookmarks.json", bookmarks);
  loadSession();
  assert.deepEqual(JSON.parse(stub.docs.get("history.json")).history, { default: list });
  assert.deepEqual(JSON.parse(stub.docs.get("bookmarks.json")).bookmarks.roots, { default: roots });
  assert.equal(stub.docs.get("history.before-space-isolation.json"), history);
  assert.equal(stub.docs.get("bookmarks.before-space-isolation.json"), bookmarks);
  loadSession();
  assert.equal(stub.docs.get("history.before-space-isolation.json"), history);
  assert.deepEqual(JSON.parse(stub.docs.get("history.json")).history, { default: list });
});

test("a pre-space session retains tabs, parked pins, native directories and saved preferences", () => {
  stub.docs.clear();
  const snapshot = {
    profileId: "work",
    url: "https://saved.example/",
    title: "Saved",
    favicon: null,
    pinned: false,
    muted: false,
    zoom: 1,
    customTitle: null,
    customIcon: null,
    pinnedUrl: null,
  };
  const original = JSON.stringify({
    ...legacy(),
    profiles: { work: { id: "work", name: "Work", color: "green", icon: null, createdAt: 1, dataId: "retained-engine" } },
    profileOrder: ["work"],
    settings: {
      launchTab: "lastTab",
      defaultProfileId: "work",
      openLinksInHarbor: true,
      harborSize: [777, 555],
      warnBeforeMovingTabsToProfile: false,
      shortcuts: { newHarbor: ["cmd+shift+n"], nextProfile: ["ctrl+tab"] },
    },
    windows: [
      { id: "window", profileId: "work", incognito: false, tabIds: ["tab"], activeTabIds: { work: "tab" }, sidebarOpen: true, frame: null, createdAt: 1 },
    ],
    windowOrder: ["window"],
    focusedWindowId: "window",
    tabs: [{ ...snapshot, id: "tab", windowId: "window", openerId: null, navigation: null, createdAt: 1, lastActiveAt: 1 }],
    parkedPins: { work: { tabs: [{ ...snapshot, id: "parked", url: "https://pin.example/", pinned: true, groupId: null }], groups: [] } },
    closedTabs: [{ kind: "tab", id: "closed", tab: snapshot, windowId: "window", index: 0, group: null, closedAt: 1 }],
    closedWindows: [
      {
        kind: "window",
        id: "closed-window",
        window: { profileId: "work", sidebarOpen: true, frame: null },
        tabs: [{ ...snapshot, active: true }],
        groups: [],
        closedAt: 1,
      },
    ],
  });
  stub.docs.set("session.json", original);
  const stop = startPersistence();
  try {
    const state = useBrowser.getState();
    assert.equal(state.tabs.tab.url, "https://saved.example/");
    assert.equal(state.tabs.tab.spaceId, "work");
    assert.equal(state.windows.window.activeTabIds.work, "tab");
    assert.equal(state.tabs.parked.url, "https://pin.example/");
    assert.ok(state.tabLists.work.includes("parked"));
    assert.equal(state.closedTabs[0].tab.spaceId, "work");
    assert.equal(state.closedWindows[0].window.spaceId, "work");
    assert.equal(state.closedWindows[0].tabs[0].spaceId, "work");
    assert.equal(engineProfile("work"), "retained-engine");
    assert.equal(state.settings.defaultSpaceId, "work");
    assert.equal(state.settings.openLinksInLittleBay, true);
    assert.deepEqual(state.settings.littleBaySize, [777, 555]);
    assert.equal(state.settings.warnBeforeMovingTabsToSpace, false);
    assert.deepEqual(state.settings.shortcuts, { newLittleBay: ["cmd+shift+n"], nextSpace: ["ctrl+tab"] });
    assert.equal(stub.docs.get("session.before-space-isolation.json"), original);
    const saved = JSON.parse(stub.docs.get("session.json"));
    assert.equal(saved.tabs.find((tab) => tab.id === "tab").spaceId, "work");
    assert.equal(saved.spaces.work.profileId, "retained-engine");
    assert.equal(saved.profiles, undefined);
  } finally {
    stop();
  }
});

test("current settings take precedence over legacy names and SmallYahu preferences still migrate", async () => {
  const { restoreSettings } = await import("../store/settings.ts");
  const old = restoreSettings({ openLinksInSmallYahu: true, smallYahuSize: [800, 600], shortcuts: { newSmallYahu: ["cmd+n"] } });
  assert.equal(old.openLinksInLittleBay, true);
  assert.deepEqual(old.littleBaySize, [800, 600]);
  assert.deepEqual(old.shortcuts, { newLittleBay: ["cmd+n"] });
  const current = restoreSettings({
    defaultSpaceId: "current",
    defaultProfileId: "old",
    openLinksInLittleBay: false,
    openLinksInHarbor: true,
    littleBaySize: [900, 700],
    harborSize: [800, 600],
    shortcuts: { newLittleBay: ["cmd+t"], newHarbor: ["cmd+n"] },
  });
  assert.equal(current.defaultSpaceId, "current");
  assert.equal(current.openLinksInLittleBay, false);
  assert.deepEqual(current.littleBaySize, [900, 700]);
  assert.deepEqual(current.shortcuts, { newLittleBay: ["cmd+t"] });
});

test("explicit shared sign-ins from dataId sessions remain shared after the rename", () => {
  stub.docs.clear();
  const saved = legacy();
  delete saved.profiles.work.profileId;
  saved.profiles.work.dataId = "default";
  stub.docs.set("session.json", JSON.stringify(saved));
  const stop = startPersistence();
  try {
    assert.equal(engineProfile("work"), engineProfile("default"));
    assert.equal(useBrowser.getState().spaces.work.sharesSignIns, true);
    assert.equal(JSON.parse(stub.docs.get("session.json")).spaces.work.profileId, "default");
  } finally {
    stop();
  }
});
