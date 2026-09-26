import assert from "node:assert/strict";
import { test } from "node:test";
import { appUrlOrigin, appUrlParts, appUrlRoute, isAppUrl, toAppUrl, toEngineUrl } from "./appUrls.ts";
import { breadcrumb, classifyPaste, fixupUrl, resolveInput, urlForDisplay } from "./omnibox.ts";
import { displayUrl } from "./suggest.ts";

test("chrome://, about: and bay: spellings all become bay://", () => {
  assert.equal(toAppUrl("chrome://version/"), "bay://version/");
  assert.equal(toAppUrl("CHROME://Settings/Passwords?x=Y#Z"), "bay://settings/Passwords?x=Y#Z");
  assert.equal(toAppUrl("chrome:flags"), "bay://flags");
  assert.equal(toAppUrl("about:version"), "bay://version");
  assert.equal(toAppUrl("about:net-internals#dns"), "bay://net-internals#dns");
  assert.equal(toAppUrl("Bay:history"), "bay://history");
  assert.equal(toAppUrl("view-source:chrome://version/"), "view-source:bay://version/");
});

test("toAppUrl leaves real about: pages and everything else alone", () => {
  for (const url of ["about:blank", "about:blank#x", "about:srcdoc", "https://chrome.com/", "chrome-extension://abc/popup.html", "devtools://devtools/x", "chrome://", ""]) {
    assert.equal(toAppUrl(url), url, url);
  }
});

test("toEngineUrl: what the engine loads", () => {
  assert.equal(toEngineUrl("bay://version"), "chrome://version");
  assert.equal(toEngineUrl("BAY://GPU/x?A"), "chrome://gpu/x?A");
  assert.equal(toEngineUrl("bay:flags"), "chrome://flags");
  assert.equal(toEngineUrl("view-source:bay://version/"), "view-source:chrome://version/");
  assert.equal(toEngineUrl("https://bay.com/"), "https://bay.com/");
  assert.equal(toEngineUrl("chrome://version/"), "chrome://version/");
  assert.equal(toAppUrl(toEngineUrl("bay://settings/languages")), "bay://settings/languages");
});

test("isAppUrl / appUrlParts / appUrlOrigin", () => {
  assert.equal(isAppUrl("bay://history"), true);
  assert.equal(isAppUrl("bay://"), false);
  assert.equal(isAppUrl("chrome://history"), false);
  assert.deepEqual(appUrlParts("bay://Settings/passwords?q=a#b"), { host: "settings", path: "/passwords", query: "?q=a", hash: "#b" });
  assert.equal(appUrlParts("https://x.com"), null);
  assert.equal(appUrlOrigin("chrome://version/"), "bay://version");
  assert.equal(appUrlOrigin("bay://history?q=cats"), "bay://history");
  assert.equal(appUrlOrigin("https://x.com"), null);
});

test("appUrlRoute: the app's pages, Settings, then Chrome's WebUI", () => {
  assert.deepEqual(appUrlRoute("bay://history?q=x"), { kind: "page", page: "history" });
  assert.deepEqual(appUrlRoute("bay://bookmarks"), { kind: "page", page: "bookmarks" });
  assert.deepEqual(appUrlRoute("bay://downloads/"), { kind: "page", page: "downloads" });
  assert.deepEqual(appUrlRoute("bay://settings"), { kind: "settings", section: null });
  assert.deepEqual(appUrlRoute("bay://settings/"), { kind: "settings", section: null });
  assert.deepEqual(appUrlRoute("bay://settings/passwords/x"), { kind: "settings", section: "passwords" });
  assert.deepEqual(appUrlRoute("bay://newtab/"), { kind: "newTab" });
  assert.deepEqual(appUrlRoute("bay://extensions"), { kind: "engine", url: "chrome://extensions" });
  assert.deepEqual(appUrlRoute("bay://version"), { kind: "engine", url: "chrome://version" });
  assert.equal(appUrlRoute("https://example.com/history"), null);
});

test("the command bar accepts every spelling and lands on bay://", () => {
  assert.equal(resolveInput("bay://version"), "bay://version");
  assert.equal(resolveInput("chrome://version"), "bay://version");
  assert.equal(resolveInput("about:version"), "bay://version");
  assert.equal(resolveInput("chrome://history"), "bay://history");
  assert.equal(resolveInput("bay:flags"), "bay://flags");
  assert.equal(resolveInput("about:blank"), "about:blank");
  assert.equal(resolveInput("bay"), "https://www.google.com/search?q=bay");
  assert.equal(fixupUrl("chrome-extension://abc/x.html"), "chrome-extension://abc/x.html");
  assert.deepEqual(classifyPaste("chrome://settings"), { kind: "go", url: "bay://settings" });
});

test("displayed URLs say bay://, never chrome://", () => {
  assert.equal(urlForDisplay("bay://version/"), "bay://version");
  assert.equal(urlForDisplay("chrome://version/"), "bay://version");
  assert.equal(urlForDisplay("chrome://settings/languages"), "bay://settings/languages");
  assert.equal(urlForDisplay("bay://history/?q=a"), "bay://history?q=a");
  assert.equal(displayUrl("chrome://gpu/"), "bay://gpu");
  assert.deepEqual(breadcrumb("bay://version/", "About Version"), { host: "bay://version", trail: ["About Version"] });
  assert.deepEqual(breadcrumb("bay://history", "History"), { host: "bay://history", trail: [] });
  assert.deepEqual(breadcrumb("chrome://flags/", "Experiments"), { host: "bay://flags", trail: ["Experiments"] });
});
