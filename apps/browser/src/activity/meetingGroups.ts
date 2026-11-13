import { reportBrowserCommand } from "../runtime/commands";
import { hasServiceClient, requestService } from "../runtime/serviceClient";
import { confirm } from "@bay/desktop";
import { useBrowser, type BrowserState, type BrowserStore } from "../store/browserStore";
import { browserRead } from "../store/read";
import { changedIds } from "../store/recordDiff";
import { activeTabId, pinnedPage } from "../store/model";
import { groupOf } from "../store/tabTidying";
import { addTabsToGroup, closeGroup, createGroup } from "../runtime/organizeActions";
import { activate, newTab } from "../runtime/tabActions";
import { connectCalendar, useCalendar } from "./calendar";
import { eventForCall, isCalendarUrl, meetingOf, relatedLinks, type CalendarEvent } from "./meetings";
import { everySlowly } from "../lib/throttledTimers";
import { live, setMeetingGroup, updateCalendarSettings, useLive, type MeetingGroup } from "./activityStore";
import { MEETING_CLEANUP_IDLE_MS, MEETING_FALLBACK_TITLE } from "./constants";

/** Where a call's tab belongs: an existing group, or a new one to make. */
type MeetingTarget = { groupId: string; add: boolean } | { meeting: Omit<MeetingGroup, "groupId"> };

/** The group a call belongs in, in the store it is found in. */
function meetingTarget(
  s: Pick<import("../runtime/projection").BrowserProjection, "tabs" | "groups">,
  tabId: string,
  event?: CalendarEvent | null,
): MeetingTarget {
  const tab = s.tabs[tabId];
  const call = tab && meetingOf(tab.url);

  // A pinned page never joins a group, and a group command must create one.
  if (!tab || !call || pinnedPage(tab)) return { groupId: "", add: false };
  const current = groupOf(s, tabId);

  if (current) return { groupId: live().meetingGroups[current.id] ? current.id : "", add: false };
  const match = event ?? eventForCall(useCalendar.getState().events, tab.url, Date.now());

  const same = Object.values(live().meetingGroups).find((m) => {
    const g = s.groups[m.groupId];
    const callTab = s.tabs[m.callTabId];

    return (
      g &&
      g.spaceId === tab.spaceId &&
      !m.endedAt &&
      ((!!m.occurrence && m.occurrence === match?.occurrence) || (!!callTab && meetingOf(callTab.url)?.key === call.key))
    );
  });

  if (same) return { groupId: same.groupId, add: true };

  return {
    meeting: {
      callTabId: tabId,
      occurrence: match?.occurrence ?? null,
      title: match?.title || MEETING_FALLBACK_TITLE,
      start: match?.start ?? null,
      end: match?.end ?? null,
      endedAt: null,
    },
  };
}

export async function groupCall(tabId: string, event?: CalendarEvent | null): Promise<string> {
  if (hasServiceClient()) return requestService("meetingGroup", [tabId, event?.occurrence ?? null]);
  const target = meetingTarget(browserRead.getState(), tabId, event);

  if ("groupId" in target) {
    if (target.add) await addTabsToGroup(target.groupId, [tabId]);

    return target.groupId;
  }

  const groupId = await createGroup([tabId], { name: target.meeting.title });

  if (groupId) setMeetingGroup({ ...target.meeting, groupId });

  return groupId;
}

/**
 * Groups a call in a named store.
 *
 * The coordinator owns the store, so the grouping happens there: a window asks for it over the command transport
 * rather than grouping a tab in a store it does not own.
 */
export function groupCallInStore(browser: BrowserStore, tabId: string, event?: CalendarEvent | null): string {
  const target = meetingTarget(browser.getState(), tabId, event);

  if ("groupId" in target) {
    if (target.add) browser.getState().addTabsToGroup(target.groupId, [tabId]);

    return target.groupId;
  }

  const groupId = browser.getState().createGroup([tabId], { name: target.meeting.title });

  if (groupId) setMeetingGroup({ groupId, ...target.meeting });

  return groupId;
}

/** Joins a meeting in a named store: the call's tab, and the links that go with it. */
export function joinMeetingInStore(browser: BrowserStore, windowId: string, event: CalendarEvent, joinUrl: string, openAll = false) {
  const s = browser.getState();

  if (!s.windows[windowId] || s.windows[windowId]!.incognito) return;
  const callTab = s.newTab(windowId, { url: joinUrl });
  const grouped = s.settings.autoGroupMeetingTabs ? groupCallInStore(browser, callTab, event) : "";

  if (openAll)
    for (const url of relatedLinks(event)) {
      const id = browser.getState().newTab(windowId, { url, background: true, openerId: callTab });

      if (grouped && !groupOf(browser.getState(), id)) browser.getState().addTabsToGroup(grouped, [id]);
    }

  browser.getState().activate(callTab);
}

