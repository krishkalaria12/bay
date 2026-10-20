import * as cef from "@bay/nncore";
import { listExtensions } from "@bay/nncore";
import { confirm } from "@bay/shell";
import { pageToSpace } from "../components/layout/spacePager";
import { requestCreateSpace, type CreateSpacePreset } from "../components/spaces/CreateSpace";
import { useBrowser } from "../store/browser";
import { browserRead } from "../store/read";
import { dispatchBrowserCommand, reportBrowserCommand } from "../runtime/commands";
import * as windowActions from "../runtime/windowActions";
import { updateSettings } from "../runtime/settingsActions";
import type { UserCreateWindowOptions } from "../runtime/windowCommands";
import { closesWindow, isIncognitoSpace, resolveWindowId } from "../store/model";
import { engineIdOf } from "../store/spaces";
import { applyHeldReports } from "./nativeEvents";
import { webviews } from "./webviews";
import { closeWindowDialog } from "./windowClose";

const store = () => useBrowser.getState();

export function focus(windowId: string) {
  reportBrowserCommand(dispatchBrowserCommand({ method: "focusWindow", windowId }));
}

export function openWindow(options?: UserCreateWindowOptions, openPanel = false): Promise<string> {
  return windowActions.createWindow(options, openPanel);
}

/** Selection, ownership and native focus are decided together by the authority. */
export function switchToTab(tabId: string, windowId?: string): Promise<null> {
  return dispatchBrowserCommand({ method: "showTab", tabId, windowId });
}

export async function closeTab(tabId: string) {
  const s = browserRead.getState();
  const tab = s.tabs[tabId];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w) return;
  const last = closesWindow(s, tabId);
  if (last && s.settings.warnBeforeClosingLastTab && !w.incognito) {
    const { confirmed, suppressed } = await confirm({ ...closeWindowDialog(w.id), suppression: "Don’t ask me again", windowId: w.id });
    if (suppressed) await updateSettings({ warnBeforeClosingLastTab: false });
    if (!confirmed) return;
    // The page's last reports land before the tab closes (Reopen Closed Tab restores what it showed).
    applyHeldReports();
  }
  await dispatchBrowserCommand({ method: "closeTab", tabId });
}

export function toggleMute(tabId: string) {
  const tab = store().tabs[tabId];
  if (!tab) return;
  store().setSiteMuted(tabId, !tab.muted);
  void webviews.get(tabId)?.setMuted(!tab.muted);
}

export function createSpace(windowId?: string, preset?: CreateSpacePreset): Promise<string | null> {
  return requestCreateSpace(windowId, preset);
}

export async function deleteSpace(spaceId: string, windowId?: string) {
  const s = store();
  const profile = s.spaces[spaceId];
  if (!profile || s.spaceOrder.length <= 1) return;
  const { confirmed } = await confirm({
    title: `Delete “${profile.name}”?`,
    message: `Its tabs will be closed, and its cookies, passwords, extensions, bookmarks and history will be removed. This action cannot be undone.${engineIdOf(profile) === "" ? await keptExtensionsNote() : ""}`,
    confirmTitle: "Delete Space",
    destructive: true,
    windowId,
  });
  if (!confirmed) return;
  // The store queues its engine data for deletion (lib/profileData.ts).
  store().deleteSpace(spaceId);
}

// Chrome won't remove the original profile's extensions without asking, so they're only turned off
// (packages/nncore/ios/NNCoreProfileData.swift); say so.
async function keptExtensionsNote(): Promise<string> {
  const names = await listExtensions("").then(
    (list) => list.filter((e) => e.mayModify).map((e) => e.name),
    () => null,
  );
  if (names && !names.length) return "";
  return names ? ` Its extensions (${names.join(", ")}) stay installed on this Mac, turned off.` : " Its extensions stay installed on this Mac, turned off.";
}

export async function moveTabToSpace(tabId: string, target: string) {
  const tab = browserRead.getState().tabs[tabId];
  if (!tab || isIncognitoSpace(tab.spaceId)) return;
  const spaceId = target === "new" ? await createSpace(tab.windowId) : target;
  if (!spaceId || spaceId === tab.spaceId) return;
  if (browserRead.getState().settings.warnBeforeMovingTabsToSpace) {
    const { confirmed, suppressed } = await confirm({
      title: "Move Tab to Space?",
      message: "Each space has separate logins and site data. The tab will reload using the destination space's data.",
      confirmTitle: "Move Tab",
      suppression: "Don't warn me again",
      windowId: tab.windowId,
    });
    if (suppressed) await updateSettings({ warnBeforeMovingTabsToSpace: false });
    if (!confirmed) return;
  }
  await windowActions.moveTabToSpace(tabId, spaceId);
}

export async function moveTabToWindow(tabId: string, target: string) {
  const windowId = await windowActions.moveTabsToWindow([tabId], target === "new" ? null : target);
  if (windowId) focus(windowId);
}

export function switchSpace(windowId: string, spaceId: string, animated = false) {
  if (animated) pageToSpace(windowId, spaceId);
  else reportBrowserCommand(windowActions.switchSpace(windowId, spaceId));
}

export function cycleSpace(windowId: string, delta: 1 | -1) {
  if (!cycleTarget(windowId, delta)) return;
  // The native pager steps from its own selection, so rapid presses advance past a store that lags.
  void cef.stepPager(windowId, delta, true, store().spaceOrder.join("\n")).then((ok) => ok || cycleFromStore(windowId, delta));
}

function cycleFromStore(windowId: string, delta: 1 | -1) {
  const target = cycleTarget(windowId, delta);
  if (target) switchSpace(windowId, target, true);
}

function cycleTarget(windowId: string, delta: 1 | -1) {
  const s = store();
  const w = s.windows[windowId];
  if (!w || w.incognito || s.spaceOrder.length < 2) return null;
  const i = s.spaceOrder.indexOf(w.spaceId);
  return s.spaceOrder[(i + delta + s.spaceOrder.length) % s.spaceOrder.length]!;
}

export async function openUrls(urls: string[], windowId?: string | null) {
  let target = resolveWindowId(browserRead.getState(), windowId);
  for (const url of urls) {
    if (!target || browserRead.getState().windows[target]?.incognito) target = await openWindow({ url });
    else await dispatchBrowserCommand({ method: "newTab", windowId: target, options: { url } });
  }
}
