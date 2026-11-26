import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chosenEngine,
  engineForUrl,
  engineMark,
  protectedVideoSite,
  siteDomainOf,
  siteOf,
  tabEngine,
  typedNavigationEngine,
  visitRecorder,
  wantedEngine,
} from "./engines.ts";
import { makeTab, snapshotTab } from "./model.ts";
import { DEFAULT_SETTINGS, restoreSettings } from "./settings.ts";
import { setWebKitAvailable } from "@bay/chromium";

const tab = (id, patch = {}) => ({ id, url: "", navigation: null, openerId: null, ...patch });

const PREFS = {
  engineMode: DEFAULT_SETTINGS.engineMode,
  defaultEngine: DEFAULT_SETTINGS.defaultEngine,
  siteEngines: DEFAULT_SETTINGS.siteEngines,
  streamingInWebKit: DEFAULT_SETTINGS.streamingInWebKit,
};

const state = (tabs, settings = {}) => ({ tabs: Object.fromEntries(tabs.map((t) => [t.id, t])), settings: { ...PREFS, ...settings } });

test("a site is its scheme, host and port, and nothing else", () => {
  assert.equal(siteOf("https://www.Netflix.com/watch/1?x=2#y"), "https://www.netflix.com");
  assert.equal(siteOf("http://localhost:8080/a"), "http://localhost:8080");
  assert.equal(siteOf("https://example.com:443/"), "https://example.com");
  assert.equal(siteOf("bay://settings"), null);
  assert.equal(siteOf("not a url"), null);
});

test("engine checks reuse URL parsing", () => {
  const OriginalURL = globalThis.URL;
  let parses = 0;
  globalThis.URL = class extends OriginalURL {
    constructor(...args) {
      super(...args);
      parses++;
    }
  };

  try {
    const url = "https://www.netflix.com/watch/cache-regression";
    const s = state([tab("cached", { url })]);

    for (let i = 0; i < 60; i++) {
      assert.equal(engineMark(s, "cached"), "webkit");
      assert.equal(protectedVideoSite(url), true);
    }

    assert.equal(parses, 1, "unchanged rows should not repeatedly construct URLs");

    for (let i = 0; i < 1100; i++) siteOf(`https://cache-test.example/${i}`);
    const before = parses;
    assert.equal(protectedVideoSite(url), true);
    assert.equal(parses, before + 1, "old addresses must leave the bounded cache");
  } finally {
    globalThis.URL = OriginalURL;
  }
});

test("a tab keeps its engine, else follows its adoption, its opener, then its site", () => {
  const s = state([
    tab("fixed", { engine: "chromium", url: "https://www.netflix.com/" }),
    tab("popup", { adoptId: "webkit:3" }),
    tab("chrome", { adoptId: "nncore:9", url: "https://www.netflix.com/" }),
    tab("opener", { engine: "webkit", url: "https://www.netflix.com/" }),
    tab("link", { openerId: "opener", url: "https://example.com/" }),
    tab("typed", { url: "https://www.netflix.com/" }),
    tab("copy", { adoptId: "clone:opener" }),
  ]);

  assert.equal(tabEngine(s, "fixed"), "chromium");
  assert.equal(tabEngine(s, "popup"), "webkit");
  assert.equal(tabEngine(s, "chrome"), "chromium");
  assert.equal(tabEngine(s, "link"), "webkit");
  assert.equal(tabEngine(s, "typed"), "webkit");
  assert.equal(tabEngine(s, "copy"), "webkit");
  assert.equal(tabEngine(s, "gone"), "chromium");
});

test("every other page opens in Chromium, and choices from before 5 Nov 2026 don't come back", () => {
  assert.equal(engineForUrl(PREFS, "https://example.com/"), "chromium");
  const restored = restoreSettings({ pageEngine: "webkit", websiteEngines: { "https://example.com": "webkit" } });
  assert.equal("pageEngine" in restored, false);
  assert.equal("websiteEngines" in restored, false);
  const s = state([tab("t", { url: "https://example.com/" })], restored);
  assert.equal(tabEngine(s, "t"), "chromium");
  assert.equal(engineMark(s, "t"), null);
});

