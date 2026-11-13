// The calendar (activity/calendarService.ts): what the Mac's calendar holds, and what the app shows of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

const { CalendarEngine, CalendarFailure, CalendarService, useCalendar } = await import("./calendarService.ts");
const { Diagnostics } = await import("../effect/ports/diagnostics.ts");
const { Scheduler } = await import("../effect/ports/scheduler.ts");

// The Mac's calendar, as a test wants it: what it holds, and whether the app may read it.
const fakeEngine = () => {
  const lab = {
    access: "fullAccess",
    requested: 0,
    reads: 0,
    gate: null,
    failAt: null,
    calendars: [{ id: "work", title: "Work", color: "blue", source: "cal", writable: true }],
    events: [{ id: "one", title: "Standup", calendarId: "work", start: 10, end: 20, occurrence: "one@10" }],
  };

  const layer = Layer.succeed(CalendarEngine)({
    authorization: () =>
      Effect.suspend(() =>
        lab.failAt === "authorization"
          ? Effect.fail(new CalendarFailure({ operation: "calendar.authorization", cause: new Error("calendar unavailable") }))
          : Effect.succeed(lab.access),
      ),
    requestAccess: () =>
      Effect.sync(() => {
        lab.requested++;
        lab.access = "fullAccess";

        return true;
      }),
    calendars: () =>
      Effect.suspend(() => {
        lab.reads++;

        if (lab.failAt === "calendars") {
          return Effect.fail(new CalendarFailure({ operation: "calendar.calendars", cause: new Error("calendar unavailable") }));
        }

        return Effect.promise(async () => {
          if (lab.gate) await lab.gate;

          return lab.calendars;
        });
      }),
    events: () =>
      Effect.suspend(() =>
        lab.failAt === "events"
          ? Effect.fail(new CalendarFailure({ operation: "calendar.events", cause: new Error("calendar unavailable") }))
          : Effect.succeed(lab.events),
      ),
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

const refresh = (runtime, signal) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.refresh();
    }),
    { signal },
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

test("a failed refresh keeps the last calendar and reports the read error", async () => {
  for (const failAt of ["authorization", "calendars", "events"]) {
    await withService(async ({ lab, runtime }) => {
      await refresh(runtime);

      const previous = useCalendar.getState();

      lab.failAt = failAt;
      await refresh(runtime);

      const current = useCalendar.getState();

      assert.equal(current.access, previous.access);
      assert.equal(current.calendars, previous.calendars);
      assert.equal(current.events, previous.events);
      assert.equal(current.lastFetch, previous.lastFetch);
      assert.match(current.error, /calendar unavailable/);
      assert.equal(current.loading, false);
    });
  }
});

test("overlapping refreshes share one native read", async () => {
  await withService(async ({ lab, runtime }) => {
    let release;

    lab.gate = new Promise((resolve) => {
      release = resolve;
    });

    try {
      const first = refresh(runtime);

      for (let attempt = 0; attempt < 100 && lab.reads === 0; attempt++) await new Promise((resolve) => setImmediate(resolve));

      assert.equal(lab.reads, 1);

      const second = refresh(runtime);

      for (let attempt = 0; attempt < 20; attempt++) await new Promise((resolve) => setImmediate(resolve));

      assert.equal(lab.reads, 1, "the second refresh waited for the native read already in progress");
      release();
      await Promise.all([first, second]);
      assert.equal(useCalendar.getState().loading, false);
      await refresh(runtime);
      assert.equal(lab.reads, 2, "the completed refresh released its shared job");
    } finally {
      release();
    }
  });
});

test("cancelling a refresh caller leaves the shared read available to other callers", async () => {
  await withService(async ({ lab, runtime }) => {
    let release;

    lab.gate = new Promise((resolve) => {
      release = resolve;
    });

    const controller = new AbortController();
    const first = refresh(runtime, controller.signal);
    const cancelled = assert.rejects(first, /interrupted/);

    try {
      for (let attempt = 0; attempt < 100 && lab.reads === 0; attempt++) await new Promise((resolve) => setImmediate(resolve));

      assert.equal(lab.reads, 1);
      controller.abort();
      await cancelled;
      assert.equal(useCalendar.getState().loading, true);

      const second = refresh(runtime);

      release();
      await second;
      assert.equal(lab.reads, 1);
      assert.equal(useCalendar.getState().loading, false);
    } finally {
      release();
    }
  });
});
