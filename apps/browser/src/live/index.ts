import { capabilities } from "@bay/platform";
import * as alerts from "./alerts";
import * as calendar from "./calendar";
import * as engine from "./engine";
import * as googleAuth from "./googleAuth";
import * as meetingGroups from "./meetingGroups";
import * as sources from "./sources";
import * as store from "./store";
import { useBrowser, type BrowserStore } from "../store/browser";

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
    if (capabilities.calendar) {
      stops.push(calendar.startCalendar());
      stops.push(meetingGroups.startMeetingGroups(browser));
      stops.push(alerts.startMeetingAlerts(browser));
    }
    if (typeof __DEV__ !== "undefined" && __DEV__ && browser === useBrowser) {
      const hover = require("../components/sidebar/hover") as typeof import("../components/sidebar/hover");
      const settings = require("../components/settings/windows") as typeof import("../components/settings/windows");
      (globalThis as { nnLive?: object }).nnLive = { alerts, calendar, engine, googleAuth, meetingGroups, sources, store, hover, settings };
    }
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
