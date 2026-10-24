import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserStore } from "../store/browser.ts";
import { appEventListeners, windowEventListeners } from "../test-native-stub.mjs";
import { startMeetingAlerts, useMeetingAlert } from "./alerts.ts";
import { useCalendar } from "./calendar.ts";
import { useLive } from "./store.ts";

const event = (id) => ({
  id,
  occurrence: id,
  calendarId: "calendar",
  title: "Meeting",
  start: Date.now(),
  end: Date.now() + 60_000,
  allDay: false,
  cancelled: false,
  declined: false,
  url: "https://meet.google.com/abc-defg-hij",
  notes: "",
  location: "",
  attendees: [],
});

test("meeting alerts start once, stop calendar and timer updates, and restart", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = createBrowserStore();
  const savedLive = useLive.getState();
  const savedCalendar = useCalendar.getState();
  const savedAlert = useMeetingAlert.getState();
  useLive.setState({ calendar: { ...savedLive.calendar, alertLead: "1" }, dismissedAlerts: [] });
  const first = event("first");
  useCalendar.setState({ events: [first] });
  const appListenersBefore = appEventListeners.size;
  const windowListenersBefore = windowEventListeners.size;
  const stop = startMeetingAlerts(browser);
  t.after(() => {
    stop();
    useCalendar.setState(savedCalendar, true);
    useLive.setState(savedLive, true);
    useMeetingAlert.setState(savedAlert, true);
  });
  assert.strictEqual(startMeetingAlerts(browser), stop);
  assert.equal(appEventListeners.size, appListenersBefore + 1);
  assert.equal(windowEventListeners.size, windowListenersBefore + 1);
  assert.equal(useMeetingAlert.getState().event.occurrence, "first");

  useCalendar.setState({ events: [] });
  assert.equal(useMeetingAlert.getState().event, null);
  const second = event("second");
  useCalendar.setState({ events: [second] });
  assert.equal(useMeetingAlert.getState().event.occurrence, "second");
  stop();
  stop();
  assert.equal(appEventListeners.size, appListenersBefore);
  assert.equal(windowEventListeners.size, windowListenersBefore);
  useCalendar.setState({ events: [] });
  t.mock.timers.tick(30_000);
  assert.equal(useMeetingAlert.getState().event.occurrence, "second");
  const restarted = startMeetingAlerts(browser);
  assert.notStrictEqual(restarted, stop);
  assert.equal(useMeetingAlert.getState().event, null);
  restarted();
});

test("meeting alert startup rolls back earlier native listeners when registration fails", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = createBrowserStore();
  const appBefore = appEventListeners.size;
  const windowsBefore = windowEventListeners.size;
  const failure = new Error("window events unavailable");
  const registration = t.mock.method(windowEventListeners, "add", () => {
    throw failure;
  });
  assert.throws(
    () => startMeetingAlerts(browser),
    (error) => error === failure,
  );
  assert.equal(appEventListeners.size, appBefore);
  assert.equal(windowEventListeners.size, windowsBefore);
  registration.mock.restore();
  const stop = startMeetingAlerts(browser);
  assert.equal(appEventListeners.size, appBefore + 1);
  stop();
  assert.equal(appEventListeners.size, appBefore);
});

test("meeting alert stop attempts every cleanup and releases ownership after a cleanup fails", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const browser = createBrowserStore();
  const appBefore = appEventListeners.size;
  const windowsBefore = windowEventListeners.size;
  const subscribe = useCalendar.subscribe;
  const warning = t.mock.method(console, "warn", () => {});
  const registration = t.mock.method(useCalendar, "subscribe", (...args) => {
    const unsubscribe = subscribe(...args);
    return () => {
      unsubscribe();
      throw new Error("cleanup failed");
    };
  });
  const stop = startMeetingAlerts(browser);
  stop();
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(appEventListeners.size, appBefore);
  assert.equal(windowEventListeners.size, windowsBefore);
  registration.mock.restore();
  const restarted = startMeetingAlerts(browser);
  assert.notStrictEqual(restarted, stop);
  restarted();
});
