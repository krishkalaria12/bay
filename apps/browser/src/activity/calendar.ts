// The calendar: what the Mac's calendar holds, and what the app shows of it.
//
// The work is in activity/calendarService.ts. This is where the app reaches it.
import { hasServiceClient, requestService, sendService } from "../runtime/serviceClient";
import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import { runForStore } from "../effect/runtime";
import { startStoreService } from "../effect/storeService";
import { useBrowser, type BrowserStore } from "../store/browserStore";
import { live, updateCalendarSettings } from "./activityStore";
import { CalendarService, calendarConnected, useCalendar } from "./calendarService";

export { calendarConnected, useCalendar };

export type { CalendarData } from "./calendarService";

// The store's calendar refresh, so one store that starts it twice gets one stop.
const calendars = new WeakMap<BrowserStore, () => void>();

/** Reads the Mac's calendar and shows it. */
export function refreshCalendar(): Promise<void> {
  if (hasServiceClient()) return requestService("calendarRefresh", []);

  return runForStore(
    useBrowser,
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.refresh();
    }),
  );
}

/**
 * Asks the Mac for the calendar's access, and shows it. `active` is the asking owner: one that went while the Mac
 * was asking starts no read.
 */
export function connectCalendar(active: () => boolean = () => true): Promise<boolean> {
  if (hasServiceClient()) return active() ? requestService("calendarConnect", []) : Promise.resolve(false);

  return runForStore(
    useBrowser,
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      return yield* calendar.connect(active);
    }),
  );
}

/** Starts the refreshes: at the launch, when the calendar changes, and every few minutes. */
export function startCalendar(browser: BrowserStore = useBrowser): () => void {
  const existing = calendars.get(browser);

  if (existing) return existing;

  const forget = () => {
    if (calendars.get(browser) === once) calendars.delete(browser);
  };

  const stop = startStoreService(
    browser,
    "The calendar could not be watched",
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.start;
    }),
    Effect.gen(function* () {
      const calendar = yield* CalendarService;

      yield* calendar.stop;
    }),
    forget,
  );

  const once = () => {
    forget();
    stop();
  };

  calendars.set(browser, once);

  return once;
}

export const setCalendarHidden = (id: string, hidden: boolean) => {
  if (sendService("calendarHidden", [id, hidden])) return;
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