test("streaming sites open in WebKit, over https, subdomains included", () => {
  assert.equal(protectedVideoSite("https://www.netflix.com/watch/1"), true);
  assert.equal(protectedVideoSite("https://netflix.com/"), true);
  assert.equal(protectedVideoSite("https://open.spotify.com/track/1"), true);
  assert.equal(protectedVideoSite("https://www.spotify.com/"), false);
  assert.equal(protectedVideoSite("https://netflix.com.example.com/"), false);
  assert.equal(protectedVideoSite("https://notnetflix.com/"), false);
  assert.equal(protectedVideoSite("http://www.netflix.com/"), false);
  assert.equal(chosenEngine(PREFS, "https://example.com/"), undefined);
  assert.equal(chosenEngine(PREFS, "https://www.netflix.com/"), "webkit");
  assert.equal(engineForUrl(PREFS, "https://www.netflix.com/browse"), "webkit");
  assert.equal(tabEngine(state([tab("typed", { url: "https://www.netflix.com/" })]), "typed"), "webkit");
});

test("Chromium's own pages always open in Chromium", () => {
  const s = state([tab("v", { engine: "webkit", url: "bay://version" }), tab("w", { engine: "webkit", url: "https://a.com/" })]);
  assert.equal(tabEngine(s, "v"), "chromium");
  assert.equal(engineForUrl(PREFS, "bay://extensions"), "chromium");
  assert.equal(engineForUrl(PREFS, "chrome-extension://abc/options.html"), "chromium");
});

test("the mark shows only on web pages away from Chromium", () => {
  const s = state([
    tab("w", { engine: "webkit", url: "https://a.com/" }),
    tab("c", { engine: "chromium", url: "https://a.com/" }),
    tab("n", { engine: "webkit", url: "bay://history" }),
  ]);

  assert.equal(engineMark(s, "w"), "webkit");
  assert.equal(engineMark(s, "c"), null);
  assert.equal(engineMark(s, "n"), null);
});

test("a closed WebKit tab reopens in WebKit, whatever restore id it carries", () => {
  const closed = snapshotTab({ ...makeTab("w1", "default", "https://www.netflix.com/"), engine: "webkit" });
  assert.equal(closed.engine, "webkit");
  const reopened = { ...makeTab("w1", "default", closed.url, closed), adoptId: "restore:old", navigation: null };
  const s = state([reopened]);
  assert.equal(tabEngine(s, reopened.id), "webkit");
  assert.equal(snapshotTab(makeTab("w1", "default", "https://a.com/")).engine, undefined);
});

function recorder() {
  const written = [];
  let clock = 0;
  let next = 0;
  const pending = new Map();

  const visits = visitRecorder(
    (profile, visit) => written.push({ profile, ...visit }),
    { set: (run, ms) => (pending.set(++next, { run, at: clock + ms }), next), clear: (id) => pending.delete(id) },
    () => clock,
  );

  const advance = (ms) => {
    clock += ms;

    for (const [id, timer] of Array.from(pending)) {
      if (timer.at > clock) continue;
      pending.delete(id);
      timer.run();
    }
  };

  const page = (url, title, isLoading, committedUrl = url) => ({ url, title, isLoading, committedUrl });

  return { visits, written, advance, page };
}

test("a WebKit visit is recorded for the committed page, with that page's own title", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "", page("https://b.com/", "A's title", true, "https://a.com/"));
  advance(1);
  visits.note("t", "", page("https://b.com/", "A's title", true));
  visits.note("t", "", page("https://b.com/", "", true));
  assert.deepEqual(written, []);
  advance(1);
  visits.note("t", "", page("https://b.com/", "B's title", true));
  visits.note("t", "", page("https://b.com/", "B again", false));
  assert.deepEqual(written, [{ profile: "", url: "https://b.com/", title: "B's title", at: 1 }]);
});

test("a page whose title never changes is recorded once it settles, not at once", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "", page("https://b.com/", "Same", false));
  assert.deepEqual(written, []);
  advance(1500);
  assert.deepEqual(written, [{ profile: "", url: "https://b.com/", title: "Same", at: 0 }]);
});

test("a navigation that became a download, or an error page, is never recorded", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "", page("https://f.com/file.zip", "", false, ""));
  visits.note("t", "", page("https://f.com/file.zip", "x", false, "https://a.com/"));
  advance(5000);
  assert.deepEqual(written, []);
});

test("a visit keeps the profile it was made in, even if the tab moves before it settles", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "work", page("https://a.com/", "A", false));
  visits.note("t", "home", page("https://a.com/", "A", false));
  advance(1500);
  assert.deepEqual(
    written.map((v) => v.profile),
    ["work"],
  );
});

test("one visit's settle timer never records the next visit", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "", page("https://a.com/", "A", false));
  advance(1400);
  visits.note("t", "", page("https://b.com/", "A", true));
  advance(100);
  assert.deepEqual(written, [{ profile: "", url: "https://a.com/", title: "A", at: 0 }]);
  advance(1000);
  visits.note("t", "", page("https://b.com/", "B", false));
  assert.deepEqual(written.at(-1), { profile: "", url: "https://b.com/", title: "B", at: 1400 });
});

