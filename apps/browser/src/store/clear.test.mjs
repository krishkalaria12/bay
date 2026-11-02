import assert from "node:assert/strict";
import { test } from "node:test";
await import("../test-native-stub.mjs");
const { useBrowser } = await import("./browser.ts");
const { hasClearableTabs } = await import("./organize.ts");

test("Clear follows audio, lists and switches but skips progress reports", async () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://shown.example" });
  const other = S().newTab(w, { url: "https://other.example", background: true });
  assert.equal(hasClearableTabs(S(), w), true);
  S().updateLive(other, { playingAudio: true });
  assert.equal(hasClearableTabs(S(), w), false, "a playing tab stays");
  S().updateLive(other, { progress: 0.4 });
  assert.equal(hasClearableTabs(S(), w), false);
  S().updateLive(other, { playingAudio: false });
  assert.equal(hasClearableTabs(S(), w), true);
  S().activate(other);
  assert.equal(hasClearableTabs(S(), w), true, "the tab left behind can go");
  S().closeTab(S().windows[w].activeTabIds.default === other ? Object.keys(S().tabs).find((id) => id !== other) : other);
  assert.equal(hasClearableTabs(S(), w), false, "only the shown tab is left");
});
