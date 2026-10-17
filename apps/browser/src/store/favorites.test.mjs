// Favorites belong to their space, survive window closure, and never appear in another space.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { sidebarEntries } = await import("../components/sidebar/entries.ts");

const S = () => useBrowser.getState();
const urls = (ids) => ids.map((id) => S().tabs[id].url);

// Personal, Work and Side each own a profile. A Personal window has a
// favourite (a.com) and a page (b.com).
const setup = () => {
  S().hydrate({});
  const personal = S().settings.defaultSpaceId;
  const work = S().createSpace({ name: "Work" });
  const side = S().createSpace({ name: "Side" });
  const w = S().createWindow({ spaceId: personal, url: "https://a.com" });
  const fav = S().windows[w].activeTabIds[S().windows[w].spaceId];
  S().newTab(w, { url: "https://b.com" });
  S().pinTabs([fav], true);
  return { personal, work, side, w, fav };
};

test("a favorite appears only in its owning space", () => {
  const { personal, work, side, w } = setup();
  assert.deepEqual(urls(model.favoriteTabIds(S(), w, personal)), ["https://a.com"]);
  assert.deepEqual(model.favoriteTabIds(S(), w, work), []);
  assert.deepEqual(model.favoriteTabIds(S(), w, side), [], "Side has a profile of its own");
  assert.deepEqual(sidebarEntries(S(), w, work).tiles, []);
  assert.deepEqual(sidebarEntries(S(), w, work).list, [], "the page stays Personal's");
});

test("opening another space's favorite switches to its owner", () => {
  const { personal, work, w, fav } = setup();
  S().switchSpace(w, work);
  assert.equal(S().windows[w].spaceId, work);
  S().activate(fav);
  assert.equal(S().windows[w].spaceId, personal);
  assert.equal(S().tabs[fav].spaceId, personal);
  assert.equal(model.activeTabId(S(), w), fav);
});

test("going back to a space that remembers a favourite opened since elsewhere brings it back there", () => {
  const { personal, work, w, fav } = setup();
  S().activate(fav);
  S().switchSpace(w, work);
  S().activate(fav);
  S().switchSpace(w, personal);
  assert.equal(S().windows[w].spaceId, personal, "back on Personal, not pulled to Work");
  assert.equal(S().tabs[fav].spaceId, personal);
  assert.equal(model.activeTabId(S(), w), fav);
});

test("a space with its own profile doesn't take another's favourite: opening it goes to its space", () => {
  const { personal, side, w, fav } = setup();
  S().switchSpace(w, side);
  S().activate(fav);
  assert.equal(S().tabs[fav].spaceId, personal);
  assert.equal(S().windows[w].spaceId, personal);
});

test("favorites survive window closure without appearing in another space", () => {
  const { personal, work, w, fav } = setup();
  S().closeWindow(w);
  assert.ok(S().tabs[fav]?.unloaded, "the favourite waits, unloaded");
  const next = S().createWindow({ spaceId: work, url: "https://c.com" });
  assert.deepEqual(model.favoriteTabIds(S(), next, work), []);
  assert.deepEqual(urls(model.favoriteTabIds(S(), next, personal)), ["https://a.com"]);
  assert.equal(S().tabs[fav].spaceId, personal, "it stays Personal's until opened");
});

test("switching spaces does not reuse another space's remembered favorite", () => {
  const { personal, work, w, fav } = setup();
  S().switchSpace(w, work);
  S().activate(fav);
  S().switchSpace(w, personal);
  assert.equal(S().windows[w].spaceId, personal, "Personal shows its own page");
  S().switchSpace(w, work);
  assert.equal(S().windows[w].spaceId, work, "back on Work, not kept on Personal");
  assert.equal(S().tabs[fav].spaceId, personal);
  assert.notEqual(model.activeTabId(S(), w), fav);
});