/**
 * Joins a meeting.
 *
 * The tabs are the coordinator's, so they are opened over the command transport: a window asks, and the
 * coordinator does it in the store it owns.
 */
export async function joinMeeting(windowId: string, event: CalendarEvent, joinUrl: string, openAll = false) {
  const s = browserRead.getState();

  if (!s.windows[windowId]) return;
  const callTab = await newTab(windowId, { url: joinUrl });
  const grouped = s.settings.autoGroupMeetingTabs ? await groupCall(callTab, event) : "";

  if (openAll) {
    for (const url of relatedLinks(event)) {
      const id = await newTab(windowId, { url, background: true, openerId: callTab });

      if (grouped && !groupOf(browserRead.getState(), id)) await addTabsToGroup(grouped, [id]);
    }
  }

  await activate(callTab);
}

const running = new WeakMap<BrowserStore, () => void>();

export function startMeetingGroups(browser: BrowserStore = useBrowser): () => void {
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
        console.warn("Couldn't stop meeting group watcher", error);
      }
    }
  };

  running.set(browser, stop);

  try {
    cleanups.push(
      browser.subscribe((s, prev) => {
        for (const id of changedIds(s.tabs, prev.tabs)) {
          const tab = s.tabs[id];

          if (!tab) continue;
          const before = prev.tabs[id];

          if (before && before.url === tab.url && before.pinned === tab.pinned) continue;

          if (s.settings.autoGroupMeetingTabs && !tab.pinned && meetingOf(tab.url) && (!before || !meetingOf(before.url))) groupCallInStore(browser, id);

          if (!before && tab.openerId && !groupOf(browser.getState(), id)) {
            const opener = groupOf(browser.getState(), tab.openerId);

            if (opener && live().meetingGroups[opener.id] && !live().meetingGroups[opener.id]!.endedAt) browser.getState().addTabsToGroup(opener.id, [id]);
          }

          if (tab.pinned && isCalendarUrl(tab.url) && (!before || !before.pinned) && !live().calendar.prompted) void offerAlerts(tab.windowId, () => !stopped);
        }
      }),
    );
    // The sweep for the groups that are ending: it runs on the app's shared grid, and stops with this watcher.
    cleanups.push(
      everySlowly({
        every: 30_000,
        run: () => tick(browser.getState(), Date.now(), browser),
        needed: () => Object.keys(live().meetingGroups).length > 0,
        watch: (changed) => useLive.subscribe((s, prev) => s.meetingGroups !== prev.meetingGroups && changed()),
      }),
    );
  } catch (error) {
    stop();
    throw error;
  }

  return stop;
}

async function offerAlerts(windowId: string, active: () => boolean) {
  updateCalendarSettings({ prompted: true });

  const { confirmed } = await confirm({
    title: "Would you like to see meeting alerts for this calendar?",
    message: "Bay can alert you when a new meeting is about to begin. You can hide these alerts or manage how close to a meeting start they show up.",
    confirmTitle: "Show Alerts",
    cancelTitle: "Don't Show These Alerts",
    windowId,
  });

  if (!active()) return;

  if (confirmed) await connectCalendar();
  else updateCalendarSettings({ alertLead: "never" });
}

export function tick(s: BrowserState, now: number, browser?: BrowserStore) {
  for (const m of Object.values(live().meetingGroups)) {
    const current = browser?.getState() ?? s;
    const g = current.groups[m.groupId];

    if (!g) {
      setMeetingGroup(null, m.groupId);
      continue;
    }

    if (!m.endedAt) {
      const callTab = current.tabs[m.callTabId];
      const leftCall = !callTab || !meetingOf(callTab.url);

      if ((m.end !== null && now >= m.end) || (m.end === null && leftCall)) setMeetingGroup({ ...m, endedAt: now });
      continue;
    }

    const shown = new Set(Object.keys(current.windows).map((w) => activeTabId(current, w, g.spaceId)));
    const busy = g.tabIds.some((id) => shown.has(id) || current.live[id]?.playingAudio);
    const lastUse = Math.max(m.endedAt, ...g.tabIds.map((id) => current.tabs[id]?.lastActiveAt ?? 0));

    if (!busy && now - lastUse >= MEETING_CLEANUP_IDLE_MS) {
      setMeetingGroup(null, m.groupId);

      if (browser) browser.getState().closeGroup(m.groupId);
      else reportBrowserCommand(closeGroup(m.groupId));
    }
  }
}
