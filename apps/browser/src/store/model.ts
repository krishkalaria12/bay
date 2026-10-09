import { appUrlOrigin, displayHost } from "@bay/core";
import type { BrowserState } from "./browser";
import { DEFAULT_SPACE_ID } from "./constants";
import type { BrowserWindow, Space, Tab, TabLive, TabSnapshot } from "./types";


const launch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let counter = 0;
export const newId = (prefix: string) => `${prefix}-${launch}-${(++counter).toString(36)}`;

let navSeq = 0;
export const navigationTo = (url: string, userInitiated = false) => ({ url, seq: ++navSeq, ...(userInitiated ? { userInitiated } : {}) });

export const incognitoSpaceId = (windowId: string) => `incognito:${windowId}`;
export const isIncognitoSpace = (spaceId: string) => spaceId.startsWith("incognito:");

let spaceProfiles: Record<string, string> = {};
export const setSpaceProfiles = (map: Record<string, string>) => {
  spaceProfiles = map;
};

export const engineProfile = (spaceId: string) => {
  const id = spaceProfiles[spaceId] ?? spaceId;
  return id === DEFAULT_SPACE_ID ? "" : id;
};

export const INCOGNITO_SPACE: Space = { id: "incognito", name: "Incognito", color: "neutral", icon: null, createdAt: 0 };

export const IDLE_LIVE: TabLive = {
  isLoading: false,
  progress: 0,
  canGoBack: false,
  canGoForward: false,
  playingAudio: false,
  themeColor: null,
};

export function makeTab(windowId: string, spaceId: string, url = "", snapshot?: Partial<TabSnapshot>): Tab {
  const now = Date.now();
  return {
    id: newId("tab"),
    windowId,
    spaceId,
    url,
    title: "",
    favicon: null,
    pinned: false,
    muted: false,
    zoom: 1,
    customTitle: null,
    customIcon: null,
    pinnedUrl: null,
    openerId: null,
    ...snapshot,
    navigation: url ? navigationTo(url) : null,
    createdAt: now,
    lastActiveAt: now,
  };
}

// What loads a tab that hasn't yet (lazy, opened behind, or sleeping): the browser it's to adopt, else its URL.
export function wake(t: Tab): Partial<Tab> {
  return t.wakeAdoptId ? { adoptId: t.wakeAdoptId, wakeAdoptId: undefined } : { navigation: navigationTo(t.url) };
}

export const snapshotTab = (t: Tab): TabSnapshot => ({
  url: t.url,
  title: t.title,
  favicon: t.favicon,
  pinned: t.pinned,
  muted: t.muted,
  zoom: t.zoom,
  customTitle: t.customTitle,
  customIcon: t.customIcon,
  pinnedUrl: t.pinnedUrl,
  spaceId: t.spaceId,
  ...(t.pinnedRow ? { pinnedRow: true } : {}),
});

/** A pinned page: an Essential (a pinned tile) or a pinned row. It keeps the page it was pinned at (`pinnedUrl`). */
export const pinnedPage = (t: Pick<Tab, "pinned" | "pinnedRow">) => t.pinned || !!t.pinnedRow;

/** The window's order keeps the Essentials first, then the pinned rows, then every other tab. */
export function pinnedFirst(ids: string[], tabs: Record<string, Tab>): string[] {
  const rank = (id: string) => {
    if (tabs[id]?.pinned) return 0;
    if (tabs[id]?.pinnedRow) return 1;
    return 2;
  };
  const out = [0, 1, 2].flatMap((r) => ids.filter((id) => rank(id) === r));
  return out.every((id, i) => id === ids[i]) ? ids : out;
}

export function inPinnedContainer(s: Pick<BrowserState, "tabs" | "groups">, id: string): boolean {
  const tab = s.tabs[id];
  if (!tab) return false;
  if (pinnedPage(tab)) return true;
  for (const g of Object.values(s.groups)) if (g.pinned && g.tabIds.includes(id)) return true;
  return false;
}

