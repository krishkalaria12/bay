import type { BrowserCommand, MenuEntry } from "@bay/shell";
import { reportBrowserCommand } from "../../runtime/commands";
import { cleanUpTabs, returnToPinnedUrl } from "../../runtime/organizeActions";
import { closeTabs, updateTabDetails } from "../../runtime/tabActions";
import type { BrowserState } from "../../store/browser";
import { browserRead } from "../../store/read";
import { activeTabId, pinnedPage, plural } from "../../store/model";
import { awayFromPin, groupOf, selectedTabIds } from "../../store/organize";
import { newGroupWithSelection, openIconPicker, startRename } from "./actions";
import { closeAllTabs, tabsAround } from "./menus";
import { setSidebarUi } from "./state";
import { switcherStep } from "./switcher";
import { openNewTabPanel } from "../../lib/newTab";

export function runSidebarCommand(command: BrowserCommand, arg: string | null, windowId: string): boolean {
  const s = browserRead.getState();
  const tabId = activeTabId(s, windowId);
  switch (command) {
    case "newTabInGroup": {
      const group = groupOf(s, tabId);
      reportBrowserCommand(openNewTabPanel(windowId, group?.id));
      return true;
    }
    case "newGroupWithTabs":
      reportBrowserCommand(newGroupWithSelection(windowId));
      return true;
    case "cleanUpTabs":
      reportBrowserCommand(cleanUpTabs(windowId));
      return true;
    case "closeAllTabs":
      reportBrowserCommand(closeAllTabs(windowId));
      return true;
    case "searchTabs":
      setSidebarUi({ searchTabs: windowId, hover: null });
      return true;
    case "renameTab":
      if (tabId) void startRename(windowId, { kind: "tab", id: tabId });
      return true;
    case "changeTabIcon":
      if (tabId) void openIconPicker(windowId, { kind: "tab", id: tabId });
      return true;
    case "returnToPinnedUrl":
      if (tabId) reportBrowserCommand(returnToPinnedUrl(tabId));
      return true;
    case "keepTab": {
      const tab = tabId ? s.tabs[tabId] : undefined;
      if (tab && !pinnedPage(tab)) reportBrowserCommand(updateTabDetails(tab.id, { kept: !tab.kept }));
      return true;
    }
    case "closeOtherTabs": {
      const tab = tabId ? s.tabs[tabId] : undefined;
      if (tab) reportBrowserCommand(closeTabs(tabsAround(windowId, tab).others));
      return true;
    }
    case "tabSwitcher":
      switcherStep(windowId, arg === "backward");
      return true;
  }
  return false;
}

export const SIDEBAR_WINDOW_COMMANDS = [
  "newTabInGroup",
  "newGroupWithTabs",
  "cleanUpTabs",
  "searchTabs",
  "renameTab",
  "changeTabIcon",
  "returnToPinnedUrl",
  "tabSwitcher",
  "keepTab",
  "closeOtherTabs",
];

export function sidebarMenuState(s: BrowserState, windowId: string | undefined) {
  const disabled: string[] = [];
  const titles: Record<string, string> = {};
  const tab = windowId ? s.tabs[activeTabId(s, windowId) ?? ""] : undefined;
  if (!windowId) disabled.push(...SIDEBAR_WINDOW_COMMANDS);
  else {
    if (!tab || !awayFromPin(tab)) disabled.push("returnToPinnedUrl");
    if (!tab || pinnedPage(tab)) disabled.push("keepTab");
    if (tab?.kept) titles.keepTab = "Don’t Keep Tab";
    if (!tab || !tabsAround(windowId, tab).others.length) disabled.push("closeOtherTabs");
    const selected = selectedTabIds(s, windowId).filter((id) => s.tabs[id] && !pinnedPage(s.tabs[id]!));
    if (!selected.length) disabled.push("newGroupWithTabs");
    if (selected.length > 1) titles.newGroupWithTabs = `New Group with ${plural(selected.length, "Tab")}`;
  }
  const recentlyClosedGroups: MenuEntry[] = [...s.closedGroups]
    .reverse()
    .slice(0, 10)
    .map((c) => ({ id: c.id, title: `${c.group.name} (${plural(c.tabs.length, "Tab")})` }));
  return { disabled, titles, recentlyClosedGroups };
}
