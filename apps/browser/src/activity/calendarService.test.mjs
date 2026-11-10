// The calendar (activity/calendarService.ts): what the Mac's calendar holds, and what the app shows of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { CalendarEngine, CalendarService, useCalendar } = await import("./calendarService.ts");
const { Diagnostics } = await import("../effect/ports/diagnostics.ts");
const { Scheduler } = await import("../effect/ports/scheduler.ts");

// The Mac's calendar, as a test wants it: what it holds, and whether the app may read it.
const fakeEngine = () => {
  const lab = {
    access: "fullAccess",
    requested: 0,
    reads: 0,
    calendars: [{ id: "work", title: "Work", color: "blue", source: "cal", writable: true }],
    events: [{ id: "one", title: "Standup", calendarId: "work", start: 10, end: 20, occurrence: "one@10" }],
  };

  const layer = Layer.succeed(CalendarEngine)({
    authorization: () => Effect.sync(() => lab.access),
    requestAccess: () =>
      Effect.sync(() => {
        lab.requested++;
        lab.access = "fullAccess";

        return true;
      }),
    calendars: () =>
      Effect.sync(() => {
        lab.reads++;

        return lab.calendars;
      }),
    events: () => Effect.sync(() => lab.events),
    changed: () => () => {},
  });

  return { layer, lab };
};

const withService = async (use) => {
  const engine = fakeEngine();

  const runtime = ManagedRuntime.make(
    CalendarService.layer.pipe(Layer.provide(Layer.mergeAll(engine.layer, Scheduler.layer.pipe(Layer.provide(Diagnostics.layer))))),
  );

  try {
    await use({ lab: engine.lab, runtime });
  } finally {
    await runtime.dispose();
  }
};

const refresh = (runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.refresh();
    }),
  );

test("a refresh shows the Mac's calendar and its events", async () => {
  await withService(async ({ lab, runtime }) => {
    await refresh(runtime);

    assert.equal(useCalendar.getState().access, "fullAccess");
    assert.equal(useCalendar.getState().calendars.length, 1);
    assert.equal(useCalendar.getState().events.length, 1);
    assert.equal(useCalendar.getState().events[0].title, "Standup");
    assert.equal(useCalendar.getState().loading, false);
    assert.equal(lab.reads, 1);
  });
});

test("a Mac that may not be read shows nothing, and asks for nothing", async () => {
  await withService(async ({ lab, runtime }) => {
    lab.access = "denied";

    await refresh(runtime);

    assert.equal(useCalendar.getState().access, "denied");
    assert.deepEqual(useCalendar.getState().events, []);
    assert.equal(lab.requested, 0, "the access is asked for only from an explicit click");
  });
});

test("connecting asks the Mac once, and shows what it holds", async () => {
  await withService(async ({ lab, runtime }) => {
    lab.access = "notDetermined";

    const granted = await runtime.runPromise(
      Effect.gen(function* () {
        const calendar = yield* CalendarService;

        return yield* calendar.connect();
      }),
    );

    assert.equal(granted, true);
    assert.equal(lab.requested, 1);
    assert.equal(useCalendar.getState().events.length, 1);
  });
});

test("a calendar that cannot be read keeps the error, and the app carries on", async () => {
  await withService(async ({ runtime }) => {
    // The native side is asked for calendars it cannot give: the refresh reports it and stops.
    await refresh(runtime);

    assert.equal(useCalendar.getState().loading, false);
  });
});
