import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore, useBrowser } from "../store/browser.ts";
import { browserRead, installBrowserReadSource } from "../store/read.ts";
import { groupOf } from "../store/organize.ts";
import { MEETING_CLEANUP_IDLE_MS } from "./constants.ts";
import { startMeetingGroups } from "./meetingGroups.ts";
import { live, setMeetingGroup, updateCalendarSettings, useLive } from "./store.ts";

function setup(t) {
  const saved = useLive.getState();
  useLive.setState({ meetingGroups: {}, calendar: { ...saved.calendar, prompted: false, alertLead: "1" } });
  const browser = createBrowserStore();
  const windowId = browser.getState().createWindow();
  const global = useBrowser.getState();
  const snapshot = browserRead.getState();
  let reads = 0;
  const restoreRead = installBrowserReadSource({
    getState() {
      reads++;
      return snapshot;
    },
    subscribe: () => () => {},
  });
  reads = 0;
  const stop = startMeetingGroups(browser);
  t.after(() => {
    stop();
    restoreRead();
    useLive.setState(saved, true);
  });
  return { browser, windowId, stop, global, reads: () => reads };
}

test("meeting watchers group authority tabs synchronously and reuse their call group", (t) => {
  const { browser, windowId, stop, global, reads } = setup(t);
  assert.strictEqual(startMeetingGroups(browser), stop);
  const first = browser.getState().newTab(windowId, { url: "https://meet.google.com/abc-defg-hij" });
  const firstGroup = groupOf(browser.getState(), first);
  assert.ok(firstGroup);
  assert.equal(live().meetingGroups[firstGroup.id].callTabId, first);
  const second = browser.getState().newTab(windowId, { url: "https://meet.google.com/abc-defg-hij" });
  const related = browser.getState().newTab(windowId, { url: "https://example.com/notes", openerId: first });
  assert.equal(groupOf(browser.getState(), second).id, firstGroup.id);
  assert.equal(groupOf(browser.getState(), related).id, firstGroup.id);
  assert.equal(Object.keys(browser.getState().groups).length, 1);
  assert.strictEqual(useBrowser.getState(), global);
  assert.equal(reads(), 0);
});

test("meeting cleanup closes only the authority group and stops its timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { browser, windowId, stop, global, reads } = setup(t);
  const call = browser.getState().newTab(windowId, { url: "https://meet.google.com/abc-defg-hij" });
  browser.getState().newTab(windowId);
  const group = groupOf(browser.getState(), call);
  const old = Date.now() - MEETING_CLEANUP_IDLE_MS - 60_000;
  browser.setState((s) => ({ tabs: { ...s.tabs, [call]: { ...s.tabs[call], lastActiveAt: old } } }));
  setMeetingGroup({ ...live().meetingGroups[group.id], endedAt: old });
  t.mock.timers.tick(30_000);
  assert.equal(browser.getState().groups[group.id], undefined);
  assert.equal(browser.getState().tabs[call], undefined);
  assert.strictEqual(useBrowser.getState(), global);
  assert.equal(reads(), 0);

  stop();
  stop();
  const later = browser.getState().newTab(windowId, { url: "https://meet.google.com/xyz-abcd-efg" });
  assert.equal(groupOf(browser.getState(), later), undefined);
  const laterGroup = browser.getState().createGroup([later]);
  setMeetingGroup({ groupId: laterGroup, callTabId: later, title: "Stopped", occurrence: null, start: null, end: old, endedAt: null });
  t.mock.timers.tick(60_000);
  assert.equal(live().meetingGroups[laterGroup].endedAt, null);
  const restarted = startMeetingGroups(browser);
  assert.notStrictEqual(restarted, stop);
  restarted();
});

test("stopping meeting groups ignores an outstanding calendar alert confirmation", async (t) => {
  const { browser, windowId, stop } = setup(t);
  browser.getState().newTab(windowId, { url: "https://calendar.google.com", pinned: true });
  assert.equal(live().calendar.prompted, true);
  stop();
  await Promise.resolve();
  assert.equal(live().calendar.alertLead, "1");
  updateCalendarSettings({ prompted: false });
  browser.getState().newTab(windowId, { url: "https://calendar.google.com", pinned: true });
  assert.equal(live().calendar.prompted, false);
});

test("meeting group startup detaches its subscription when timer creation fails", (t) => {
  const saved = useLive.getState();
  useLive.setState({
    meetingGroups: { pending: { groupId: "pending", callTabId: "pending", title: "Meeting", occurrence: null, start: null, end: null, endedAt: null } },
  });
  t.after(() => useLive.setState(saved, true));
  const browser = createBrowserStore();
  const windowId = browser.getState().createWindow();
  const subscribe = browser.subscribe;
  let removals = 0;
  t.mock.method(browser, "subscribe", (...args) => {
    const unsubscribe = subscribe(...args);
    return () => {
      removals++;
      unsubscribe();
    };
  });
  const failure = new Error("timer unavailable");
  const timer = t.mock.method(globalThis, "setTimeout", () => {
    throw failure;
  });
  assert.throws(
    () => startMeetingGroups(browser),
    (error) => error === failure,
  );
  assert.equal(removals, 1);
  const tab = browser.getState().newTab(windowId, { url: "https://meet.google.com/abc-defg-hij" });
  assert.equal(groupOf(browser.getState(), tab), undefined);
  timer.mock.restore();
  const stop = startMeetingGroups(browser);
  stop();
  assert.equal(removals, 2);
});
