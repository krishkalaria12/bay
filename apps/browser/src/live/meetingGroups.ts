import { confirm } from "@bay/shell";
import { reportBrowserCommand } from "../runtime/commands";
import { addTabsToGroup, closeGroup, createGroup } from "../runtime/organizeActions";
import { activate, newTab } from "../runtime/tabActions";
import { browserRead } from "../store/read";
import { useBrowser, type BrowserState } from "../store/browser";
import { changedIds } from "../store/changes";
import { activeTabId, pinnedPage } from "../store/model";
import { groupOf } from "../store/organize";
import { connectCalendar, useCalendar } from "./calendar";
import { eventForCall, isCalendarUrl, meetingOf, relatedLinks, type CalendarEvent } from "./meetings";
import { live, setMeetingGroup, updateCalendarSettings } from "./store";
import { MEETING_CLEANUP_IDLE_MS, MEETING_FALLBACK_TITLE } from "./constants";

const store = () => useBrowser.getState();

export async function groupCall(tabId: string, event?: CalendarEvent | null): Promise<string> {
  const s = browserRead.getState();
  const tab = s.tabs[tabId];
  const call = tab && meetingOf(tab.url);
  // A pinned page never joins a group, and a group command must create one.
  if (!tab || !call || pinnedPage(tab)) return "";
  const current = groupOf(s, tabId);
  if (current) return live().meetingGroups[current.id] ? current.id : "";
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
  if (same) {
    await addTabsToGroup(same.groupId, [tabId]);
    return same.groupId;
  }
  const title = match?.title || MEETING_FALLBACK_TITLE;
  const groupId = await createGroup([tabId], { name: title });
  setMeetingGroup({
    groupId,
    callTabId: tabId,
    occurrence: match?.occurrence ?? null,
    title,
    start: match?.start ?? null,
    end: match?.end ?? null,
    endedAt: null,
  });
  return groupId;
}

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

let started = false;

export function startMeetingGroups() {
  if (started) return;
  started = true;

  useBrowser.subscribe((s, prev) => {
    for (const id of changedIds(s.tabs, prev.tabs)) {
      const tab = s.tabs[id];
      if (!tab) continue;
      const before = prev.tabs[id];
      if (before && before.url === tab.url && before.pinned === tab.pinned) continue;
      if (s.settings.autoGroupMeetingTabs && !tab.pinned && meetingOf(tab.url) && (!before || !meetingOf(before.url))) reportBrowserCommand(groupCall(id));
      if (!before && tab.openerId && !groupOf(s, id)) {
        const opener = groupOf(s, tab.openerId);
        if (opener && live().meetingGroups[opener.id] && !live().meetingGroups[opener.id]!.endedAt) reportBrowserCommand(addTabsToGroup(opener.id, [id]));
      }
      if (tab.pinned && isCalendarUrl(tab.url) && (!before || !before.pinned) && !live().calendar.prompted) void offerAlerts(tab.windowId);
    }
  });

  setInterval(() => tick(store(), Date.now()), 20_000);
}

async function offerAlerts(windowId: string) {
  updateCalendarSettings({ prompted: true });
  const { confirmed } = await confirm({
    title: "Would you like to see meeting alerts for this calendar?",
    message: "Bay can alert you when a new meeting is about to begin. You can hide these alerts or manage how close to a meeting start they show up.",
    confirmTitle: "Show Alerts",
    cancelTitle: "Don't Show These Alerts",
    windowId,
  });
  if (confirmed) await connectCalendar();
  else updateCalendarSettings({ alertLead: "never" });
}

export function tick(s: BrowserState, now: number) {
  for (const m of Object.values(live().meetingGroups)) {
    const g = s.groups[m.groupId];
    if (!g) {
      setMeetingGroup(null, m.groupId);
      continue;
    }
    if (!m.endedAt) {
      const callTab = s.tabs[m.callTabId];
      const leftCall = !callTab || !meetingOf(callTab.url);
      if ((m.end !== null && now >= m.end) || (m.end === null && leftCall)) setMeetingGroup({ ...m, endedAt: now });
      continue;
    }
    const shown = new Set(Object.keys(s.windows).map((w) => activeTabId(s, w, g.spaceId)));
    const busy = g.tabIds.some((id) => shown.has(id) || s.live[id]?.playingAudio);
    const lastUse = Math.max(m.endedAt, ...g.tabIds.map((id) => s.tabs[id]?.lastActiveAt ?? 0));
    if (!busy && now - lastUse >= MEETING_CLEANUP_IDLE_MS) {
      setMeetingGroup(null, m.groupId);
      reportBrowserCommand(closeGroup(m.groupId));
    }
  }
}
