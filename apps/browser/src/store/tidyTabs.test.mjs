import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");

const S = () => useBrowser.getState();
const groupOfTab = (id) => Object.values(S().groups).find((g) => g.tabIds.includes(id));

test("tidy tabs groups today's tabs by site and leaves pinned and older tabs", () => {
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
  assert.deepEqual([...group.tabIds].sort(), [first, second].sort());
  assert.equal(groupOfTab(pinned), undefined);
  assert.equal(groupOfTab(old), undefined);
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
