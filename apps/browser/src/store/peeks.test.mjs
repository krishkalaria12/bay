// Arc's Peek: a link from a pinned tab or a favourite opens over its page in a card, in no list until it's kept as a tab
// or put beside its opener in a split.
import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");
const model = await import("./model.ts");
const { opensInPeek, shownPeek, siteOf } = await import("./peeks.ts");
const { splitOf } = await import("./splits.ts");

const S = () => useBrowser.getState();
// These cases read lists in the order their tabs opened: new tabs go to the bottom.
(await import("./settings.ts")).DEFAULT_SETTINGS.newTabPosition = "bottom";
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

test("Open as Tab routes a Peek to the matching Space and its existing window", () => {
  const { w, mail } = setup();
  const work = S().createSpace({ name: "Work" });
  const target = S().createWindow({ spaceId: work, url: "https://work.com" });
  S().setFocusedWindow(w);
  S().updateSettings({
    externalLinkRules: [{ id: "reports", matchType: "contains", pattern: "report=weekly", destination: { kind: "space", spaceId: work } }],
  });
  const id = S().openPeek(mail, "https://docs.com/report?report=weekly", "tab:7");
  assert.equal(S().keepPeek(w), target);
  assert.equal(S().peeks[w], undefined);
  assert.equal(S().tabs[id].spaceId, work);
  assert.equal(S().tabs[id].windowId, target);
  assert.equal(S().tabs[id].peekOf, undefined);
  assert.equal(S().tabs[id].adoptId, undefined, "a different profile cannot reuse the opener's page");
  assert.ok(S().tabs[id].navigation);
  assert.equal(model.activeTabId(S(), target), id);
  assert.equal(model.activeTabId(S(), w), mail);
  assert.ok(!order(w).includes("docs.com/report?report=weekly"));
});

test("Peek routing uses its current URL, first-match priority and no desktop sender", () => {
  const { w, mail } = setup();
  const work = S().createSpace({ name: "Work" });
  S().updateSettings({
    externalLinkRules: [
      { id: "source", pattern: "docs.com", matchType: "contains", sourceApp: "com.apple.mail", destination: { kind: "newWindow" } },
      { id: "exact", pattern: "https://docs.com/final#report", matchType: "equals", destination: { kind: "space", spaceId: work } },
      { id: "fallback", pattern: "docs.com", matchType: "contains", destination: { kind: "newWindow" } },
    ],
  });
  const id = S().openPeek(mail, "https://docs.com/initial");
  S().navigated(id, { url: "https://docs.com/final#report", title: "Final report" }, {});
  const count = S().windowOrder.length;
  assert.equal(S().keepPeek(w), w);
  assert.equal(S().tabs[id].spaceId, work);
  assert.equal(S().windowOrder.length, count);
});

test("explicit Peek split stays beside its opener, while Open as Tab honors Little Bay and new windows", () => {
  for (const kind of ["littleBay", "newWindow", "mostRecentSpace"]) {
    const { w, mail } = setup();
    S().updateSettings({ externalLinkRules: [{ id: "route", matchType: "contains", pattern: "news.com", destination: { kind } }] });
    const id = S().openPeek(mail, "https://news.com");
    S().splitPeek(w);
    assert.deepEqual(splitOf(S(), mail)?.tabIds, [mail, id]);
    const next = S().openPeek(mail, "https://news.com/story");
    const target = S().keepPeek(w);
    assert.equal(S().peeks[w], undefined);
    if (kind === "mostRecentSpace") {
      assert.equal(target, w);
      assert.equal(S().tabs[next].spaceId, S().tabs[mail].spaceId);
    } else {
      assert.notEqual(target, w);
      assert.equal(S().windows[target].kind ?? "main", kind === "littleBay" ? "small" : "main");
      assert.equal(S().tabs[model.activeTabId(S(), target)].url, "https://news.com/story");
    }
    assert.equal(S().closedPeeks[w], undefined, "opening is not recorded as closing the Peek");
  }
});

test("private Peeks never route into regular Spaces", () => {
  setup();
  const w = S().createWindow({ incognito: true, url: "https://private.com" });
  const from = model.activeTabId(S(), w);
  S().updateSettings({ externalLinkRules: [{ id: "route", pattern: "news.com", matchType: "contains", destination: { kind: "space", spaceId: "default" } }] });
  const id = S().openPeek(from, "https://news.com/private");
  assert.equal(S().keepPeek(w), w);
  assert.equal(S().tabs[id].spaceId, S().windows[w].spaceId);
});

test("routing a Peek to Little Bay transfers the same live page and preserves its state", () => {
  const { w, mail } = setup();
  S().updateSettings({ externalLinkRules: [{ id: "route", matchType: "contains", pattern: "news.com", destination: { kind: "littleBay" } }] });
  const id = S().openPeek(mail, "https://news.com/post-result");
  S().updateLive(id, { title: "POST response", scrollY: 420 });
  const live = S().live[id];
  const target = S().keepPeek(w);
  assert.equal(model.activeTabId(S(), target), id);
  assert.equal(S().tabs[id].windowId, target);
  assert.equal(S().tabs[id].navigation.url, "https://news.com/post-result");
  assert.equal(S().live[id], live);
  assert.equal(S().windows[target].kind, "small");
  assert.equal(model.activeTabId(S(), w), mail);
  assert.ok(!model.listIds(S(), "default").includes(id));
});

test("Little Bay cannot adopt pinned pages, multiple tabs, or another profile", () => {
  const { w, mail, a, b } = setup();
  const pinned = S().createWindow({ small: true, tabIds: [mail] });
  assert.equal(S().tabs[mail].windowId, w);
  assert.notEqual(model.activeTabId(S(), pinned), mail);
  const multiple = S().createWindow({ small: true, tabIds: [a, b] });
  assert.equal(S().tabs[a].windowId, w);
  assert.equal(S().tabs[b].windowId, w);
  assert.ok(![a, b].includes(model.activeTabId(S(), multiple)));
  const work = S().createSpace({ name: "Work" });
  const other = S().createWindow({ small: true, spaceId: work, tabIds: [a] });
  assert.equal(S().tabs[a].spaceId, "default");
  assert.equal(S().tabs[a].windowId, w);
  assert.notEqual(model.activeTabId(S(), other), a);
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
