import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { startCleanupNotifications } = await import("./cleanupNotifications.ts");

const S = () => useBrowser.getState();
const flush = () => new Promise((resolve) => queueMicrotask(resolve));
const notices = [];
const notify = (windowId, count) => notices.push({ windowId, count });
const setup = (t) => {
  S().hydrate({});
  notices.length = 0;
  const windowId = S().createWindow({ url: "https://active.com" });
  t.after(startCleanupNotifications(notify));
  return windowId;
};
const stale = (windowId, url = "https://stale.com") => {
  const id = S().newTab(windowId, { url, background: true });
  S().updateTab(id, { lastActiveAt: Date.now() - 24 * 3_600_000 });
  return id;
};

test("cleanup notifies once and doesn't repeat after unrelated updates or restoration", async (t) => {
  const w = setup(t);
  stale(w);
  stale(w, "https://other.com");
  assert.equal(S().cleanUpTabs(w), 2);
  await flush();
  assert.deepEqual(notices, [{ windowId: w, count: 2 }]);
  notices.length = 0;
  S().setSelection(w, []);
  S().restoreCleaned(undefined, w);
  await flush();
  assert.deepEqual(notices, []);
  assert.equal(S().cleanUpTabs(w), 0);
  await flush();
  assert.deepEqual(notices, []);
});

test("automatic cleanup across spaces produces one combined notice", async (t) => {
  const w = setup(t);
  stale(w);
  const work = S().createSpace({ name: "Work" });
  S().switchSpace(w, work);
  S().navigate(S().windows[w].activeTabIds[work], "https://work.com");
  stale(w, "https://old-work.com");
  assert.equal(S().cleanUpInactiveTabs(), 2);
  await flush();
  assert.deepEqual(notices, [{ windowId: w, count: 2 }]);
});

test("loading saved cleaned tabs does not replay a notice", async (t) => {
  const w = setup(t);
  stale(w);
  S().cleanUpTabs(w);
  await flush();
  const cleanedTabs = S().cleanedTabs;
  notices.length = 0;
  S().hydrate({ cleanedTabs });
  await flush();
  assert.deepEqual(notices, []);
});

test("private cleanup only notifies its private window", async (t) => {
  const regular = setup(t);
  const privateWindow = S().createWindow({ incognito: true, url: "https://private.com" });
  stale(privateWindow);
  assert.equal(S().cleanUpTabs(privateWindow), 1);
  await flush();
  assert.deepEqual(notices, [{ windowId: privateWindow, count: 1 }]);
  assert.ok(notices.every((notice) => notice.windowId !== regular));
});

test("cleanup counts tabs beyond the saved history limit", async (t) => {
  const regular = setup(t);
  const privateWindow = S().createWindow({ incognito: true, url: "https://private.com" });
  for (const w of [regular, privateWindow]) {
    for (let i = 0; i < 101; i++) stale(w, `https://stale-${i}.com`);
    assert.equal(S().cleanUpTabs(w), 101);
  }
  await flush();
  assert.deepEqual(notices, [
    { windowId: regular, count: 101 },
    { windowId: privateWindow, count: 101 },
  ]);
});
