// As Arc's, tabs are their space's, not a window's: every window on a space lists the same tabs, a tab's page is in
// the window that last showed it, and closing a window keeps its tabs. A private window's tabs and a Little Bay's page
// are their window's own.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const stub = await import("../test-native-stub.mjs");
const { flushPersistence, loadSession, startPersistence } = await import("../lib/persist.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com\/?$/g, "");
const listed = (w) => model.viewTabIds(S(), w).map(short);
const shown = (w) => short(model.activeTabId(S(), w));

// Two windows on the default space: the first made a.com and b.com, the second shows c.com.
const setup = () => {
  S().hydrate({});
  const one = S().createWindow({ url: "https://a.com" });
  const a = model.activeTabId(S(), one);
  const b = S().newTab(one, { url: "https://b.com", background: true });
  const two = S().createWindow({ url: "https://c.com" });
  const c = model.activeTabId(S(), two);
  return { one, two, a, b, c };
};

test("every window on a space lists its tabs, the ones another window opened too", () => {
  const { one, two } = setup();
  assert.deepEqual(listed(one), ["a", "b", "c"]);
  assert.deepEqual(listed(two), ["a", "b", "c"]);
  S().newTab(two, { url: "https://d.com" });
  assert.deepEqual(listed(one), ["a", "b", "c", "d"]);
});

test("showing a tab in another window moves its page there; the window it left says so", () => {
  const { one, two, a } = setup();
  S().activate(a, two);
  assert.equal(S().tabs[a].windowId, two, "its page is in the window that shows it");
  assert.equal(shown(two), "a");
  assert.equal(S().windows[one].activeTabIds.default, a, "the first window still shows it");
  assert.ok(model.shownElsewhere(S(), a, one), "so it shows that it's open in another window");
  S().activate(a, one);
  assert.equal(S().tabs[a].windowId, one, "Show Here brings it back");
});

test("closing a window keeps its tabs; their pages unload, and the next window shows them", () => {
  const { one, two, a, b } = setup();
  S().closeWindow(one);
  assert.equal(S().windows[one], undefined);
  assert.deepEqual(listed(two), ["a", "b", "c"]);
  assert.equal(S().tabs[a].windowId, "");
  assert.ok(S().tabs[a].unloaded && !S().tabs[a].navigation);
  assert.ok(S().tabs[b]);
  const next = S().createWindow();
  assert.deepEqual(listed(next).slice(0, 3), ["a", "b", "c"]);
});

test("a window coming to a space doesn't take the tab another window shows", () => {
  const { one, two, b } = setup();
  const work = S().createSpace({ name: "Work" });
  S().switchSpace(two, work);
  S().switchSpace(two, "default");
  assert.equal(shown(two), "c", "the tab it showed there");
  S().activate(b, one);
  const third = S().createWindow({ spaceId: work });
  S().switchSpace(third, "default");
  assert.notEqual(model.activeTabId(S(), third), model.activeTabId(S(), one));
  assert.notEqual(model.activeTabId(S(), third), model.activeTabId(S(), two));
});

test("moving a tab to another window shows it there, and the window it left shows its next one", () => {
  const { one, two, a } = setup();
  S().moveTabsToWindow([a], two);
  assert.equal(S().tabs[a].windowId, two);
  assert.equal(shown(two), "a");
  assert.equal(shown(one), "b");
  assert.deepEqual(listed(one), ["a", "b", "c"], "it's still the space's");
});

test("a private window's tabs are its own, and go with it", () => {
  const { one } = setup();
  const p = S().createWindow({ incognito: true, url: "https://secret.com" });
  const secret = model.activeTabId(S(), p);
  assert.ok(!listed(one).includes("secret"));
  assert.deepEqual(listed(p), ["secret"]);
  S().closeWindow(p);
  assert.equal(S().tabs[secret], undefined);
});

test("Little Bay's page isn't its space's until it moves to a main window", () => {
  const { one } = setup();
  const little = S().createWindow({ small: true, url: "https://quick.com" });
  const page = model.activeTabId(S(), little);
  assert.ok(!listed(one).includes("quick"));
  S().moveTabsToWindow([page], one);
  assert.equal(S().windows[little], undefined, "Little Bay goes with its page");
  assert.ok(listed(one).includes("quick"));
  assert.equal(shown(one), "quick");
});

test("a space that changes profile takes its tabs to its new profile's list, its favourites too", () => {
  const { one, a } = setup();
  S().pinTabs([a], true);
  const work = S().createSpace({ name: "Work" });
  S().switchSpace(one, work);
  const w = model.activeTabId(S(), one);
  S().setSpaceProfile("default", work);
  assert.deepEqual(model.favoriteTabIds(S(), one, work).map(short), ["a"], "Personal's favourite is Work's profile's now");
  assert.ok(model.spaceTabIds(S(), "default").map(short).includes("b"));
  assert.ok(model.listIds(S(), model.spaceListKey(S(), work)).includes(w));
});

test("a session keeps each space's tabs in order, and none of a private window's or Little Bay's", () => {
  stub.docs.clear();
  // Persistence starts from the saved session (none): the windows come after.
  const stop = startPersistence();
  const { one } = setup();
  S().pinTabs([model.activeTabId(S(), one)], true);
  S().createWindow({ incognito: true, url: "https://secret.com" });
  S().createWindow({ small: true, url: "https://quick.com" });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  const urls = Object.values(S().tabs)
    .map((t) => short(t.id))
    .sort();
  assert.deepEqual(urls, ["a", "b", "c"]);
  assert.deepEqual(model.spaceTabIds(S(), "default").map(short), ["a", "b", "c"]);
  assert.equal(S().windowOrder.length, 2);
});
