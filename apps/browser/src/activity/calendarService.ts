// The calendar: what the Mac's calendar holds, and what the app shows of it.
//
// A refresh is a job: it runs once at a time, and the access is asked for only from an explicit click. The events
// and the calendars they come from are the native side's own shapes: the app maps them, it does not own them.
import {
  calendarAuthorization,
  launchEnvironment,
  onCalendarChanged,
  readDocument,
  requestCalendarAccess,
  systemCalendarEvents,
  systemCalendars,
  type CalendarAuthorization,
  type SystemCalendar,
} from "@bay/desktop";
import { create } from "zustand";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Scheduler } from "../effect/ports/scheduler";
import { live, useLive } from "./activityStore";
import { CALENDAR_HORIZON_MS } from "./constants";
import type { CalendarEvent } from "./meetings";

/** The Mac's calendar could not be read. */
export class CalendarFailure extends TaggedError("CalendarFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** What the app shows of the Mac's calendar. */
export type CalendarData = {
  access: CalendarAuthorization | "fixture";
  calendars: SystemCalendar[];
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;
  lastFetch: number | null;
};

export const useCalendar = create<CalendarData>()(() => ({
  access: "notDetermined",
  calendars: [],
  events: [],
  loading: false,
  error: null,
  lastFetch: null,
}));

/** The native side of the calendar, as the service reaches it. */
export class CalendarEngine extends Context.Service<
  CalendarEngine,
  {
    readonly authorization: () => Effect.Effect<CalendarAuthorization, CalendarFailure>;
    readonly requestAccess: () => Effect.Effect<boolean, CalendarFailure>;
    readonly calendars: () => Effect.Effect<SystemCalendar[], CalendarFailure>;
    readonly events: (from: number, to: number, ids: string[]) => Effect.Effect<CalendarEvent[], CalendarFailure>;
    /** The native side's own change to the calendar. */
    readonly changed: (listener: () => void) => () => void;
  }
>()("bay/CalendarEngine") {
  static readonly layer = Layer.succeed(CalendarEngine)({
    authorization: () =>
      Effect.tryPromise({
        try: async () => calendarAuthorization(),
        catch: (cause) => new CalendarFailure({ operation: "calendar.authorization", cause }),
      }),
    requestAccess: () =>
      Effect.tryPromise({
        try: () => requestCalendarAccess(),
        catch: (cause) => new CalendarFailure({ operation: "calendar.requestAccess", cause }),
      }),
    calendars: () =>
      Effect.tryPromise({
        try: () => systemCalendars(),
        catch: (cause) => new CalendarFailure({ operation: "calendar.calendars", cause }),
      }),
    events: (from, to, ids) =>
      Effect.tryPromise({
        try: () => systemCalendarEvents(from, to, ids),
        catch: (cause) => new CalendarFailure({ operation: "calendar.events", cause }),
      }),
    changed: (listener) => {
      const subscription = onCalendarChanged(listener);

      return () => subscription.remove();
    },
  });
}

// The dev fixture: a calendar the app reads instead of the Mac's, for the work on it.
const fixtureMode = (() => {
  try {
    return typeof __DEV__ !== "undefined" && __DEV__ && launchEnvironment("BAY_CALENDAR_FIXTURE") === "1";
  } catch {
    return false;
  }
})();

type Fixture = {
  calendars: SystemCalendar[];
  events: (Omit<CalendarEvent, "start" | "end" | "occurrence"> & { startInMinutes: number; durationMinutes: number })[];
};

const launchedAt = Date.now();

const noEvents: CalendarEvent[] = [];

type FixtureEvents = { calendars: SystemCalendar[]; events: CalendarEvent[] };

function loadFixture(): FixtureEvents {
  // SAFETY: Fixture assertion matches the runtime value validated at this call site.
  const raw = JSON.parse(readDocument("calendar-fixture.json") ?? '{"calendars":[],"events":[]}') as Fixture;
  const base = Math.floor(launchedAt / 60_000) * 60_000;

  const events = raw.events.map(({ startInMinutes, durationMinutes, ...e }) => {
    const start = base + startInMinutes * 60_000;

    return { ...e, start, end: start + durationMinutes * 60_000, occurrence: `${e.id}@${start}` };
  });

  return { calendars: raw.calendars, events };
}

/** The calendars the app shows: the ones the user has not hidden. */
export const visibleCalendars = (calendars: SystemCalendar[]): string[] => {
  const hidden = new Set(live().calendar.hiddenCalendarIds);

  return calendars.flatMap((c) => (!hidden.has(c.id) ? [c.id] : []));
};

/** Whether the app may read the Mac's calendar. */
export const calendarConnected = (): boolean => {
  const access = useCalendar.getState().access;

  return access === "fullAccess" || access === "fixture";
};

export class CalendarService extends Context.Service<
  CalendarService,
  {
    /** Reads the Mac's calendar and shows it. */
    readonly refresh: () => Effect.Effect<void>;
    /**
     * Asks the Mac for the calendar's access, and shows it. `active` is the asking owner: an owner that went while
     * the Mac was asking gets the answer, but starts no read.
     */
    readonly connect: (active?: () => boolean) => Effect.Effect<boolean>;
    /** Starts the refreshes: at the launch, when the calendar changes, and every few minutes. */
    readonly start: Effect.Effect<void>;
    /** Stops the watchers and the polling; the next start registers them again. */
    readonly stop: Effect.Effect<void>;
  }
>()("bay/CalendarService") {
  static readonly layer = Layer.effect(
    CalendarService,
    Effect.gen(function* () {
      const engine = yield* CalendarEngine;
      const scheduler = yield* Scheduler;
      const scope = yield* Scope.Scope;
      const services = yield* Effect.context<never>();

      // The watchers and the polling of one start. Stopping closes it, and the next start opens another.
      let workScope = Scope.forkUnsafe(scope);
      let started = false;

      const readEvents = (ids: string[]): Effect.Effect<CalendarEvent[], CalendarFailure> => {
        if (!ids.length) return Effect.succeed(noEvents);

        const start = new Date();

        start.setHours(0, 0, 0, 0);

        return engine.events(start.getTime(), Date.now() + CALENDAR_HORIZON_MS, ids);
      };

      const readCalendar = (): Effect.Effect<void, CalendarFailure> =>
        Effect.gen(function* () {
          if (fixtureMode) {
            const { calendars, events } = loadFixture();
            const ids = new Set(visibleCalendars(calendars));

            yield* Effect.sync(() =>
              useCalendar.setState({
                access: "fixture",
                calendars,
                events: events.filter((e) => ids.has(e.calendarId)),
                error: null,
                lastFetch: Date.now(),
              }),
            );

            return;
          }

          const access = yield* engine.authorization();

          if (access !== "fullAccess") {
            yield* Effect.sync(() => useCalendar.setState({ access, calendars: [], events: [], error: null }));

            return;
          }

          const calendars = yield* engine.calendars();

          const ids = visibleCalendars(calendars);
          const events = yield* readEvents(ids);

          yield* Effect.sync(() =>
            useCalendar.setState({
              access,
              calendars,
              events: events.sort((a, b) => a.start - b.start),
              error: null,
              lastFetch: Date.now(),
            }),
          );
        });

      // The refresh that is running now, if any: the calendar is read once at a time.
      let inflight: Fiber.Fiber<void> | undefined;
      // Which read is the current one. A stopped read finishes after the read that replaced it, and must not
      // clear that one's inflight entry.
      let generation = 0;

      const reading = (id: number) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => useCalendar.setState({ loading: true }));

          const exit = yield* Effect.exit(readCalendar());

          // A stop interrupts the read, and a read that was interrupted shows nothing. Only a failure is shown.
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;

          const failure = Cause.squash(exit.cause);
          const cause = failure instanceof CalendarFailure ? failure.cause : failure;

          yield* Effect.sync(() => useCalendar.setState({ error: cause instanceof Error ? cause.message : String(cause) }));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (generation !== id) return;
              inflight = undefined;
              useCalendar.setState({ loading: false });
            }),
          ),
        );

      const refresh = (): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const running = inflight;

            if (running) {
              // A stop interrupts the read; the caller's ask is answered either way.
              yield* restore(Effect.exit(Fiber.join(running)));

              return;
            }

            const fiber = yield* Effect.forkIn(restore(reading(++generation)), workScope);

            inflight = fiber;
            yield* restore(Fiber.join(fiber));
          }),
        );

      const connect = (active: () => boolean = () => true): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const granted = yield* engine.requestAccess().pipe(Effect.catch(() => Effect.succeed(false)));

          // The owner that asked is gone: its answer must not start a read that lands on the next owner's state.
          if (!active()) return granted;

          yield* refresh();

          return granted;
        });

      const start = Effect.suspend((): Effect.Effect<void> => {
        if (started) return Effect.void;
        started = true;
        const work = workScope;

        return Effect.gen(function* () {
          yield* refresh();

          const following = () => Effect.runForkWith(services)(Effect.forkIn(refresh(), work));
          const stopListening = engine.changed(following);

          yield* Scope.addFinalizer(work, Effect.sync(stopListening));

          // Only while connected: connecting refreshes on its own.
          yield* scheduler.every({
            scope: work,
            every: 5 * 60_000,
            run: refresh(),
            needed: () => calendarConnected(),
            watch: (changed) => useCalendar.subscribe((s, prev) => s.access !== prev.access && changed()),
          });

          const stopHidden = useLive.subscribe((s, prev) => {
            if (s.calendar.hiddenCalendarIds !== prev.calendar.hiddenCalendarIds) following();
          });

          yield* Scope.addFinalizer(work, Effect.sync(stopHidden));
        }).pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (Exit.isSuccess(exit)) return Effect.void;

              // A start that could not finish leaves nothing behind: its watcher and its slot go with it, and
              // the next start opens a fresh scope.
              if (workScope !== work) return Effect.void;

              started = false;
              workScope = Scope.forkUnsafe(scope);

              return Scope.close(work, Exit.succeed(undefined));
            }),
          ),
        );
      });

      const stop = Effect.suspend((): Effect.Effect<void> => {
        started = false;
        generation++;
        inflight = undefined;
        useCalendar.setState({ loading: false });
        const previous = workScope;
        workScope = Scope.forkUnsafe(scope);

        return Scope.close(previous, Exit.succeed(undefined));
      });

      return CalendarService.of({ refresh, connect, start, stop });
    }),
  );
}
