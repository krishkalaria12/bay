// Every sidebar space has its own native browser profile. Older shared profiles split on hydration.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const S = () => useBrowser.getState();
const space = (id, profileId) => ({ id, name: id, color: "blue", icon: null, createdAt: 0, ...(profileId ? { profileId } : {}) });
const history = [{ url: "https://visited.example/", title: "Visited", favicon: null, visits: 1, lastVisit: 10 }];
const save = () =>
  JSON.parse(
    JSON.stringify({
      spaces: S().spaces,
      spaceOrder: S().spaceOrder,
      tabs: S().tabs,
      tabLists: S().tabLists,
      bookmarks: S().bookmarks,
      history: S().history,
      orphanedProfileData: S().orphanedProfileData,
    }),
  );

test("new spaces have separate native history and bookmarks, even with a legacy sharing option", () => {
  S().hydrate({});
  const personal = S().settings.defaultSpaceId;
  S().importHistory(personal, history);
  const bookmark = S().addBookmark({ spaceId: personal, url: "https://saved.example/", title: "Saved" });
  const work = S().createSpace({ name: "Work", shareWith: personal });
  assert.notEqual(model.engineProfile(personal), model.engineProfile(work));
  assert.notDeepEqual(S().bookmarks.roots[personal], S().bookmarks.roots[work]);
  assert.equal(S().history[work], undefined);
  S().importHistory(work, [{ ...history[0], url: "https://work.example/" }]);
  assert.deepEqual(
    S().history[personal].map((h) => h.url),
    [history[0].url],
  );
  assert.ok(S().bookmarks.nodes[bookmark]);
  assert.equal(S().setSpaceProfile, undefined, "profiles cannot be reassigned between spaces");
});

test("legacy sharing preserves the named owner, its native directory and bookmarks", () => {
  S().hydrate({});
  const bookmark = S().addBookmark({ spaceId: "default", url: "https://saved.example/", title: "Saved" });
  const bookmarks = S().bookmarks;
  S().hydrate({
    spaces: { work: space("work", "default"), default: space("default") },
    spaceOrder: ["work", "default"],
    bookmarks: { ...bookmarks, roots: { ...bookmarks.roots, work: bookmarks.roots.default } },
    history: { default: history, work: history },
    orphanedProfileData: [""],
  });
  assert.equal(model.engineProfile("default"), "");
  assert.equal(model.engineProfile("work"), "work");
  assert.deepEqual(S().history.default, history);
  assert.equal(S().history.work, undefined);
  assert.equal(S().historyReady.work, undefined);
  assert.equal(S().bookmarksReady.work, undefined);
  assert.ok(S().bookmarks.nodes[bookmark]);
  assert.notDeepEqual(S().bookmarks.roots.default, S().bookmarks.roots.work);
  assert.deepEqual(S().orphanedProfileData, [], "the original native directory must not be deleted");
});

test("a legacy profile without its named space belongs to the first ordered space", () => {
  S().hydrate({ spaces: { a: space("a", "old"), b: space("b", "old") }, spaceOrder: ["b", "a"], history: { a: history }, orphanedProfileData: ["old"] });
  assert.equal(model.engineProfile("b"), "old", "existing engine data keeps its alias");
  assert.equal(model.engineProfile("a"), "a");
  assert.deepEqual(S().history.b, history, "the shared saved view stays with its native owner");
  assert.equal(S().history.a, undefined);
  assert.deepEqual(S().orphanedProfileData, []);
});

