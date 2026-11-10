import assert from "node:assert/strict";
import { test } from "node:test";

const { useBrowser } = await import("./browserStore.ts");
const { tidyCandidates } = await import("./tabTidying.ts");

const S = () => useBrowser.getState();
const groupOfTab = (id) => Object.values(S().groups).find((g) => g.tabIds.includes(id));

test("tidy tabs groups the list's tabs by site and leaves pinned tabs", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/a" });
  const first = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const second = S().newTab(w, { url: "https://github.com/b", background: true });
  const pinned = S().newTab(w, { url: "https://github.com/c", background: true });
  S().pinRows([pinned], true);
  const old = S().newTab(w, { url: "https://github.com/d", background: true });
  S().updateTab(old, { createdAt: 0, lastActiveAt: 0 });
  const lone = S().newTab(w, { url: "https://example.com", background: true });

  assert.equal(S().tidyTabs(w), 1);
  const group = groupOfTab(first);
  assert.ok(group);
  // A tab from before today is still on the list, so it sorts with the rest.
  assert.deepEqual([...group.tabIds].sort(), [first, second, old].sort());
  assert.equal(groupOfTab(pinned), undefined);
  assert.equal(groupOfTab(lone), undefined);
});

test("tidy tabs leaves tabs already in a group alone", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/a" });
  const first = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const second = S().newTab(w, { url: "https://github.com/b", background: true });
  const groupId = S().groupTabs([first, second], { pinned: false, name: "Mine" });
  const before = S().groups;
  assert.equal(S().tidyTabs(w), 0);
  assert.equal(S().groups, before);
  assert.deepEqual([...S().groups[groupId].tabIds].sort(), [first, second].sort());
});

const list = (...paths) => {
  S().hydrate({});
  const w = S().createWindow({ url: `https://example.com/${paths[0]}` });

  const ids = [
    S().windows[w].activeTabIds[S().windows[w].spaceId],
    ...paths.slice(1).map((p) => S().newTab(w, { url: `https://example.com/${p}`, background: true })),
  ];

  return { w, ids };
};

test("tidy tabs applies a plan's names across sites and leaves the rest loose", () => {
  const { w, ids } = list("a", "b", "c", "d");
  assert.equal(S().tidyTabs(w, { newGroups: [{ name: "Trip", tabIds: [ids[0], ids[2]] }], joins: [] }), 1);
  assert.equal(groupOfTab(ids[0]).name, "Trip");
  assert.equal(groupOfTab(ids[2]), groupOfTab(ids[0]));
  assert.equal(groupOfTab(ids[1]), undefined);
  assert.equal(groupOfTab(ids[3]), undefined);
});

test("tidy tabs adds to a group the list already has", () => {
  const { w, ids } = list("a", "b", "c", "d");
  const groupId = S().groupTabs([ids[0], ids[1]], { pinned: false, name: "Trip" });
  S().updateGroup(groupId, { collapsed: true });
  assert.equal(S().tidyTabs(w, { newGroups: [], joins: [{ groupId, tabIds: [ids[2], ids[3]] }] }), 1);
  assert.deepEqual([...S().groups[groupId].tabIds].sort(), [...ids].sort());
  assert.equal(S().groups[groupId].collapsed, false);
});

test("a plan skips tabs that were closed, grouped or split while the model thought", () => {
  const { w, ids } = list("a", "b", "c", "d", "e", "f");
  const plan = { newGroups: [{ name: "Late", tabIds: [ids[0], ids[1], ids[2], ids[3]] }], joins: [] };
  S().closeTab(ids[0]);
  S().groupTabs([ids[1], ids[4]], { pinned: false, name: "Mine" });
  S().createSplit([ids[2], ids[5]]);
  assert.equal(S().tidyTabs(w, plan), 0);
  assert.equal(groupOfTab(ids[3]), undefined);
});

test("one undo puts a tidy back", () => {
  const { w, ids } = list("a", "b", "c");
  assert.equal(S().tidyTabs(w, { newGroups: [{ name: "Trip", tabIds: [ids[0], ids[1]] }], joins: [] }), 1);
  assert.equal(S().undoSidebarEdit(w), true);
  assert.equal(groupOfTab(ids[0]), undefined);
});

test("only web pages are candidates, not pinned, grouped or split tabs", () => {
  const { w, ids } = list("a", "b", "c", "d");
  const page = S().newTab(w, { url: "bay://history", background: true });
  S().pinRows([ids[0]], true);
  S().groupTabs([ids[1]], { pinned: false, name: "Mine" });
  const candidates = tidyCandidates(S(), w);
  assert.deepEqual(candidates.sort(), [ids[2], ids[3]].sort());
  assert.equal(candidates.includes(page), false);
});
