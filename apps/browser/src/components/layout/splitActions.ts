import { showMenu, type MenuItem } from "@bay/shell";
import { create } from "zustand";
import { closeTab } from "../../lib/actions";
import { reportBrowserCommand } from "../../runtime/commands";
import * as commands from "../../runtime/splitActions";
import type { UserPaneOptions } from "../../runtime/splitCommands";
import { navigate } from "../../runtime/tabActions";
import { useBrowser as legacyBrowser } from "../../store/browser";
import { activeTabId } from "../../store/model";
import { browserRead } from "../../store/read";
import { slotsOf, splitOf, type OpenPaneOptions, type SplitSide } from "../../store/splits";
import { MAX_SPLIT_PANES } from "../../store/constants";
import { openNewTabPanel } from "../../lib/newTab";
import { pageFactsInCoordinator } from "../../lib/pageFactOwnership";

const store = () => browserRead.getState();

type Toast = { id: number; title: string; message?: string } & ToastOptions;
export type ToastOptions = { icon?: string; action?: { title: string; run(): void }; key?: string; sticky?: boolean };
export const useToasts = create<{ toasts: Record<string, Toast | null> }>()(() => ({ toasts: {} }));
let toastSeq = 0;
export function showToast(windowId: string, title: string, message?: string, options?: ToastOptions) {
  useToasts.setState((s) => {
    const current = s.toasts[windowId];
    const id = options?.key && current?.key === options.key ? current.id : ++toastSeq;
    return { toasts: { ...s.toasts, [windowId]: { id, title, message, ...options } } };
  });
}
export function hideToast(windowId: string, id: number) {
  useToasts.setState((s) => (s.toasts[windowId]?.id === id ? { toasts: { ...s.toasts, [windowId]: null } } : s));
}
export function hideKeyedToast(windowId: string, key: string) {
  useToasts.setState((s) => (s.toasts[windowId]?.key === key ? { toasts: { ...s.toasts, [windowId]: null } } : s));
}

const maxedOut = (windowId: string) => showToast(windowId, "Cannot Add New Pane", `Split View can show up to ${MAX_SPLIT_PANES} tabs at once.`);

// The command returns no pane for a full split or for a bad target; only the full split gets a toast.
async function openPane(windowId: string, options: UserPaneOptions): Promise<{ tabId: string | null; full: boolean }> {
  const anchorTabId = options.anchorTabId ?? activeTabId(store(), windowId);
  const tabId = await commands.openSplitPane(windowId, options);
  const full = !tabId && !!splitOf(store(), anchorTabId);
  if (full) maxedOut(windowId);
  return { tabId, full };
}

export async function openSplitPane(windowId: string, options: UserPaneOptions = {}): Promise<string | null> {
  return (await openPane(windowId, options)).tabId;
}

// `adoptId`: the tab Chrome already made for the link, adopted by this window's store until page handoff moves
// to the coordinator.
function openAdoptedPane(windowId: string, options: OpenPaneOptions) {
  const result = legacyBrowser.getState().openSplitPane(windowId, options);
  if (!result.ok && result.reason === "max") maxedOut(windowId);
}

export const openNewTabInSplit = (windowId: string) => reportBrowserCommand(openSplitPane(windowId));

/** The sidebar's + › Split View: a new pane beside the window's tab, or with no tab to split, just a new tab. */
export function splitWithCurrentTab(windowId: string) {
  reportBrowserCommand(
    openPane(windowId, {}).then(({ tabId, full }) => {
      if (!tabId && !full) return openNewTabPanel(windowId);
    }),
  );
}

export function openInSplit(tabId: string, side: SplitSide = "right") {
  const tab = store().tabs[tabId];
  if (!tab) return;
  const active = activeTabId(store(), tab.windowId);
  if (!active || active === tabId) return;
  reportBrowserCommand(openSplitPane(tab.windowId, { tabId, anchorTabId: active, side }));
}

