import { useBrowser, type BrowserStore } from "../store/browserStore";
import * as alerts from "./meetingAlerts";
import * as calendar from "./calendar";
import * as engine from "./activityEngine";
import * as meetingGroups from "./meetingGroups";
import * as sources from "./sources";
import * as store from "./activityStore";

export function startLive(browser: BrowserStore = useBrowser): () => void {
  const stopEngine = engine.startLiveEngine(browser);
  const stopCalendar = calendar.startCalendar(browser);
  const stopGroups = meetingGroups.startMeetingGroups(browser);
  const stopAlerts = alerts.startMeetingAlerts(browser);

  if (__DEV__) {
    // SAFETY: typeof import( assertion matches the runtime value validated at this call site.
    const hover = require("../components/sidebar/hover") as typeof import("../components/sidebar/hover");
    // SAFETY: typeof import( assertion matches the runtime value validated at this call site.
    const settings = require("../components/settings/windows") as typeof import("../components/settings/windows");
    // SAFETY: { nnLive? assertion matches the runtime value validated at this call site.
    (globalThis as { nnLive?: object }).nnLive = { alerts, calendar, engine, meetingGroups, sources, store, hover, settings };
  }

  return () => {
    stopAlerts();
    stopGroups();
    stopCalendar();
    stopEngine();
  };
}
