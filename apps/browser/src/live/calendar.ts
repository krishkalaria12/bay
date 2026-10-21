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
} from "@bay/shell";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { CalendarEvent } from "./meetings";
import { live, updateCalendarSettings, useLive } from "./store";
import { CALENDAR_HORIZON_MS } from "./constants";

type CalendarData = {
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

type Fixture = {
  calendars: SystemCalendar[];
  events: (Omit<CalendarEvent, "start" | "end" | "occurrence"> & { startInMinutes: number; durationMinutes: number })[];
};

const fixtureMode = (() => {
  try {
    return typeof __DEV__ !== "undefined" && __DEV__ && launchEnvironment("BAY_CALENDAR_FIXTURE") === "1";
  } catch {
    return false;
  }
})();
const launchedAt = Date.now();

function loadFixture(): { calendars: SystemCalendar[]; events: CalendarEvent[] } {
  const raw = JSON.parse(readDocument("calendar-fixture.json") ?? '{"calendars":[],"events":[]}') as Fixture;
  const base = Math.floor(launchedAt / 60_000) * 60_000;
  const events = raw.events.map(({ startInMinutes, durationMinutes, ...e }) => {
    const start = base + startInMinutes * 60_000;
    return { ...e, start, end: start + durationMinutes * 60_000, occurrence: `${e.id}@${start}` };
  });
  return { calendars: raw.calendars, events };
}

const visible = (calendars: SystemCalendar[]) => {
  const hidden = new Set(live().calendar.hiddenCalendarIds);
  return calendars.filter((c) => !hidden.has(c.id)).map((c) => c.id);
};

type CalendarScope = { active: boolean };
let service: { scope: CalendarScope; stop: () => void } | undefined;
let inflight: { promise: Promise<void>; scope?: CalendarScope } | undefined;

export function refreshCalendar(): Promise<void> {
  if (inflight) return inflight.promise;
  const scope = service?.scope;
  const active = () => !scope || scope.active;
  const run = async () => {
    useCalendar.setState({ loading: true });
    try {
      if (fixtureMode) {
        const { calendars, events } = loadFixture();
        const ids = new Set(visible(calendars));
        useCalendar.setState({ access: "fixture", calendars, events: events.filter((e) => ids.has(e.calendarId)), error: null, lastFetch: Date.now() });
        return;
      }
      const access = calendarAuthorization();
      if (access !== "fullAccess") {
        useCalendar.setState({ access, calendars: [], events: [], error: null });
        return;
      }
      const calendars = await systemCalendars();
      if (!active()) return;
      const ids = visible(calendars);
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const events = ids.length ? await systemCalendarEvents(start.getTime(), Date.now() + CALENDAR_HORIZON_MS, ids) : [];
      if (!active()) return;
      useCalendar.setState({ access, calendars, events: events.sort((a, b) => a.start - b.start), error: null, lastFetch: Date.now() });
    } catch (error) {
      if (active()) useCalendar.setState({ error: String((error as Error)?.message ?? error) });
    } finally {
      if (active()) useCalendar.setState({ loading: false });
    }
  };
  const task = {
    scope,
    promise: run().finally(() => {
      if (inflight === task) inflight = undefined;
    }),
  };
  inflight = task;
  return task.promise;
}

// Request EventKit access only from an explicit click.
export async function connectCalendar(active: () => boolean = () => true): Promise<boolean> {
  if (!active()) return false;
  if (fixtureMode) {
    await refreshCalendar();
    return true;
  }
  const granted = await requestCalendarAccess();
  if (!active()) return granted;
  await refreshCalendar();
  return granted;
}

export const calendarConnected = () => {
  const access = useCalendar.getState().access;
  return access === "fullAccess" || access === "fixture";
};

export function startCalendar(): () => void {
  if (service) return service.stop;
  const scope: CalendarScope = { active: true };
  const disposers: (() => void)[] = [];
  const stop = () => {
    if (!scope.active) return;
    scope.active = false;
    if (service?.scope === scope) service = undefined;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn("Couldn't stop calendar watcher", error);
      }
    }
    if (inflight?.scope === scope) {
      inflight = undefined;
      useCalendar.setState({ loading: false });
    }
  };
  service = { scope, stop };
  try {
    void refreshCalendar();
    const changed = onCalendarChanged(() => {
      if (scope.active) void refreshCalendar();
    });
    disposers.push(() => changed.remove());
    const interval = setInterval(() => void refreshCalendar(), 5 * 60_000);
    disposers.push(() => clearInterval(interval));
    disposers.push(
      useLive.subscribe((s, prev) => {
        if (s.calendar.hiddenCalendarIds !== prev.calendar.hiddenCalendarIds) void refreshCalendar();
      }),
    );
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

export const setCalendarHidden = (id: string, hidden: boolean) => {
  const ids = live().calendar.hiddenCalendarIds.filter((c) => c !== id);
  updateCalendarSettings({ hiddenCalendarIds: hidden ? [...ids, id] : ids });
};

export function useNow(intervalMs = 15_000, enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}