test("splitting legacy shared lists preserves each space's tab order and favorites", () => {
  S().hydrate({});
  const work = S().createSpace({ name: "Work" });
  const w = S().createWindow({ url: "https://personal.example/" });
  const personalTab = model.activeTabId(S(), w);
  S().pinTabs([personalTab], true);
  const row = S().newTab(w, { spaceId: work, url: "https://row.example/", background: true });
  S().updateTab(row, { pinnedRow: true });
  const fav = S().newTab(w, { spaceId: work, url: "https://favorite.example/", background: true });
  S().pinTabs([fav], true);
  const page = S().newTab(w, { spaceId: work, url: "https://page.example/", background: true });
  const saved = save();
  saved.spaces[work].profileId = "default";
  saved.tabLists = { default: [personalTab, fav, row, page] };
  saved.tabs[page].wakeAdoptId = "restore:old-profile";
  S().hydrate(saved);
  assert.deepEqual(model.spaceTabIds(S(), "default"), [personalTab]);
  assert.deepEqual(model.spaceTabIds(S(), work), [fav, row, page]);
  assert.equal(S().tabs[page].wakeAdoptId, undefined, "restored pages cannot adopt the old native context");
  assert.equal(S().tabs[fav].spaceId, work);
  assert.equal(S().tabs[row].pinnedRow, true);
});

test("migration avoids active native ids and native data still queued for deletion", () => {
  const saved = {
    spaces: { default: space("default", "shared"), shared: space("shared"), work: space("work", "shared"), other: space("other", "work-isolated") },
    spaceOrder: ["default", "work", "shared", "other"],
    orphanedProfileData: ["work"],
  };
  S().hydrate(saved);
  const native = S().spaceOrder.map(model.engineProfile);
  assert.equal(new Set(native).size, native.length);
  assert.notEqual(model.engineProfile("work"), "work");
  assert.notEqual(model.engineProfile("work"), "work-isolated");
  assert.equal(model.engineProfile("shared"), "shared");
  assert.deepEqual(S().orphanedProfileData, ["work"]);
  const migrated = save();
  S().hydrate(migrated);
  assert.deepEqual(save(), migrated, "an already migrated session stays unchanged");
});

test("unique historical aliases keep their native data and tab list becomes space-owned", () => {
  S().hydrate({ spaces: { work: space("work", "historical") }, spaceOrder: ["work"], history: { work: history } });
  assert.equal(model.engineProfile("work"), "historical");
  assert.deepEqual(S().bookmarks.roots.work, { bar: "bar@historical", other: "other@historical" });
  assert.equal(model.spaceListKey(S(), "work"), "work");
  assert.deepEqual(S().history.work, history);
  S().hydrate({});
  assert.equal(model.engineProfile("work"), "work", "the native registry follows the next hydrated session");
});

test("the canonical owner rekeys cached bookmark roots and detached roots start empty", () => {
  const bar = { kind: "folder", id: "legacy-bar", parentId: null, title: "Bookmarks Bar", children: ["saved"], addedAt: 0 };
  const other = { kind: "folder", id: "legacy-other", parentId: null, title: "Other Bookmarks", children: [], addedAt: 0 };
  const saved = { kind: "url", id: "saved", parentId: bar.id, title: "Saved", url: "https://saved.example/", favicon: null, addedAt: 0 };
  S().hydrate({
    spaces: { a: space("a", "old"), b: space("b", "old") },
    spaceOrder: ["a", "b"],
    bookmarks: {
      nodes: { [bar.id]: bar, [other.id]: other, saved, "bar@b": { ...bar, id: "bar@b" } },
      roots: { a: { bar: bar.id, other: other.id }, b: { bar: bar.id, other: other.id } },
    },
  });
  assert.deepEqual(S().bookmarks.roots.a, { bar: "bar@old", other: "other@old" });
  assert.deepEqual(S().bookmarks.nodes["bar@old"].children, ["saved"]);
  assert.equal(S().bookmarks.nodes.saved.parentId, "bar@old");
  assert.equal(S().bookmarks.nodes[bar.id], undefined, "the replaced bar root is not a duplicate tree");
  assert.equal(S().bookmarks.nodes[other.id], undefined);
  assert.equal(Object.keys(S().bookmarks.nodes).length, 5);
  assert.deepEqual(S().bookmarks.nodes["bar@b"].children, [], "an unused cached root is not another space's bookmarks");
});
