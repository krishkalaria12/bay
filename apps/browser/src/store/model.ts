import { appUrlOrigin, displayHost } from "@bay/core";
import type { BrowserState } from "./browser";
import type { DeepReadonly } from "../runtime/projection";
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

/** A space's engine profile from the given spaces, for stores other than the app's own (runtime/authority.ts). */
export const engineProfileFor = (spaceId: string, spaces: Readonly<Record<string, Pick<Space, "profileId">>>) => {
  const id = spaces[spaceId]?.profileId || spaceId;
  return id === DEFAULT_SPACE_ID ? "" : id;
};

type ReadonlyModelState = DeepReadonly<Pick<BrowserState, "spaces" | "windows" | "tabs" | "groups" | "tabLists" | "ui" | "windowOrder" | "settings">>;

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
  ...(t.engine ? { engine: t.engine } : {}),
});

/** A pinned page: an Essential (a pinned tile) or a pinned row. It keeps the page it was pinned at (`pinnedUrl`). */
export const pinnedPage = (t: Pick<Tab, "pinned" | "pinnedRow">) => t.pinned || !!t.pinnedRow;

/** A list's order keeps the Essentials first, then the pinned rows, then every other tab. */
export function pinnedFirst(ids: string[], tabs: Record<string, Tab>): string[] {
  const rank = (id: string) => {
    if (tabs[id]?.pinned) return 0;
    if (tabs[id]?.pinnedRow) return 1;
    return 2;
  };
  const out = [0, 1, 2].flatMap((r) => ids.filter((id) => rank(id) === r));
  return out.every((id, i) => id === ids[i]) ? ids : out;
}

export function inPinnedContainer(s: Pick<BrowserState, "tabs" | "groups"> | Pick<ReadonlyModelState, "tabs" | "groups">, id: string): boolean {
  const tab = s.tabs[id];
  if (!tab) return false;
  if (pinnedPage(tab)) return true;
  for (const g of Object.values(s.groups)) if (g.pinned && g.tabIds.includes(id)) return true;
  return false;
}

// MARK: Tab lists

// Every window on a space lists that space's tabs. Private windows and Little Bay keep their own lists.
export const spaceListKey = (_s: Pick<BrowserState, "spaces"> | Pick<ReadonlyModelState, "spaces">, spaceId: string) => spaceId;

/** The list a window shows: its space's, or a Little Bay's own. */
export const windowListKey = (s: Pick<BrowserState, "spaces"> | Pick<ReadonlyModelState, "spaces">, w: BrowserWindow | DeepReadonly<BrowserWindow>) =>
  w.kind === "small" ? w.id : spaceListKey(s, w.spaceId);

/** The list the tab is in. */
export const tabListKey = (s: Pick<ReadonlyModelState, "spaces" | "windows">, t: DeepReadonly<Tab>) =>
  s.windows[t.windowId]?.kind === "small" ? t.windowId : spaceListKey(s, t.spaceId);

const NO_TABS: string[] = [];
export function listIds(s: Pick<BrowserState, "tabLists">, key: string): string[];
export function listIds(s: Pick<ReadonlyModelState, "tabLists">, key: string): readonly string[];
export function listIds(s: Pick<BrowserState, "tabLists"> | Pick<ReadonlyModelState, "tabLists">, key: string): readonly string[] {
  return s.tabLists[key] ?? NO_TABS;
}

/** The list the tab is in, by key and ids. */
export function listOfTab(s: Pick<BrowserState, "spaces" | "windows" | "tabs" | "tabLists">, id: string): TabList | undefined;
export function listOfTab(s: Pick<ReadonlyModelState, "spaces" | "windows" | "tabs" | "tabLists">, id: string): DeepReadonly<TabList> | undefined;
export function listOfTab(s: Pick<ReadonlyModelState, "spaces" | "windows" | "tabs" | "tabLists">, id: string): DeepReadonly<TabList> | undefined {
  const t = s.tabs[id];
  if (!t) return undefined;
  const key = tabListKey(s, t);
  return { key, tabIds: listIds(s, key) };
}

export type TabList = { key: string; tabIds: string[] };

/** The state with the list's ids; an empty list goes. */
export function withList<S extends Pick<BrowserState, "tabLists">>(s: S, list: TabList): S {
  if (s.tabLists[list.key] === list.tabIds) return s;
  return { ...s, tabLists: list.tabIds.length ? { ...s.tabLists, [list.key]: list.tabIds } : without(s.tabLists, [list.key]) };
}

/** The tabs the window lists for a space (its shown one by default), in the list's order. */
export function viewTabIds(s: ReadonlyModelState, windowId: string, spaceId?: string): string[] {
  const w = s.windows[windowId];
  if (!w) return [];
  const space = w.kind === "small" ? w.spaceId : (spaceId ?? w.spaceId);
  const key = w.kind === "small" ? w.id : spaceListKey(s, space);
  return listIds(s, key).filter((id) => s.tabs[id]?.spaceId === space);
}

/** A space's tabs, in their list's order. */
export const spaceTabIds = (s: Pick<ReadonlyModelState, "spaces" | "tabs" | "tabLists">, spaceId: string): string[] =>
  listIds(s, spaceListKey(s, spaceId)).filter((id) => s.tabs[id]?.spaceId === spaceId);