test("a quick next page still records the one before it, with its own title and time", () => {
  const { visits, written, page, advance } = recorder();
  visits.note("t", "", page("https://a.com/", "Old", true));
  advance(200);
  visits.note("t", "", page("https://a.com/#two", "Old", false));
  assert.deepEqual(written, [{ profile: "", url: "https://a.com/", title: "Old", at: 0 }]);
});

test("a private visit is never written, and a reload of the same page isn't a new visit", () => {
  const { visits, written, page, advance } = recorder();
  visits.note("p", null, page("https://a.com/", "A", false));
  advance(1500);
  visits.note("t", "", page("https://a.com/", "A", false));
  advance(1500);
  visits.note("t", "", page("https://a.com/", "A", true));
  visits.note("t", "", page("https://a.com/", "A", false));
  advance(1500);
  assert.deepEqual(written.length, 1);
});

test("closing a tab records its unsettled visit and forgets the tab", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("t", "", page("https://a.com/", "Old", true));
  visits.close("t");
  assert.deepEqual(written, [{ profile: "", url: "https://a.com/", title: "Old", at: 0 }]);
  assert.equal(visits.size(), 0);
  advance(5000);
  assert.equal(written.length, 1);
});

test("many tabs don't make an open tab record its page again", () => {
  const { visits, written, advance, page } = recorder();
  visits.note("keep", "", page("https://keep.com/", "K", false));
  advance(1500);

  for (let i = 0; i < 1200; i++) {
    visits.note(`t${i}`, "", page(`https://s${i}.com/`, "", false));
    advance(1500);
    visits.close(`t${i}`);
  }

  visits.note("keep", "", page("https://keep.com/", "K", false));
  advance(1500);
  assert.equal(written.filter((v) => v.url === "https://keep.com/").length, 1);
  assert.equal(visits.size(), 1);
});

test("without the WebKit module (Windows, Linux) every page stays in Chromium", () => {
  const s = state([tab("a", { url: "https://www.netflix.com/", engine: "webkit" }), tab("b", { url: "https://example.com/", adoptId: "webkit:3" })]);
  setWebKitAvailable(false);

  try {
    assert.equal(tabEngine(s, "a"), "chromium");
    assert.equal(tabEngine(s, "b"), "chromium");
    assert.equal(engineForUrl(PREFS, "https://www.netflix.com/"), "chromium");
    assert.equal(chosenEngine(PREFS, "https://www.netflix.com/"), undefined);
    assert.equal(engineMark(s, "a"), null);
    // Synced choices from a Mac change nothing here.
    const webkit = { engineMode: "webkit", defaultEngine: "webkit", siteEngines: { "example.com": "webkit" } };
    const fresh = state([tab("c", { url: "https://example.com/" })], webkit);
    assert.equal(tabEngine(fresh, "c"), "chromium");
    assert.equal(wantedEngine(fresh, "c"), "chromium");
    assert.equal(typedNavigationEngine(fresh, fresh.tabs.c, "https://example.com/"), "chromium");
    assert.equal(engineMark(fresh, "c"), null);
  } finally {
    setWebKitAvailable(true);
  }
});

