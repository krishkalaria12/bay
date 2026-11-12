// The calendar: what the Mac's calendar holds, and what the app shows of it.
//
// The work is in activity/calendarService.ts. This is where the app reaches it.
import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import { runDesktop } from "../effect/runtime";
import { live, updateCalendarSettings } from "./activityStore";
import { CalendarService, calendarConnected, useCalendar } from "./calendarService";

export { calendarConnected, useCalendar };

/** Reads the Mac's calendar and shows it. */
export function refreshCalendar(): Promise<void> {
  return runDesktop(
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.refresh();
    }),
  );
}

/** Asks the Mac for the calendar's access, and shows it. */
export function connectCalendar(): Promise<boolean> {
  return runDesktop(
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      return yield* calendar.connect();
    }),
  );
}

/** Starts the refreshes: at the launch, when the calendar changes, and every few minutes. */
export function startCalendar() {
  void runDesktop(
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.start;
    }),
  );
}

export const setCalendarHidden = (id: string, hidden: boolean) => {
  const current = live().calendar.hiddenCalendarIds.filter((c) => c !== id);

  updateCalendarSettings({ hiddenCalendarIds: hidden ? [...current, id] : current });
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
