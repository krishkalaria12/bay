import * as cef from "@bay/nncore";
import { listExtensions } from "@bay/nncore";
import { confirm, focusWindow } from "@bay/shell";
import { pageToSpace } from "../components/layout/spacePager";
import { profileNames, requestCreateSpace, type CreateSpacePreset } from "../components/spaces/CreateSpace";
import { useBrowser, type CreateWindowOptions } from "../store/browser";
import { closesWindow, engineProfile, isIncognitoSpace, resolveWindowId } from "../store/model";
import { engineIdOf, sharingSpaces } from "../store/spaces";
import { applyHeldReports } from "./nativeEvents";
import { webviews } from "./webviews";
import { closeWindowDialog } from "./windowClose";

const store = () => useBrowser.getState();

export function focus(windowId: string) {
  store().setFocusedWindow(windowId);
  void focusWindow(windowId);
}

export function openWindow(options?: CreateWindowOptions): string {
  return store().createWindow(options);
}

export function switchToTab(tabId: string) {
  const tab = store().tabs[tabId];
  if (!tab) return;
  store().activate(tabId);
  if (tab.windowId !== store().ui.focusedWindowId) focus(tab.windowId);
}

export async function closeTab(tabId: string) {
  const s = store();
  const tab = s.tabs[tabId];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w) return;
  const last = closesWindow(s, tabId);
  if (last && s.settings.warnBeforeClosingLastTab && !w.incognito) {
    const { confirmed, suppressed } = await confirm({ ...closeWindowDialog(w.id), suppression: "Don’t ask me again", windowId: w.id });
    if (suppressed) store().updateSettings({ warnBeforeClosingLastTab: false });
    if (!confirmed) return;
    // The page's last reports land before the tab closes (Reopen Closed Tab restores what it showed).
    applyHeldReports();
  }
  store().closeTab(tabId);
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
  const sharing = sharingSpaces(s, spaceId).map((id) => s.spaces[id]!.name);
  const { confirmed } = await confirm({
    title: `Delete “${profile.name}”?`,
    message: sharing.length
      ? `Its tabs will be closed. Its cookies, passwords, extensions, bookmarks and history stay with ${profileNames(sharing)}, which share them.`
      : `Its tabs will be closed, and its profile and all its data (cookies, passwords, extensions, bookmarks and history) will be removed. This action cannot be undone.${engineIdOf(profile) === "" ? await keptExtensionsNote() : ""}`,
    confirmTitle: "Delete Space",
    destructive: true,
    windowId,
  });
  if (!confirmed) return;
  // The store queues its engine data for deletion (lib/profileData.ts).
  store().deleteSpace(spaceId);
}

/** As Arc's Change Profile: the space uses `shareWith`'s profile, or a new one of its own (null). Its tabs reload. */
export async function changeSpaceProfile(spaceId: string, shareWith: string | null, windowId?: string) {
  const s = store();
  const profile = s.spaces[spaceId];
  const target = shareWith ? s.spaces[shareWith] : undefined;
  if (!profile || (shareWith && !target)) return;
  const sharing = sharingSpaces(s, spaceId);
  // Already so: the target's profile is its own, or it has a profile to itself.
  const unchanged = target ? target.id === spaceId || sharing.includes(target.id) : !sharing.length;
  if (unchanged) return;
  const names = target ? [target.id, ...sharingSpaces(s, target.id)].map((id) => s.spaces[id]!.name) : [];
  const uses = target ? `the profile it shares with ${profileNames(names)}` : "a new profile";
  const { confirmed } = await confirm({
    title: `Change “${profile.name}”'s Profile?`,
    message: sharing.length
      ? `Its tabs will reload in ${uses}, with that profile's logins, cookies, extensions, bookmarks and history. Its current profile stays with ${profileNames(sharing.map((id) => s.spaces[id]!.name))}.`
      : `Its tabs will reload in ${uses}, with that profile's logins, cookies, extensions, bookmarks and history. Its current profile and all its data (cookies, passwords, extensions, bookmarks and history) will be removed. This action cannot be undone.${engineIdOf(profile) === "" ? await keptExtensionsNote() : ""}`,
    confirmTitle: "Change Profile",
    destructive: !sharing.length,
    windowId,
  });
  if (!confirmed) return;
  // A profile no space uses any more is queued for deletion (lib/profileData.ts).
  store().setSpaceProfile(spaceId, shareWith);
}

// Chrome won't remove the original profile's extensions without asking, so they're only turned off
// (packages/nncore/ios/NNCoreProfileData.swift); say so.
async function keptExtensionsNote(): Promise<string> {
  const names = await listExtensions("").then(
    (list) => list.filter((e) => e.mayModify).map((e) => e.name),
    () => null,
  );
  if (names && !names.length) return "";
  return names ? ` Its extensions (${profileNames(names)}) stay installed on this Mac, turned off.` : " Its extensions stay installed on this Mac, turned off.";
}

export async function moveTabToSpace(tabId: string, target: string) {
  const tab = store().tabs[tabId];
  if (!tab || isIncognitoSpace(tab.spaceId)) return;
  const spaceId = target === "new" ? await createSpace(tab.windowId) : target;
  if (!spaceId || spaceId === tab.spaceId) return;
  const shared = engineProfile(spaceId) === engineProfile(tab.spaceId);
  if (store().settings.warnBeforeMovingTabsToSpace && !shared) {
    const { confirmed, suppressed } = await confirm({
      title: "Move Tab to Space?",
      message: "This space uses a different profile, so some of the tab's site data could be lost.",
      confirmTitle: "Move Tab",
      suppression: "Don't warn me again",
      windowId: tab.windowId,
    });
    if (suppressed) store().updateSettings({ warnBeforeMovingTabsToSpace: false });
    if (!confirmed) return;
  }
  store().moveTabToSpace(tabId, spaceId);
}

export function moveTabToWindow(tabId: string, target: string) {
  const windowId = store().moveTabsToWindow([tabId], target === "new" ? null : target);
  if (windowId) focus(windowId);
}

export function switchSpace(windowId: string, spaceId: string, animated = false) {
  if (animated) pageToSpace(windowId, spaceId);
  else store().switchSpace(windowId, spaceId);
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

export function openUrls(urls: string[], windowId?: string | null) {
  let target = resolveWindowId(store(), windowId);
  for (const url of urls) {
    if (!target || store().windows[target]?.incognito) target = openWindow({ url });
    else store().newTab(target, { url });
  }
}