test("site rules key by registrable domain, subdomains included", () => {
  assert.equal(siteDomainOf("https://accounts.figma.com/login"), "figma.com");
  assert.equal(siteDomainOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(siteDomainOf("https://me.github.io/x"), "me.github.io");
  assert.equal(siteDomainOf("http://localhost:3000/"), "localhost");
  assert.equal(siteDomainOf("http://192.168.1.4/"), "192.168.1.4");
  const prefs = { ...PREFS, siteEngines: { "figma.com": "webkit" } };
  assert.equal(engineForUrl(prefs, "https://www.figma.com/file/1"), "webkit");
  assert.equal(engineForUrl(prefs, "https://figma.community.example/"), "chromium");
  assert.equal(chosenEngine(prefs, "https://example.com/"), undefined);
});

test("the order: Chromium-only pages, the mode, the tab's pick, the site's rule, streaming sites, the default", () => {
  const pick = { engine: "webkit", site: "github.com" };

  const tabs = [
    tab("settings", { url: "bay://settings" }),
    tab("picked", { url: "https://github.com/", engine: "webkit", enginePick: pick }),
    tab("ruled", { url: "https://www.figma.com/" }),
    tab("stream", { url: "https://www.netflix.com/" }),
    tab("plain", { url: "https://example.com/" }),
    tab("extension", { url: "https://example.com/", adoptId: "nncore:4" }),
  ];

  const automatic = state(tabs, { siteEngines: { "figma.com": "webkit", "github.com": "chromium" } });
  assert.equal(wantedEngine(automatic, "settings"), "chromium");
  assert.equal(wantedEngine(automatic, "picked"), "webkit", "a pick beats the site's rule");
  assert.equal(wantedEngine(automatic, "ruled"), "webkit");
  assert.equal(wantedEngine(automatic, "stream"), "webkit");
  assert.equal(wantedEngine(automatic, "plain"), "chromium");

  const noStreaming = state(tabs, { streamingInWebKit: false, defaultEngine: "webkit" });
  assert.equal(wantedEngine(noStreaming, "stream"), "webkit", "the default engine");
  assert.equal(wantedEngine(state(tabs, { streamingInWebKit: false }), "stream"), "chromium");
  assert.equal(wantedEngine(state(tabs, { siteEngines: { "netflix.com": "chromium" } }), "stream"), "chromium", "a rule beats the streaming list");

  const chromium = state(tabs, { engineMode: "chromium", siteEngines: { "figma.com": "webkit" } });

  for (const id of ["picked", "ruled", "stream", "plain"]) assert.equal(wantedEngine(chromium, id), "chromium", id);

  const webkit = state(tabs, { engineMode: "webkit", siteEngines: { "github.com": "chromium" } });

  for (const id of ["picked", "ruled", "stream", "plain"]) assert.equal(wantedEngine(webkit, id), "webkit", id);
  assert.equal(wantedEngine(webkit, "settings"), "chromium");
  assert.equal(wantedEngine(webkit, "extension"), "chromium", "a page an extension or Chromium made stays there");
});

test("a pick holds only on its site", () => {
  const t = tab("t", { url: "https://github.com/", enginePick: { engine: "webkit", site: "github.com" } });
  const s = state([t]);
  assert.equal(typedNavigationEngine(s, t, "https://gist.github.com/x"), "webkit");
  assert.equal(typedNavigationEngine(s, t, "https://example.com/"), "chromium");
  assert.equal(wantedEngine(state([{ ...t, url: "https://example.com/" }]), "t"), "chromium");
});

test("a typed address follows its site's rule or the default, not the page it replaces", () => {
  const t = tab("t", { url: "https://www.netflix.com/", engine: "webkit" });
  assert.equal(typedNavigationEngine(state([t]), t, "https://example.com/"), "chromium");
  assert.equal(typedNavigationEngine(state([t], { defaultEngine: "webkit" }), t, "https://example.com/"), "webkit");
  assert.equal(typedNavigationEngine(state([t]), t, "bay://settings"), "chromium");
  assert.equal(typedNavigationEngine(state([t], { engineMode: "chromium" }), t, "https://www.netflix.com/x"), "chromium");
});

test("a fresh link's tab takes its opener's engine unless the mode decides", () => {
  const tabs = [tab("o", { url: "https://www.netflix.com/", engine: "webkit" }), tab("l", { url: "https://example.com/", openerId: "o" })];
  assert.equal(tabEngine(state(tabs), "l"), "webkit");
  assert.equal(tabEngine(state(tabs, { engineMode: "chromium" }), "l"), "chromium");
});

test("the mark shows on a tab away from the engine other pages open in", () => {
  const tabs = [tab("w", { url: "https://a.com/", engine: "webkit" }), tab("c", { url: "https://a.com/", engine: "chromium" })];
  assert.equal(engineMark(state(tabs, { defaultEngine: "webkit" }), "w"), null);
  assert.equal(engineMark(state(tabs, { defaultEngine: "webkit" }), "c"), "chromium");
  assert.equal(engineMark(state(tabs, { engineMode: "webkit" }), "c"), "chromium");
  assert.equal(engineMark(state(tabs, { engineMode: "chromium" }), "w"), "webkit");
});

test("saved and synced engine settings keep only valid values", () => {
  const restored = restoreSettings({
    engineMode: "safari",
    defaultEngine: "webkit",
    siteEngines: { "https://www.Figma.com/x": "webkit", "a.com": "gecko", "": "webkit" },
  });

  assert.equal(restored.engineMode, "automatic");
  assert.equal(restored.defaultEngine, "webkit");
  assert.deepEqual(restored.siteEngines, { "figma.com": "webkit" });
  assert.equal(restoreSettings({}).protectedVideoFallback, "move");
});
