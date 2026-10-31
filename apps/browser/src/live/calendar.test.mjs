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
    return specifier === "@bay/shell" ? { url: `data:text/javascript,${encodeURIComponent(shell)}`, shortCircuit: true } : next(specifier, context);
  },
});
const { connectCalendar, refreshCalendar, startCalendar, useCalendar } = await import("./calendar.ts");
const { live, updateCalendarSettings, useLive } = await import("./store.ts");
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function setup(context) {
  context.mock.timers.enable({ apis: ["setInterval"] });
  native.calendars = async () => [];
  native.events = async () => [];
  useCalendar.setState({ calendars: [], events: [], loading: false, error: null, lastFetch: null });
  context.after(() => {
    startCalendar()();
    context.mock.timers.reset();
  });
}

test("calendar disposal removes watchers and polling while explicit refresh still works", async (context) => {
  setup(context);
  let reads = 0;
  native.calendars = async () => {
    reads++;
    return [];
  };
  const stop = startCalendar();
  assert.equal(startCalendar(), stop);
  await tick();
  assert.equal(reads, 1);
  assert.equal(native.listeners.size, 1);
  stop();
  stop();
  assert.equal(native.listeners.size, 0);
  updateCalendarSettings({ hiddenCalendarIds: [...live().calendar.hiddenCalendarIds, "hidden"] });
  context.mock.timers.tick(10 * 60_000);
  await tick();
  assert.equal(reads, 1);
  await refreshCalendar();
  assert.equal(reads, 2);
});

test("a stopped calendar refresh cannot overwrite a restarted refresh or clear its inflight request", async (context) => {
  setup(context);
  const old = deferred(),
    current = deferred();
  native.calendars = () => old.promise;
  const stop = startCalendar();
  const previous = refreshCalendar();
  stop();
  native.calendars = () => current.promise;
  const stopCurrent = startCalendar();
  const pending = refreshCalendar();
  old.resolve([{ id: "old" }]);
  await previous;
  assert.equal(useCalendar.getState().loading, true);
  assert.equal(refreshCalendar(), pending);
  current.resolve([]);
  await pending;
  assert.deepEqual(useCalendar.getState().calendars, []);
  stopCurrent();
});

test("calendar event results settling after disposal do not publish state", async (context) => {
  setup(context);
  const events = deferred();
  native.calendars = async () => [{ id: "primary" }];
  native.events = () => events.promise;
  const stop = startCalendar();
  const pending = refreshCalendar();
  await tick();
  stop();
  const before = useCalendar.getState();
  events.resolve([{ id: "stale", start: 1 }]);
  await pending;
  assert.equal(useCalendar.getState(), before);
});

for (const failure of ["native registration", "later subscription"]) {
  test(`calendar startup unwinds ${failure} failure and can restart`, async (context) => {
    setup(context);
    const old = deferred();
    native.calendars = () => old.promise;
    const error = new Error("registration failed");
    const subscription =
      failure === "later subscription"
        ? context.mock.method(useLive, "subscribe", () => {
            throw error;
          })
        : null;
    if (failure === "native registration") native.registrationError = error;
    try {
      assert.throws(
        () => startCalendar(),
        (caught) => caught === error,
      );
    } finally {
      native.registrationError = undefined;
      subscription?.mock.restore();
    }
    assert.equal(native.listeners.size, 0);
    assert.equal(useCalendar.getState().loading, false);
    let reads = 0;
    native.calendars = async () => {
      reads++;
      return [];
    };
    context.mock.timers.tick(10 * 60_000);
    await tick();
    assert.equal(reads, 0);
    const stop = startCalendar();
    await refreshCalendar();
    assert.equal(reads, 1);
    const before = useCalendar.getState();
    old.resolve([{ id: "stale" }]);
    await tick();
    assert.equal(useCalendar.getState(), before);
    stop();
  });
}

test("calendar permission completion cannot start a refresh for a disposed meeting owner", async (context) => {
  setup(context);
  const permission = deferred();
  native.permission = () => permission.promise;
  let reads = 0;
  native.calendars = async () => {
    reads++;
    return [{ id: "late" }];
  };
  let active = true;
  const connecting = connectCalendar(() => active);
  const snapshot = useCalendar.getState();
  active = false;
  permission.resolve(true);
  assert.equal(await connecting, true);
  assert.equal(reads, 0);
  assert.equal(useCalendar.getState(), snapshot);
  native.permission = async () => true;
});
