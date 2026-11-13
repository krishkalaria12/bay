import { capabilities } from "@bay/platform";
import { useBrowser, type BrowserStore } from "../store/browserStore";
import * as alerts from "./meetingAlerts";
import * as calendar from "./calendar";
import * as engine from "./activityEngine";
import * as googleAuth from "./googleAuth";
import * as meetingGroups from "./meetingGroups";
import * as sources from "./sources";
import * as store from "./activityStore";

/**
 * Starts the live folders' engine and, where the platform has a calendar, the calendar, the meeting groups and the
 * alerts. A start that fails part way stops what it had started, and the stop is idempotent.
 */
export function startLive(browser: BrowserStore = useBrowser): () => void {
  const stops: (() => void)[] = [];
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;

    for (const remove of stops.reverse()) {
      try {
        remove();
      } catch (error) {
        console.error("[runtime] live service cleanup failed", error);
      }
    }
  };

  try {
    stops.push(engine.startLiveEngine(browser));

    // The calendar is EventKit's: a platform without it has no calendar to read, no meetings to group and no alerts.
    if (capabilities.calendar) {
      stops.push(calendar.startCalendar(browser));
      stops.push(meetingGroups.startMeetingGroups(browser));
      stops.push(alerts.startMeetingAlerts(browser));
    }

    if (__DEV__ && browser === useBrowser) {
      // SAFETY: typeof import( assertion matches the runtime value validated at this call site.
      const hover = require("../components/sidebar/hover") as typeof import("../components/sidebar/hover");
      // SAFETY: typeof import( assertion matches the runtime value validated at this call site.
      const settings = require("../components/settings/windows") as typeof import("../components/settings/windows");
      // SAFETY: { nnLive? assertion matches the runtime value validated at this call site.
      (globalThis as { nnLive?: object }).nnLive = { alerts, calendar, engine, googleAuth, meetingGroups, sources, store, hover, settings };
    }
  } catch (error) {
    stop();
    throw error;
  }

  return stop;
}
