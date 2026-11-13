// The calendar adapter (activity/calendar.ts) over the calendar service (activity/calendarService.ts): what a stop
// takes away, that a stopped read cannot land on the state a restart owns, and that the app can reach the service
// again after a start that failed.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

const native = { listeners: new Set(), calendars: async () => [], events: async () => [], permission: async () => true };

globalThis.calendarLifecycleNative = native;

const stub = new URL("../test-native-stub.mjs", import.meta.url).href;

const shell = `export * from ${JSON.stringify(stub)};
export const calendarAuthorization = () => "fullAccess";
export const requestCalendarAccess = () => globalThis.calendarLifecycleNative.permission();
export const systemCalendars = (...args) => globalThis.calendarLifecycleNative.calendars(...args);
export const systemCalendarEvents = (...args) => globalThis.calendarLifecycleNative.events(...args);
export const onCalendarChanged = (listener) => {
  if (globalThis.calendarLifecycleNative.registrationError) throw globalThis.calendarLifecycleNative.registrationError;
  const listeners = globalThis.calendarLifecycleNative.listeners;
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
};`;

registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@bay/desktop" ? { url: `data:text/javascript,${encodeURIComponent(shell)}`, shortCircuit: true } : next(specifier, context);
  },
});

const { refreshCalendar, startCalendar, useCalendar } = await import("./calendar.ts");
const { live, updateCalendarSettings, useLive } = await import("./activityStore.ts");
const { slowTimersForTests } = await import("../lib/throttledTimers.ts");

// The service is the desktop runtime's: its watcher and its slot on the grid are in place once its fiber has run.
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

// The periodic refresh is a job on the shared grid; the grid's own algorithm is lib/throttledTimers.test.mjs's.
const B = 1_000_000_020_000;
let now = B;
const grid = slowTimersForTests(() => now);

const at = (t) => {
  now = t;
  grid.fire();
};

const deferred = () => {
  let resolve;

  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

function setup(context) {
  grid.clear();
  now = B;
  native.calendars = async () => [];
  native.events = async () => [];
  // Connected, so the polling job has something to do: it is on the grid only while it does.
  useCalendar.setState({ access: "fullAccess", calendars: [], events: [], loading: false, error: null, lastFetch: null });
  const stops = [];
  context.after(async () => {
    for (const stop of stops.reverse()) stop();
    await settle();
    grid.clear();
  });

  return {
    start: async () => {
      const stop = startCalendar();

      stops.push(stop);
      await settle();

      return stop;
    },
  };
}

test("calendar disposal removes watchers and polling while explicit refresh still works", async (context) => {
  const { start } = setup(context);
  let reads = 0;

  native.calendars = async () => {
    reads++;

    return [];
  };

  const stop = await start();
  assert.equal(startCalendar(), stop);
  assert.equal(reads, 1);
  assert.equal(native.listeners.size, 1);
  assert.notEqual(grid.pending(), null, "the polling is on the grid while the calendar is watched");
  stop();
  stop();
  await settle();
  assert.equal(native.listeners.size, 0);
  assert.equal(grid.pending(), null, "the polling left the grid with the watcher");
  updateCalendarSettings({ hiddenCalendarIds: [...live().calendar.hiddenCalendarIds, "hidden"] });
  at(now + 10 * 60_000);
  await settle();
  assert.equal(reads, 1);
  await refreshCalendar();
  assert.equal(reads, 2);
});

test("a stopped calendar refresh cannot overwrite a restarted refresh or clear its inflight request", async (context) => {
  const { start } = setup(context);

  const old = deferred(),
    current = deferred();

  let stale = 0,
    fresh = 0;

  native.calendars = () => {
    stale++;

    return old.promise;
  };

  const stop = await start();
  assert.equal(stale, 1);
  // The explicit ask joins the read the start began instead of asking the Mac again.
  const previous = refreshCalendar();
  stop();
  await settle();
  native.calendars = () => {
    fresh++;

    return current.promise;
  };

  const stopCurrent = await start();
  const pending = refreshCalendar();
  await settle();
  assert.equal(fresh, 1, "the second ask joined the read instead of asking the Mac again");
  old.resolve([{ id: "old" }]);
  await previous;
  assert.equal(stale, 1, "the stopped read asked the Mac once");
  assert.equal(useCalendar.getState().loading, true, "the stopped read did not clear the restarted read");
  assert.deepEqual(useCalendar.getState().calendars, []);
  current.resolve([]);
  await pending;
  assert.deepEqual(useCalendar.getState().calendars, []);
  assert.equal(useCalendar.getState().loading, false);
  stopCurrent();
  await settle();
});

test("calendar event results settling after disposal do not publish state", async (context) => {
  const { start } = setup(context);

  const events = deferred();

  native.calendars = async () => [{ id: "primary" }];
  native.events = () => events.promise;
  const stop = await start();

  // The start's own read is the one in flight, and the stop takes it away.
  assert.equal(useCalendar.getState().loading, true);
  stop();
  await settle();
  const before = useCalendar.getState();

  events.resolve([{ id: "stale", start: 1 }]);
  await settle();
  assert.equal(useCalendar.getState(), before);
});

for (const failure of ["native registration", "later subscription"]) {
  test(`calendar startup unwinds ${failure} failure and can restart`, async (context) => {
    const { start } = setup(context);
    const error = new Error("registration failed");

    const subscription =
      failure === "later subscription"
        ? context.mock.method(useLive, "subscribe", () => {
            throw error;
          })
        : null;

    if (failure === "native registration") native.registrationError = error;

    const reported = context.mock.method(console, "error", () => {});

    try {
      startCalendar();
      await settle();
    } finally {
      native.registrationError = undefined;
      subscription?.mock.restore();
    }

    assert.equal(native.listeners.size, 0, "the failed start removed its watcher");
    assert.equal(grid.pending(), null, "the failed start left no job on the grid");
    assert.ok(reported.mock.callCount() > 0, "the failure is reported");
    assert.equal(useCalendar.getState().loading, false);

    let reads = 0;

    native.calendars = async () => {
      reads++;

      return [];
    };

    at(now + 10 * 60_000);
    await settle();
    assert.equal(reads, 0, "the failed start left no polling behind");

    const stop = await start();
    assert.equal(reads, 1, "the restarted calendar reads once");
    assert.equal(native.listeners.size, 1);
    stop();
    await settle();
  });
}