export function openLinkInSplit(sourceTabId: string, url: string, adoptId?: string) {
  if (adoptId && pageFactsInCoordinator()) return;
  const s = store();
  const source = s.tabs[sourceTabId];
  if (!source) return;
  const split = splitOf(s, sourceTabId);
  const next = split?.tabIds[split.tabIds.indexOf(sourceTabId) + 1];
  if (split && (next || split.tabIds.length >= MAX_SPLIT_PANES)) {
    const target = next ?? split.tabIds.at(-1)!;
    if (target !== sourceTabId) {
      if (!adoptId) return reportBrowserCommand(navigate(target, url));
      const before = activeTabId(s, source.windowId);
      const owner = legacyBrowser.getState();
      const id = owner.newTab(source.windowId, { url, adoptId, spaceId: source.spaceId, openerId: sourceTabId, background: true });
      legacyBrowser.getState().replaceSplitPane(target, id);
      if (before && before !== target) legacyBrowser.getState().activate(before);
      return;
    }
  }
  const options = { anchorTabId: sourceTabId, url, side: "right", background: true } as const;
  if (adoptId) openAdoptedPane(source.windowId, { ...options, adoptId });
  else reportBrowserCommand(openSplitPane(source.windowId, options));
}

export function openPageInSplit(windowId: string, url: string, adoptId?: string) {
  if (adoptId && pageFactsInCoordinator()) return;
  if (adoptId) openAdoptedPane(windowId, { url, adoptId });
  else reportBrowserCommand(openSplitPane(windowId, { url }));
}

export function dropTabIntoSplit(tabId: string, targetTabId: string, side: SplitSide) {
  const target = store().tabs[targetTabId];
  if (!target || tabId === targetTabId) return;
  reportBrowserCommand(openSplitPane(target.windowId, { tabId, anchorTabId: targetTabId, side }));
}

export function closePane(tabId: string) {
  void closeTab(tabId);
}

export async function showSplitMenu(tabId: string) {
  const s = store();
  const split = splitOf(s, tabId);
  const tab = s.tabs[tabId];
  if (!split || !tab) return;
  const horizontal = split.orientation === "horizontal";
  const index = split.tabIds.indexOf(tabId);
  const full = split.tabIds.length >= MAX_SPLIT_PANES;
  const stacked = slotsOf(split).some((slot) => slot.length === 2 && slot.includes(tabId));
  const items: MenuItem[] = [
    {
      id: "add",
      title: horizontal ? "Add Vertical Split View" : "Add Horizontal Split View",
      symbol: horizontal ? "rectangle.split.2x1" : "rectangle.split.1x2",
      enabled: !full,
      key: "=",
      modifiers: ["control", "shift"],
    },
    {
      id: "bottom",
      title: horizontal ? "Add Bottom Split" : "Add Right Split",
      symbol: horizontal ? "rectangle.bottomhalf.inset.filled" : "rectangle.righthalf.inset.filled",
      enabled: !full && !stacked,
    },
    { separator: true },
    { id: "left", title: horizontal ? "Move Pane Left" : "Move Pane Up", symbol: "rectangle.lefthalf.inset.filled.arrow.left", enabled: index > 0 },
    {
      id: "right",
      title: horizontal ? "Move Pane Right" : "Move Pane Down",
      symbol: "rectangle.righthalf.inset.filled.arrow.right",
      enabled: index < split.tabIds.length - 1,
    },
    { id: "flip", title: "Flip Split View", symbol: horizontal ? "arrow.left.arrow.right" : "arrow.up.arrow.down" },
    {
      id: "convert",
      title: horizontal ? "Convert to Vertical Split View" : "Convert to Horizontal Split View",
      symbol: horizontal ? "rectangle.split.1x2" : "rectangle.split.2x1",
    },
    { separator: true },
    { id: "remove", title: "Remove from Split View", symbol: "rectangle.portrait.and.arrow.right" },
    { id: "separate", title: "Separate All Tabs", symbol: "rectangle.split.3x1" },
    { separator: true },
    { id: "close", title: "Close Pane", symbol: "xmark" },
  ];
  const choice = await showMenu(items);
  switch (choice) {
    case "add":
      return reportBrowserCommand(openSplitPane(tab.windowId, { anchorTabId: tabId, side: horizontal ? "right" : "bottom" }));
    case "bottom":
      return reportBrowserCommand(openSplitPane(tab.windowId, { anchorTabId: tabId, side: horizontal ? "bottom" : "right" }));
    case "left":
      return reportBrowserCommand(commands.movePane(tabId, -1));
    case "right":
      return reportBrowserCommand(commands.movePane(tabId, 1));
    case "flip":
      return reportBrowserCommand(commands.flipSplit(split.id));
    case "convert":
      return reportBrowserCommand(commands.toggleSplitOrientation(split.id));
    case "remove":
      return reportBrowserCommand(commands.removeTabFromSplit(tabId));
    case "separate":
      return reportBrowserCommand(commands.separateSplit(split.id));
    case "close":
      return closePane(tabId);
  }
}
