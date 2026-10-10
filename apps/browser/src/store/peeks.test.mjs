// Arc's Peek: a link from a pinned tab or a favourite opens over its page in a card, in no list until it's kept as a tab
// or put beside its opener in a split.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { opensInPeek, shownPeek, siteOf } = await import("./peeks.ts");
const { splitOf } = await import("./splits.ts");

const S = () => useBrowser.getState();
const short = (id) => S().tabs[id].url.replace(/^https:\/\/|\.com$/g, "");
const order = (w) => model.listIds(S(), model.windowListKey(S(), S().windows[w])).map(short);
const shown = (w) => short(model.activeTabId(S(), w));

// A window with a favourite ("mail") and two tabs.
const setup = () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.com" });
  const mail = S().windows[w].activeTabIds[S().windows[w].spaceId];
  const a = S().newTab(w, { url: "https://a.com" });
  const b = S().newTab(w, { url: "https://b.com" });
  S().pinTabs([mail], true);
  S().activate(mail, w);
  return { w, mail, a, b };
};

test("a link from a favourite or a pinned row opens in a peek; one from a tab doesn't", () => {
  const { mail, a, b } = setup();
  assert.ok(opensInPeek(S(), mail, "https://news.com/story"));
  assert.ok(!opensInPeek(S(), a, "https://news.com/story"));
  S().pinRows([b], true);
  assert.ok(opensInPeek(S(), b, "https://news.com/story"));
  assert.ok(!opensInPeek(S(), mail, "mailto:someone@example.com"));
  // Arc's rule: links to other sites. The favourite's own site stays in it, subdomains and all.
  assert.ok(!opensInPeek(S(), mail, "https://mail.com/inbox/2"));
  assert.ok(!opensInPeek(S(), mail, "https://accounts.mail.com/login"));
  S().updateSettings({ peekLinksFromPinnedTabs: false });
  assert.ok(!opensInPeek(S(), mail, "https://news.com/story"));
});

test("a peek is over its opener, in no list, and its own tab", () => {
  const { w, mail } = setup();
  const before = order(w);
  const id = S().openPeek(mail, "https://news.com", "tab:7");
  assert.deepEqual(order(w), before);
  assert.equal(S().tabs[id].peekOf, mail);
  assert.equal(S().tabs[id].openerId, mail);
  assert.equal(S().tabs[id].adoptId, "tab:7");
  assert.equal(S().tabs[id].navigation, null);
  assert.deepEqual(shownPeek(S(), w), { tabId: id, fromId: mail });
  assert.equal(shown(w), "mail");
});

test("a peek shows only while its opener does, and comes back with it", () => {
  const { w, mail, a } = setup();
  const id = S().openPeek(mail, "https://news.com");
  S().activate(a, w);
  assert.equal(shownPeek(S(), w), undefined);
  S().activate(mail, w);
  assert.equal(shownPeek(S(), w)?.tabId, id);
});

test("another link replaces the peek: one per window", () => {
  const { w, mail } = setup();
  const first = S().openPeek(mail, "https://news.com");
  const second = S().openPeek(mail, "https://docs.com");
  assert.equal(S().tabs[first], undefined);
  assert.equal(S().peeks[w].tabId, second);
});

test("closing a peek throws its page away, and nothing is listed or recorded", () => {
  const { w, mail } = setup();
  const before = order(w);
  const closed = S().closedTabs.length;
  const id = S().openPeek(mail, "https://news.com");
  S().closePeek(w);
  assert.equal(S().tabs[id], undefined);
  assert.equal(S().peeks[w], undefined);
  assert.deepEqual(order(w), before);
  assert.equal(S().closedTabs.length, closed);
  assert.equal(shown(w), "mail");
});

test("Open as Tab lists the peek where its opener's links go and shows it", () => {
  const { w, mail } = setup();
  const id = S().openPeek(mail, "https://news.com");
  S().keepPeek(w);
  assert.equal(S().peeks[w], undefined);
  assert.equal(S().tabs[id].peekOf, undefined);
  assert.equal(shown(w), "news");
  // Below the pinned tiles, as a favourite's link opened in front.
  assert.deepEqual(order(w), ["mail", "news", "a", "b"]);
});

test("Open in Split View puts the peek beside its opener", () => {
  const { w, mail } = setup();
  const id = S().openPeek(mail, "https://news.com");
  S().splitPeek(w);
  assert.equal(S().peeks[w], undefined);
  assert.deepEqual(splitOf(S(), mail)?.tabIds, [mail, id]);
  assert.ok(order(w).includes("news"));
  assert.equal(shown(w), "mail");
});

test("a saved peek doesn't come back with the session", () => {
  const { w, mail } = setup();
  const id = S().openPeek(mail, "https://news.com");
  const data = { windows: S().windows, tabs: S().tabs, tabLists: S().tabLists, spaces: S().spaces, spaceOrder: S().spaceOrder };
  S().hydrate(JSON.parse(JSON.stringify(data)));
  assert.equal(S().tabs[id], undefined);
  assert.deepEqual(S().peeks, {});
  assert.ok(!order(w).includes("news"));
});

test("a site is the registrable part of a host, three labels under a country's second level", () => {
  assert.equal(siteOf("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("mail.google.com"), "google.com");
  assert.equal(siteOf("localhost"), "localhost");
});

test("Reopen Closed Tab brings back the last closed peek over its tab", () => {
  const { w, mail, a } = setup();
  S().openPeek(mail, "https://news.com/story");
  S().closePeek(w);
  S().activate(a, w);
  assert.ok(S().reopenPeek(w));
  assert.equal(shown(w), "mail");
  assert.equal(S().tabs[S().peeks[w].tabId].url, "https://news.com/story");
});

test("a tab closed after the peek is what Reopen Closed Tab reopens", () => {
  const { w, mail, b } = setup();
  S().openPeek(mail, "https://news.com");
  S().closePeek(w);
  S().closeTab(b);
  assert.equal(S().reopenPeek(w), false);
});
