import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../../store/browser.ts");
const { littleBaysToPutAway } = await import("./putAway.ts");

const HOUR = 60 * 60_000;
const S = () => useBrowser.getState();

function setup() {
  S().hydrate({});
  const main = S().windowOrder[0] ?? S().createWindow();
  const small = S().createWindow({ small: true, url: "https://example.com/a" });
  return { main, small };
}

test("a Little Bay left alone for its time is put away, and one in use or newer isn't", () => {
  const { main, small } = setup();
  const opened = S().windows[small].createdAt;
  const at = (hours) => opened + hours * HOUR;
  const run = (now, extra = {}) => littleBaysToPutAway(S(), { now, hours: 6, usedAt: () => undefined, inUse: null, ...extra });
  assert.deepEqual(run(at(5.9)), []);
  assert.deepEqual(run(at(6)), [small]);
  // Main windows never are.
  assert.ok(!run(at(100)).includes(main));
  // In front while Bay is active: in use however long.
  assert.deepEqual(run(at(100), { inUse: small }), []);
  // Last in front an hour ago: six hours from then.
  assert.deepEqual(run(at(6.5), { usedAt: () => at(1) }), []);
  assert.deepEqual(run(at(7), { usedAt: () => at(1) }), [small]);
});

test("Never keeps them, and one playing sound stays", () => {
  const { small } = setup();
  const later = S().windows[small].createdAt + 48 * HOUR;
  assert.deepEqual(littleBaysToPutAway(S(), { now: later, hours: null, usedAt: () => undefined, inUse: null }), []);
  const tabId = S().windows[small].activeTabIds[S().windows[small].spaceId];
  useBrowser.setState((s) => ({ live: { ...s.live, [tabId]: { ...s.live[tabId], playingAudio: true } } }));
  assert.deepEqual(littleBaysToPutAway(S(), { now: later, hours: 6, usedAt: () => undefined, inUse: null }), []);
});

test("putting one away leaves its page in the archive, marked as Little Bay's", () => {
  const { small } = setup();
  S().closeWindow(small);
  const entry = S().closedTabs.at(-1);
  assert.equal(entry?.small, true);
  assert.equal(entry?.tab.url, "https://example.com/a");
});
