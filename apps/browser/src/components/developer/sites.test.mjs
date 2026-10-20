import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { developerTabShown, isDeveloperUrl, isLocalDevSite, siteKey } = await import("./sites.ts");
const { sidebarFieldShown } = await import("../layout/windowLayout.ts");
const S = () => useBrowser.getState();

test("a site is its host and port, for http(s) only", () => {
  assert.equal(siteKey("http://localhost:8765/red.html"), "localhost:8765");
  assert.equal(siteKey("https://user:pw@App.Test/path?q#h"), "app.test");
  assert.equal(siteKey("http://[::1]:3000/"), "[::1]:3000");
  assert.equal(siteKey("file:///Users/me/index.html"), "");
  assert.equal(siteKey("bay://settings"), "");
});

test("local servers are offered Developer Mode, other sites aren't", () => {
  for (const url of [
    "http://localhost:3000",
    "http://127.0.0.1:5173/",
    "http://[::1]:8080",
    "http://app.localhost",
    "http://me.local:4000",
    "https://site.test",
    "http://192.168.1.20:3000",
    "http://10.0.0.5:8000",
  ])
    assert.equal(isLocalDevSite(url), true, url);
  for (const url of ["https://example.com", "http://192.168.1.1/", "http://172.32.0.1:3000", "file:///tmp/a.html", "http://localhostx.com"])
    assert.equal(isLocalDevSite(url), false, url);
});

test("a tab in Developer Mode takes its address out of the sidebar", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "http://localhost:3000/" });
  assert.equal(developerTabShown(S(), w), false);
  assert.equal(sidebarFieldShown(S(), w), true);
  S().updateSettings({ developerSites: ["localhost:3000"] });
  assert.equal(isDeveloperUrl(S(), "http://localhost:3000/other"), true);
  assert.equal(isDeveloperUrl(S(), "http://localhost:3001/"), false);
  assert.equal(developerTabShown(S(), w), true);
  assert.equal(sidebarFieldShown(S(), w), false);
});
