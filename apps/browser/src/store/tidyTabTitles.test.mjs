import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("./browser.ts");

const S = () => useBrowser.getState();

const _setup = (...urls) => {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${urls[0]}.com` });
  const ids = [S().windows[w].activeTabIds[S().windows[w].spaceId], ...urls.slice(1).map((u) => S().newTab(w, { url: `https://${u}.com` }))];
  // give tabs titles
  for (const id of ids) {
    const t = S().tabs[id];
    if (t) S().updateTab(id, { title: t.url.includes("mail") ? "Inbox – Gmail" : t.url });
  }
  return [w, ...ids];
};

test("tidy sets customTitle on pin when enabled", () => {
  // set up a gmail-like tab
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.google.com" });
  const id = S().windows[w].activeTabIds[S().windows[w].spaceId];
  S().updateTab(id, { title: "Inbox – Gmail" });
  S().updateSettings({ tidyTabTitles: true });
  S().pinRows([id], true);
  assert.equal(S().tabs[id].customTitle, "Gmail");
});

test("tidy off by default does nothing", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.google.com" });
  const id = S().windows[w].activeTabIds[S().windows[w].spaceId];
  S().updateTab(id, { title: "Inbox – Gmail" });
  // default false
  S().pinRows([id], true);
  assert.equal(S().tabs[id].customTitle, null);
});

test("reset name clears tidy title", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.google.com" });
  const id = S().windows[w].activeTabIds[S().windows[w].spaceId];
  S().updateTab(id, { title: "Inbox – Gmail" });
  S().updateSettings({ tidyTabTitles: true });
  S().pinRows([id], true);
  assert.equal(S().tabs[id].customTitle, "Gmail");
  S().updateTab(id, { customTitle: null });
  assert.equal(S().tabs[id].customTitle, null);
});
