// Writes the saved documents the React Native app writes, for the GPUI app's state crate to read and write back
// byte for byte (packages/rust/bay-state/tests, docs/gpui-desktop-plan.html D6). The benchmark seed's session goes
// through the app's own loading (loadSession, hydrate) and saving (sessionJson, the downloads document), so the
// fixtures are what an install holds after a launch.
//
//   node --no-warnings --import ./src/test-loader.mjs scripts/state-fixtures.mjs <out dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSeed } from "./perf/seed.mjs";

const out = process.argv[2];

if (!out) {
  console.error("usage: state-fixtures.mjs <out dir>");
  process.exit(2);
}

// Every optional field the session holds, each nullable one both null and set, and a field this build doesn't know
// (futureField), which a reader must carry through untouched.
const T = 1795800000000;

const tab = (id, patch = {}) => ({
  id,
  windowId: "w1",
  spaceId: "default",
  url: `https://${id}.example/`,
  title: `Tab "${id}"`,
  favicon: null,
  pinned: false,
  muted: false,
  zoom: 1,
  customTitle: null,
  customIcon: null,
  pinnedUrl: null,
  openerId: null,
  createdAt: T,
  lastActiveAt: T,
  ...patch,
});

const snapshot = (url) => ({ url, title: url, favicon: null, pinned: false, muted: false, zoom: 1, customTitle: null, customIcon: null, spaceId: "default" });

const rich = {
  version: 2,
  spaces: {
    default: {
      id: "default",
      name: "Personal",
      color: "plum",
      icon: "⌨️",
      createdAt: 0,
      theme: { colors: ["#3A6073", "#733A43"], intensity: 0.5, grain: 0.3 },
      followSite: false,
      cleanUpAfterHours: 12,
    },
    work: {
      id: "work",
      name: "Work",
      color: "blue",
      icon: null,
      createdAt: 1,
      theme: null,
      cleanUpAfterHours: null,
      folded: true,
      futureField: { kept: [1, 2] },
    },
    shared: { id: "shared", name: "Shared", color: "green", icon: null, createdAt: 2, profileId: "work", sharesSignIns: true },
  },
  spaceOrder: ["default", "work", "shared"],
  orphanedProfileData: ["old-profile"],
  settings: { restoreSession: true, unreadBadges: true, searchEngine: "google", futureSetting: [1, { nested: true }] },
  windows: [
    {
      id: "w1",
      spaceId: "default",
      incognito: false,
      activeTabIds: { default: "a", work: "w" },
      sidebarOpen: true,
      tabLayout: "top",
      frame: null,
      createdAt: T,
    },
  ],
  windowOrder: ["w1"],
  focusedWindowId: "w1",
  tabs: [
    tab("a", { favicon: "https://a.example/favicon.ico", pinned: true, pinnedUrl: "https://a.example/", customTitle: "Mine", customIcon: "🔥" }),
    tab("b", { pinnedRow: true, folderId: "f1", kept: true, muted: true, zoom: 1.25 }),
    tab("c", { pinnedRow: true, folderId: "f2", engine: "webkit", enginePick: { engine: "webkit", site: "netflix.com" } }),
    tab("d", { openerId: "a", unloaded: true, newTabHistory: { url: "https://d.example/", title: "D", favicon: null } }),
    tab("e", { liveItem: { folderId: "lf", itemId: "item-1" }, futureField: "kept" }),
    tab("s1"),
    tab("s2"),
    tab("w", { spaceId: "work", windowId: "" }),
  ],
  tabLists: { "space:default": ["a", "b", "c", "d", "e", "s1", "s2"], "space:work": ["w"] },
  groups: [
    {
      id: "g1",
      spaceId: "default",
      name: "Reading",
      icon: "📚",
      color: "cyan",
      collapsed: true,
      pinned: false,
      tabIds: ["d", "e"],
      createdAt: T,
      autoUngroup: true,
      pinnedOpenerId: "a",
    },
  ],
  pinnedFolders: [
    { id: "f1", spaceId: "default", name: "Docs", icon: null, collapsed: false, createdAt: T },
    { id: "f2", parentId: "f1", beforeId: "b", spaceId: "default", name: "Nested", icon: "🗂️", collapsed: true, createdAt: T },
  ],
  localFiles: [
    { id: "lf1", spaceId: "default", path: "/Users/someone/Documents/Notes", name: "Notes", kind: "folder", createdAt: T, order: 0, expanded: true },
  ],
  splits: [{ id: "sp1", tabIds: ["s1", "s2"], orientation: "horizontal", sizes: [0.4, 0.6], stack: { index: 1, sizes: [0.5, 0.5] } }],
  closedTabs: [
    {
      kind: "tab",
      id: "ct1",
      tab: { ...snapshot("https://closed.example/"), pinnedRow: true },
      tabId: "x",
      windowId: "w1",
      index: 3,
      group: { id: "g0", name: "Old", icon: null, color: null },
      closedAt: T,
      pinnedTile: false,
      small: false,
    },
  ],
  closedWindows: [
    {
      kind: "window",
      id: "cw1",
      window: { spaceId: "default", sidebarOpen: true, frame: null, shownTabId: "y" },
      tabs: [{ ...snapshot("https://window.example/"), active: true, tabId: "y" }],
      groups: [{ id: "g2", spaceId: "default", name: "Was open", icon: null, color: "red", collapsed: false, pinned: false, createdAt: T, tabIndexes: [0] }],
      closedAt: T,
    },
  ],
  closedGroups: [
    {
      kind: "group",
      id: "cg1",
      group: { id: "g3", name: "Closed group", icon: null, color: "orange", pinned: true },
      tabs: [snapshot("https://group.example/")],
      windowId: "w1",
      index: 0,
      closedAt: T,
    },
  ],
  deletedGroups: [
    {
      kind: "group",
      id: "dg1",
      group: { id: "g4", name: "Deleted", icon: null, color: null, pinned: false },
      tabs: [snapshot("https://deleted.example/")],
      windowId: "w1",
      index: 1,
      closedAt: T,
    },
  ],
  cleanedTabs: [{ kind: "tab", id: "cl1", tab: snapshot("https://cleaned.example/"), windowId: "w1", index: 5, group: null, closedAt: T }],
};

const richDownloads = {
  version: 2,
  downloads: [
    {
      id: "d1",
      url: "https://files.example/report.pdf",
      filename: "report.pdf",
      path: "/Users/someone/Downloads/report.pdf",
      state: "complete",
      receivedBytes: 1024,
      totalBytes: 1024,
      startedAt: T,
      profile: "default",
    },
  ],
};

const stub = await import("../src/test-native-stub.mjs");
const { DOCS, loadSession, sessionJson } = await import("../src/lib/persist.ts");
const { useBrowser } = await import("../src/store/browserStore.ts");
const downloads = DOCS.find((doc) => doc.name === "downloads.json");

/** What the app writes after launching on these documents: its own loading, then its own saving. */
function written(dir, session, downloadsDoc) {
  stub.docs.clear();
  stub.docs.set("session.json", JSON.stringify(session));
  stub.docs.set("downloads.json", JSON.stringify(downloadsDoc));
  useBrowser.getState().hydrate(loadSession());
  const state = useBrowser.getState();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), sessionJson(state));
  writeFileSync(join(dir, "downloads.json"), downloads.json(state));
}

const seed = buildSeed("http://127.0.0.1:9", "");

written(join(out, "seed"), seed["session.json"], seed["downloads.json"]);

written(join(out, "rich"), rich, richDownloads);

console.log(`wrote seed/ and rich/ to ${out}`);
