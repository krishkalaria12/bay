// A space's profile can change after it's made, as Arc's Change Profile: to another space's, or to a new one of its
// own. Its tabs reload in it, and a profile no space uses any more goes.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { ownsProfileData, sharingProfiles } = await import("./profiles.ts");

const S = () => useBrowser.getState();
const urls = (ids) => ids.map((id) => S().tabs[id].url);

// Personal (the default space) with a favourite (a.com) and a page (b.com), Work sharing its profile, and Side with a
// profile of its own and a page (c.com).
const setup = () => {
  S().hydrate({});
  const personal = S().settings.defaultProfileId;
  const work = S().createProfile({ name: "Work", shareWith: personal });
  const side = S().createProfile({ name: "Side", shareWith: null });
  const w = S().createWindow({ profileId: personal, url: "https://a.com" });
  const fav = S().windows[w].tabIds[0];
  S().newTab(w, { url: "https://b.com" });
  S().pinTabs([fav], true);
  S().switchProfile(w, side);
  const page = S().newTab(w, { url: "https://c.com" });
  S().switchProfile(w, work);
  return { personal, work, side, w, fav, page };
};

test("a space sharing a profile can take a new one of its own; the other keeps the old one", () => {
  const { personal, work, w } = setup();
  S().changeProfileData(work, null);
  assert.equal(S().profiles[work].dataId, undefined, "its own id names its new profile");
  assert.notEqual(model.engineProfile(work), model.engineProfile(personal));
  assert.deepEqual(sharingProfiles(S(), work), []);
  assert.deepEqual(S().orphanedProfileData, [], "Personal still uses the old profile");
  assert.deepEqual(model.favoriteTabIds(S(), w, work), [], "Personal's favourite isn't Work's any more");
  assert.notDeepEqual(S().bookmarks.roots[work], S().bookmarks.roots[personal]);
  assert.equal(S().historyReady[work], undefined, "its history is read from its new profile");
});

test("the space a profile is named after can leave it: it takes a new id, and the others keep the profile", () => {
  const { personal, work } = setup();
  const engine = model.engineProfile(personal);
  S().changeProfileData(personal, null);
  assert.ok(S().profiles[personal].dataId, "its own id still names the profile Work uses");
  assert.notEqual(model.engineProfile(personal), engine);
  assert.equal(model.engineProfile(work), engine);
  assert.ok(ownsProfileData(S(), work), "Work syncs the profile's data now");
  assert.ok(ownsProfileData(S(), personal));
});

test("a space can take another's profile: it shares their favourites and bookmarks, and its old profile goes", () => {
  const { personal, side, w } = setup();
  const engine = model.engineProfile(side);
  S().changeProfileData(side, personal);
  assert.equal(model.engineProfile(side), model.engineProfile(personal));
  assert.deepEqual(S().orphanedProfileData, [engine], "no space uses Side's old profile");
  assert.deepEqual(urls(model.favoriteTabIds(S(), w, side)), ["https://a.com"]);
  assert.deepEqual(S().bookmarks.roots[side], S().bookmarks.roots[personal]);
  assert.equal(S().bookmarks.nodes[`bar@${engine}`], undefined, "the old profile's bookmarks went with it");
});

test("a space's pages reload in its new profile; one that hasn't loaded stays so", () => {
  const { side, w, page } = setup();
  const before = S().tabs[page].navigation;
  const asleep = S().newTab(w, { url: "https://d.com", profileId: side, background: true });
  S().updateTab(asleep, { navigation: null, wakeAdoptId: "restore:x" });
  S().changeProfileData(side, null);
  assert.equal(S().tabs[page].navigation, before, "Side has its own profile already: nothing changes");
  S().changeProfileData(side, S().settings.defaultProfileId);
  assert.notEqual(S().tabs[page].navigation, before);
  assert.equal(S().tabs[page].navigation.url, "https://c.com");
  assert.equal(S().tabs[asleep].navigation, null);
  assert.equal(S().tabs[asleep].wakeAdoptId, undefined, "its closed page was the old profile's");
});

test("a profile left while its data is still going isn't reused", () => {
  const { personal, side } = setup();
  S().changeProfileData(side, personal);
  const gone = S().orphanedProfileData[0];
  S().changeProfileData(side, null);
  assert.notEqual(model.engineProfile(side), gone);
  assert.ok(S().profiles[side].dataId);
});
