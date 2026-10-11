// The automatic clean up is Arc's archive: on by default after 12 hours, for every space of every window (not only
// the one on screen), each space after its own time if it has one.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const { cleanUpHours } = await import("./organize.ts");
const model = await import("./model.ts");

const S = () => useBrowser.getState();
// These cases read lists in the order their tabs opened: new tabs go to the bottom.
(await import("./settings.ts")).DEFAULT_SETTINGS.newTabPosition = "bottom";
const HOUR = 3_600_000;
const urls = (w, spaceId) => model.viewTabIds(S(), w, spaceId).map((id) => S().tabs[id].url);

// Personal with an active page (a.com) and one unused for `hours` (b.com); Work with the same, c.com and d.com. The
// window ends on Personal.
const setup = (hours) => {
  S().hydrate({});
  const personal = S().settings.defaultSpaceId;
  const work = S().createSpace({ name: "Work" });
  const w = S().createWindow({ spaceId: personal, url: "https://a.com" });
  const b = S().newTab(w, { url: "https://b.com", background: true });
  S().switchSpace(w, work);
  S().navigate(S().windows[w].activeTabIds[work], "https://c.com");
  const d = S().newTab(w, { url: "https://d.com", background: true });
  S().switchSpace(w, personal);
  for (const id of [b, d]) S().updateTab(id, { lastActiveAt: Date.now() - hours * HOUR });
  return { personal, work, w };
};

test("a new install cleans up tabs unused for 12 hours", () => {
  S().hydrate({});
  assert.equal(S().settings.cleanUpInactiveTabsAfterHours, 12);
  assert.equal(cleanUpHours(S(), S().settings.defaultSpaceId), 12);
});

test("a saved choice to never clean up stays", () => {
  S().hydrate({ settings: { cleanUpInactiveTabsAfterHours: null } });
  assert.equal(S().settings.cleanUpInactiveTabsAfterHours, null);
});

test("the automatic clean up reaches the spaces a window isn't showing", () => {
  const { personal, work, w } = setup(13);
  assert.equal(S().cleanUpInactiveTabs(), 2);
  assert.deepEqual(urls(w, personal), ["https://a.com"]);
  assert.deepEqual(urls(w, work), ["https://c.com"], "Work's active tab stays");
  assert.equal(S().windows[w].spaceId, personal, "the window stays on its space");
});

test("a space's own time overrides the app's, and never keeps its tabs", () => {
  const { personal, work, w } = setup(30);
  S().updateSpace(personal, { cleanUpAfterHours: 168 });
  S().updateSpace(work, { cleanUpAfterHours: null });
  assert.equal(S().cleanUpInactiveTabs(), 0);
  S().updateSpace(personal, { cleanUpAfterHours: 24 });
  S().updateSettings({ cleanUpInactiveTabsAfterHours: null });
  assert.equal(S().cleanUpInactiveTabs(), 1, "Personal's 24 hours, with the app's turned off");
  assert.deepEqual(urls(w, work), ["https://c.com", "https://d.com"]);
});

test("Clean Up Tabs from the menu cleans the space on screen only", () => {
  const { work, w } = setup(13);
  assert.equal(S().cleanUpTabs(w), 1);
  assert.equal(urls(w, work).length, 2);
});

test("restoring one cleaned up tab puts it back in its space and returns it, as the command bar needs", () => {
  const { work, w } = setup(13);
  S().cleanUpInactiveTabs();
  const entry = S().cleanedTabs.find((c) => c.tab.url === "https://d.com");
  assert.ok(entry);
  const id = S().restoreCleaned(entry.id, w);
  assert.equal(S().tabs[id]?.url, "https://d.com");
  assert.equal(S().tabs[id].spaceId, work);
  assert.equal(S().windows[w].spaceId, work);
  assert.equal(S().windows[w].activeTabIds[work], id);
  assert.ok(!S().cleanedTabs.some((c) => c.id === entry.id));
  // Gone once restored, so a second pick falls back to opening the page.
  assert.equal(S().restoreCleaned(entry.id, w), undefined);
});
