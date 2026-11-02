import * as alerts from "./meetingAlerts";
import * as calendar from "./calendar";
import * as engine from "./activityEngine";
import * as googleAuth from "./googleAuth";
import * as meetingGroups from "./meetingGroups";
import * as sources from "./sources";
import * as store from "./activityStore";

export function startLive() {
  engine.startLiveEngine();
  calendar.startCalendar();
  meetingGroups.startMeetingGroups();
  alerts.startMeetingAlerts();
  if (__DEV__) {
    const hover = require("../components/sidebar/hover") as typeof import("../components/sidebar/hover");
    const settings = require("../components/settings/windows") as typeof import("../components/settings/windows");
    (globalThis as { nnLive?: object }).nnLive = { alerts, calendar, engine, googleAuth, meetingGroups, sources, store, hover, settings };
  }
}
