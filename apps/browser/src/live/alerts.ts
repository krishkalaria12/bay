import { sendService } from "../runtime/serviceClient";
import { onAppEvent, onWindowEvent, postNotification, removeNotifications } from "@bay/shell";
import { create } from "zustand";
import { useBrowser, type BrowserStore } from "../store/browser";
import { browserRead } from "../store/read";
import { reportBrowserCommand } from "../runtime/commands";
import { useCalendar } from "./calendar";
import { joinMeeting } from "./meetingGroups";
import { ALERT_LEADS, dueAlerts, joinableMeeting, joinLink, joinTitle, relativeTime, type CalendarEvent } from "./meetings";
import { JOINABLE_BEFORE_MS } from "../components/live/constants";
import { createWindow as openWindow } from "../runtime/windowActions";
import { everySlowly } from "../lib/slowTimers";
import { dismissAlert, live } from "./store";

export const useMeetingAlert = create<{ event: CalendarEvent | null }>()(() => ({ event: null }));

let appActive = true;
const notified = new Set<string>();

export function alertEvent(now = Date.now()): CalendarEvent | null {
  const lead = ALERT_LEADS.find((l) => l.value === live().calendar.alertLead)?.minutes;
  if (lead === null || lead === undefined) return null;
  return dueAlerts(useCalendar.getState().events, now, lead, new Set(live().dismissedAlerts))[0] ?? null;
}

function check() {
  const event = alertEvent();
  const current = useMeetingAlert.getState().event;
  if (event?.occurrence !== current?.occurrence) useMeetingAlert.setState({ event });
  if (!event || appActive || live().calendar.alertCondition !== "always" || notified.has(event.occurrence)) return;
  notified.add(event.occurrence);
  const link = joinLink(event);
  const when = relativeTime(event.start, Date.now());
  void postNotification({
    id: `meeting:${event.occurrence}`,
    title: event.title || "Untitled event",
    body: `${when === "Now" ? "Starting now" : event.start < Date.now() ? `Started ${when}` : `Starts ${when}`}${link ? ` · ${joinTitle(link.provider)}` : ""}`,
    data: { meeting: event.occurrence },
  });
}

export function joinEvent(event: CalendarEvent, openAll = false, windowId = frontWindow()) {
  if (windowId && sendService("alertJoin", [windowId, event.occurrence, openAll])) return;
  const link = joinLink(event);
  if (!link || !windowId) return;
  reportBrowserCommand(joinMeeting(windowId, event, link.url, openAll));
  dismiss(event);
}

/** The meeting ⌃⌘J would join now (Join Meeting in the File menu), or null. */
export const meetingToJoin = (now = Date.now()) => joinableMeeting(useCalendar.getState().events, now, JOINABLE_BEFORE_MS);

/** ⌃⌘J: joins the meeting that's on now (or about to start) as the alert's Join does; false when none is. */
export function joinMeetingNow(): boolean {
  const event = meetingToJoin();
  if (!event) return false;
  const windowId = frontWindow();
  if (windowId) joinEvent(event, false, windowId);
  else reportBrowserCommand(openWindow().then((id) => joinEvent(event, false, id)));
  return true;
}

export function dismiss(event: CalendarEvent) {
  if (sendService("alertDismiss", [event.occurrence])) return;
  dismissAlert(event.occurrence);
  void removeNotifications([`meeting:${event.occurrence}`]);
  if (useMeetingAlert.getState().event?.occurrence === event.occurrence) useMeetingAlert.setState({ event: null });
  check();
}

const frontWindow = () => {
  const s = browserRead.getState();
  const id = s.ui.focusedWindowId;
  // A main window: a call doesn't open in a private window or Little Bay.
  const main = (w: string) => !s.windows[w]!.incognito && s.windows[w]!.kind !== "small";
  return id && s.windows[id] && main(id) ? id : s.windowOrder.find(main);
};

const running = new WeakMap<BrowserStore, () => void>();

export function startMeetingAlerts(browser: BrowserStore = useBrowser): () => void {
  const existing = running.get(browser);
  if (existing) return existing;
  let stopped = false;
  const cleanups: (() => void)[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    running.delete(browser);
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.warn("Couldn't stop meeting alert watcher", error);
      }
    }
  };
  running.set(browser, stop);
  try {
    const appEvents = onAppEvent((e) => {
      if (e.type === "resignActive") appActive = false;
    });
    cleanups.push(() => appEvents.remove());
    const windowEvents = onWindowEvent((e) => {
      if (e.type === "focus") appActive = true;
    });
    cleanups.push(() => windowEvents.remove());
    cleanups.push(useCalendar.subscribe((s, prev) => s.events !== prev.events && check()));
    cleanups.push(
      everySlowly({
        every: 10_000,
        run: check,
        needed: () => useCalendar.getState().events.length > 0 || !!useMeetingAlert.getState().event,
        watch: (changed) => {
          const calendar = useCalendar.subscribe(changed);
          const alert = useMeetingAlert.subscribe(changed);
          return () => {
            try {
              calendar();
            } finally {
              alert();
            }
          };
        },
      }),
    );
    check();
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