export function viewTabIds(s: BrowserState, windowId: string, spaceId?: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const profile = spaceId ?? w.spaceId;
  return w.tabIds.filter((id) => s.tabs[id]?.spaceId === profile);
}

/** Two spaces with the same profile (its data): as Arc, they share their favourites (the pinned tiles). */
export function sharesProfile(s: Pick<BrowserState, "spaces">, a: string, b: string): boolean {
  const pa = s.spaces[a];
  const pb = s.spaces[b];
  return !!pa && !!pb && (pa.profileId ?? pa.id) === (pb.profileId ?? pb.id);
}

/** A space's favourites: the window's pinned tiles of every space that shares its profile, in the window's order. */
export function favoriteTabIds(s: BrowserState, windowId: string, spaceId?: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const profile = spaceId ?? w.spaceId;
  return w.tabIds.filter((id) => {
    const t = s.tabs[id];
    return !!t?.pinned && (t.spaceId === profile || sharesProfile(s, t.spaceId, profile));
  });
}

export function closesWindow(s: BrowserState, id: string): boolean {
  const tab = s.tabs[id];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w || tab.spaceId !== w.spaceId || inPinnedContainer(s, id)) return false;
  return viewTabIds(s, w.id).every((t) => t === id || s.tabs[t]!.unloaded);
}

export function activeTabId(s: BrowserState, windowId: string, spaceId?: string): string | undefined {
  const w = s.windows[windowId];
  if (!w) return undefined;
  const id = w.activeTabIds[spaceId ?? w.spaceId];
  return id && s.tabs[id]?.windowId === windowId ? id : undefined;
}

export function activeTab(s: BrowserState, windowId: string): Tab | undefined {
  const id = activeTabId(s, windowId);
  return id ? s.tabs[id] : undefined;
}

export function spaceFor(s: BrowserState, spaceId: string): Space {
  return isIncognitoSpace(spaceId) ? INCOGNITO_SPACE : (s.spaces[spaceId] ?? s.spaces[s.settings.defaultSpaceId] ?? INCOGNITO_SPACE);
}

export function bookmarkSpaceId(s: BrowserState, window: BrowserWindow | undefined): string {
  return !window || window.incognito ? s.settings.defaultSpaceId : window.spaceId;
}

export function resolveWindowId(s: BrowserState, id?: string | null): string | undefined {
  if (id && s.windows[id]) return id;
  // Without a window named, never pick a Little Bay: it holds one page (store/small.ts).
  const main = (w: string) => !!s.windows[w] && s.windows[w]!.kind !== "small";
  return s.ui.focusOrder.find(main) ?? s.windowOrder.find(main);
}

export function merge<T extends object>(obj: T, patch: Partial<T>): T {
  for (const key in patch) {
    if (!Object.is(obj[key], patch[key])) return { ...obj, ...patch };
  }
  return obj;
}

export function without<T>(map: Record<string, T>, ids: Iterable<string>): Record<string, T> {
  const next = { ...map };
  for (const id of ids) delete next[id];
  return next;
}

export function tabLabel(t: Pick<Tab, "url" | "title" | "customTitle">): string {
  if (t.customTitle) return t.customTitle;
  if (!t.url) return "New Tab";
  const app = appUrlOrigin(t.url);
  if (app) return app;
  try {
    const u = new URL(t.url);
    if (u.protocol === "file:") return t.title || decodeURIComponent(u.pathname.split("/").pop() ?? "");
    return displayHost(u.hostname).replace(/^www\./, "") || t.title || t.url;
  } catch {
    return t.title || t.url;
  }
}

export function findLast<T>(list: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return list[i];
  return undefined;
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function windowTitle(s: BrowserState, windowId: string): string {
  const w = s.windows[windowId];
  if (!w) return "";
  const tab = activeTab(s, windowId);
  const others = viewTabIds(s, windowId).length - 1;
  const label = tab ? tabLabel(tab) : "New Tab";
  return `${spaceFor(s, w.spaceId).name} — ${label}${others > 0 ? ` & ${plural(others, "Tab")}` : ""}`;
}