/** Whether another window shows the tab now. */
export const shownElsewhere = (s: ReadonlyModelState, id: string, windowId: string) =>
  Object.values(s.windows).some((w) => w.id !== windowId && w.activeTabIds[w.spaceId] === id);

/** The tab a window shows for a space it comes to: the one it showed there, else the space's most recent one, unless
 *  another window shows it now. None: the window takes a new tab. */
export function tabToShow(s: ReadonlyModelState, windowId: string, spaceId: string): string | undefined {
  const w = s.windows[windowId];
  const view = viewTabIds(s, windowId, spaceId).filter((id) => !shownElsewhere(s, id, windowId));
  const remembered = w?.activeTabIds[spaceId];
  if (remembered && view.includes(remembered)) return remembered;
  return view.reduce<string | undefined>((best, id) => (!best || s.tabs[id]!.lastActiveAt > s.tabs[best]!.lastActiveAt ? id : best), undefined);
}

/** A blank tab the window can show for a space (settings.launchTab), so launches don't pile up new tabs. None: the
 *  window takes a new tab. */
export function blankTabToShow(s: ReadonlyModelState, windowId: string, spaceId: string): string | undefined {
  return viewTabIds(s, windowId, spaceId).find((id) => !s.tabs[id]!.url && !inPinnedContainer(s, id) && !shownElsewhere(s, id, windowId));
}

/** The tabs whose page is in the window, in their lists' order. */
export function windowTabIds(s: Pick<ReadonlyModelState, "tabs" | "tabLists">, windowId: string): string[] {
  const out: string[] = [];
  for (const ids of Object.values(s.tabLists)) for (const id of ids) if (s.tabs[id]?.windowId === windowId) out.push(id);
  return out;
}

/** Spaces have separate native profiles, including their pinned tiles. */
export function sharesProfile(s: Pick<BrowserState, "spaces">, a: string, b: string): boolean {
  return a === b && !!s.spaces[a];
}

/** A space's pinned tiles, in their list's order. */
export function favoriteTabIds(s: ReadonlyModelState, windowId: string, spaceId?: string): string[] {
  const w = s.windows[windowId];
  if (!w || w.kind === "small") return [];
  const space = spaceId ?? w.spaceId;
  return listIds(s, spaceListKey(s, space)).filter((id) => s.tabs[id]?.spaceId === space && s.tabs[id]?.pinned);
}

export function closesWindow(s: ReadonlyModelState, id: string): boolean {
  const tab = s.tabs[id];
  const w = tab && s.windows[tab.windowId];
  if (!tab || !w || tab.spaceId !== w.spaceId || inPinnedContainer(s, id)) return false;
  return viewTabIds(s, w.id).every((t) => t === id || s.tabs[t]!.unloaded);
}

type ActiveTabState = {
  readonly windows: Readonly<
    Record<
      string,
      {
        readonly kind?: "small";
        readonly spaceId: string;
        readonly activeTabIds: Readonly<Record<string, string>>;
      }
    >
  >;
  readonly tabs: Readonly<Record<string, { readonly windowId: string; readonly spaceId: string }>>;
};

/** The tab the window shows for a space (its shown one by default). */
export function activeTabId(s: ActiveTabState, windowId: string, spaceId?: string): string | undefined {
  const w = s.windows[windowId];
  if (!w) return undefined;
  const space = spaceId ?? w.spaceId;
  const id = w.activeTabIds[space];
  const t = id ? s.tabs[id] : undefined;
  return t && (w.kind === "small" ? t.windowId === windowId : s.windows[t.windowId]?.kind !== "small" && t.spaceId === space) ? id : undefined;
}

export function activeTab(s: BrowserState, windowId: string): Tab | undefined;
export function activeTab(s: ReadonlyModelState, windowId: string): DeepReadonly<Tab> | undefined;
export function activeTab(s: BrowserState | ReadonlyModelState, windowId: string): Tab | DeepReadonly<Tab> | undefined {
  const id = activeTabId(s, windowId);
  return id ? s.tabs[id] : undefined;
}

export function spaceFor(s: BrowserState, spaceId: string): Space;
export function spaceFor(s: ReadonlyModelState, spaceId: string): DeepReadonly<Space>;
export function spaceFor(s: BrowserState | ReadonlyModelState, spaceId: string): Space | DeepReadonly<Space> {
  return isIncognitoSpace(spaceId) ? INCOGNITO_SPACE : (s.spaces[spaceId] ?? s.spaces[s.settings.defaultSpaceId] ?? INCOGNITO_SPACE);
}

export function bookmarkSpaceId(s: ReadonlyModelState, window: BrowserWindow | DeepReadonly<BrowserWindow> | undefined): string {
  return !window || window.incognito ? s.settings.defaultSpaceId : window.spaceId;
}

export function resolveWindowId(s: ReadonlyModelState, id?: string | null): string | undefined {
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

export function windowTitle(s: ReadonlyModelState, windowId: string): string {
  const w = s.windows[windowId];
  if (!w) return "";
  const tab = activeTab(s, windowId);
  const others = viewTabIds(s, windowId).length - 1;
  const label = tab ? tabLabel(tab) : "New Tab";
  return `${spaceFor(s, w.spaceId).name} — ${label}${others > 0 ? ` & ${plural(others, "Tab")}` : ""}`;
}
