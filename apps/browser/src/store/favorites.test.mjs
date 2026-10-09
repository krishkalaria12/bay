// Favourites (the pinned tiles) are shared by the spaces with one profile, as Arc's: listed in each, opened in the one
// on screen, and brought back with any of them.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { sidebarEntries } = await import("../components/sidebar/entries.ts");

const S = () => useBrowser.getState();
const urls = (ids) => ids.map((id) => S().tabs[id].url);

// Personal (the default space), Work sharing its profile, and Side with a profile of its own; a Personal window with a
// favourite (a.com) and a page (b.com).
const setup = () => {
  S().hydrate({});
  const personal = S().settings.defaultSpaceId;
  const work = S().createSpace({ name: "Work", shareWith: personal });
  const side = S().createSpace({ name: "Side", shareWith: null });
  const w = S().createWindow({ spaceId: personal, url: "https://a.com" });
  const fav = S().windows[w].tabIds[0];
  S().newTab(w, { url: "https://b.com" });
  S().pinTabs([fav], true);
  return { personal, work, side, w, fav };
};

test("a favourite shows in every space with its profile, and only those", () => {
  const { personal, work, side, w } = setup();
  assert.deepEqual(urls(model.favoriteTabIds(S(), w, personal)), ["https://a.com"]);
  assert.deepEqual(urls(model.favoriteTabIds(S(), w, work)), ["https://a.com"], "Work shares Personal's profile");
  assert.deepEqual(model.favoriteTabIds(S(), w, side), [], "Side has a profile of its own");
  assert.deepEqual(urls(sidebarEntries(S(), w, work).tiles), ["https://a.com"]);
  assert.deepEqual(sidebarEntries(S(), w, work).list, [], "the page stays Personal's");
});

test("opening a shared favourite keeps the space on screen, and makes it that space's", () => {
  const { work, w, fav } = setup();
  S().switchSpace(w, work);
  assert.equal(S().windows[w].spaceId, work);
  S().activate(fav);
  assert.equal(S().windows[w].spaceId, work, "the window stays on Work");
  assert.equal(S().tabs[fav].spaceId, work);
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

test("favourites parked with a closed window come back with a window on another space with the profile", () => {
  const { personal, work, w } = setup();
  S().closeWindow(w);
  assert.ok(S().parkedPins[personal], "closing the window parked Personal's favourite");
  const next = S().createWindow({ spaceId: work, url: "https://c.com" });
  assert.deepEqual(urls(model.favoriteTabIds(S(), next, work)), ["https://a.com"]);
  const [tile] = model.favoriteTabIds(S(), next, work);
  assert.equal(S().tabs[tile].spaceId, personal, "it stays Personal's until opened");
  assert.equal(S().parkedPins[personal], undefined);
});

test("switching to a space whose remembered favourite is already its own shows that space", () => {
  const { personal, work, w, fav } = setup();
  S().switchSpace(w, work);
  S().activate(fav);
  S().switchSpace(w, personal);
  assert.equal(S().windows[w].spaceId, personal, "Personal shows its own page");
  S().switchSpace(w, work);
  assert.equal(S().windows[w].spaceId, work, "back on Work, not kept on Personal");
  assert.equal(S().tabs[fav].spaceId, work);
  assert.equal(model.activeTabId(S(), w), fav);
});
