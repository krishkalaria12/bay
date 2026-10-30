import type { PagePoint } from "@bay/nncore";
import type { StateCreator } from "zustand";
import { matchingLinkRule } from "../lib/externalLinkRules";
import type { BrowserState } from "./browser";
import { IDLE_LIVE, activeTabId, findLast, listIds, makeTab, pinnedFirst, pinnedPage, spaceListKey, withList } from "./model";
import { insertionIndex } from "./openers";
import { groupWithOpener } from "./organize";
import { splitOf } from "./splits";
import { activated, apply, removeTabs } from "./tabs";
import { mainWindowFor, mostRecentSpace } from "./small";

// Arc's Peek: a link from a pinned tab or a favourite opens over that tab's page, in a card, instead of as a tab of its
// own. The peek's page is a store tab (a page, live state, an engine browser) that no list holds, marked `peekOf` its
// opener; its window shows it over the opener while the opener is shown. Closing it throws it away, keeping it lists it
// after its opener as any link's tab, and splitting it lists it and pairs it with its opener. One per window, as Arc's:
// another link replaces it.

// `at`: where in the window its link was clicked, for the card to open out of (layout/PeekLayer.tsx).
export type Peek = { tabId: string; fromId: string; at?: PagePoint };

// The last peek a window closed, for Reopen Closed Tab (⌘⇧T) to bring back, as Arc's.
// `afterTab`: the window's last closed tab then (ClosedTab.id), so a tab closed since is told apart from it.
export type ClosedPeek = { url: string; fromId: string; afterTab: string | null };

export type PeeksSlice = {
  // By window.
  peeks: Record<string, Peek>;
  closedPeeks: Record<string, ClosedPeek>;
  /** Opens `url` in a peek over `fromId`'s page (`adoptId`: the tab Chrome already made for the link; `at`: Peek's). */
  openPeek(fromId: string, url: string, adoptId?: string, at?: PagePoint): string | undefined;
  closePeek(windowId: string): void;
  /** Open as Tab: the peek becomes a tab after its opener, shown. */
  keepPeek(windowId: string): string | undefined;
  /** Open in Split View: the peek becomes a tab beside its opener, in one split. */
  splitPeek(windowId: string): void;
  /** Reopen Closed Tab: the window's last closed peek, when nothing closed there since. */
  reopenPeek(windowId: string): boolean;
};

export const isPeek = (t: { peekOf?: string } | undefined) => !!t?.peekOf;

// Second-level suffixes under which a site is three labels (bbc.co.uk), for the common country domains. A link the
// engine catches is judged there, by Chrome's own rule (nn_peek_links.mm); this is for the links that open a tab.
const SECOND_LEVEL = [
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.in",
  "com.br",
  "com.mx",
  "com.ar",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.sg",
  "co.za",
  "co.kr",
];

/** A host's site: its last two labels, or three under a SECOND_LEVEL suffix. Close enough to Chrome's for "another site". */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const two = labels.slice(-2).join(".");
  return labels.length > 2 && SECOND_LEVEL.includes(two) ? labels.slice(-3).join(".") : two;
}
const hostOf = (url: string) => url.match(/^https?:\/\/([^/?#:]*)/i)?.[1] ?? "";

/** Whether `fromId` peeks its links: a pinned tab or a favourite in a main window, with the setting on. */
export function peeksLinks(s: BrowserState, fromId: string): boolean {
  const from = s.tabs[fromId];
  if (!s.settings.peekLinksFromPinnedTabs || !from || isPeek(from) || !pinnedPage(from)) return false;
  const w = s.windows[from.windowId];
  return !!w && !w.incognito && w.kind !== "small";
}

/** Whether a link `fromId` opens goes to a peek: one to another site, from a tab that peeks its links (Arc's rule). */
export function opensInPeek(s: BrowserState, fromId: string, url: string): boolean {
  const host = hostOf(url);
  return !!host && peeksLinks(s, fromId) && siteOf(host) !== siteOf(hostOf(s.tabs[fromId]!.url));
}

/** The window's peek while it's on screen: its opener is the shown tab, or a pane of the shown split. */
export function shownPeek(s: BrowserState, windowId: string): Peek | undefined {
  const peek = s.peeks[windowId];
  if (!peek || !s.tabs[peek.tabId]) return undefined;
  const shown = activeTabId(s, windowId);
  return shown === peek.fromId || splitOf(s, shown)?.tabIds.includes(peek.fromId) ? peek : undefined;
}

const lastClosedTab = (s: BrowserState, windowId: string) => findLast(s.closedTabs, (c) => c.windowId === windowId)?.id ?? null;

const withoutPeek = (s: BrowserState, windowId: string): BrowserState => {
  const { [windowId]: _, ...peeks } = s.peeks;
  return { ...s, peeks };
};

/** Puts the window's peek in its opener's list, as a link opened from it would be, and forgets the peek. */
function listPeek(s: BrowserState, windowId: string, background: boolean): [BrowserState, Peek | undefined] {
  const peek = s.peeks[windowId];
  const tab = peek && s.tabs[peek.tabId];
  if (!peek || !tab) return [s, undefined];
  const { peekOf: _, ...rest } = tab;
  const tabs = { ...s.tabs, [tab.id]: rest };
  const key = spaceListKey(s, tab.spaceId);
  const list = { key, tabIds: [...listIds(s, key)] };
  list.tabIds.splice(insertionIndex({ ...s, tabs }, list, rest, background), 0, tab.id);
  let next = withList({ ...withoutPeek(s, windowId), tabs }, { key, tabIds: pinnedFirst(list.tabIds, tabs) });
  if (rest.openerId) next = groupWithOpener(next, tab.id, rest.openerId, background);
  return [next, peek];
}

export const createPeeksSlice: StateCreator<BrowserState, [], [], PeeksSlice> = (set, get) => ({
  peeks: {},
  closedPeeks: {},

  openPeek(fromId, url, adoptId, at) {
    let s = get();
    const from = s.tabs[fromId];
    if (!from || !s.windows[from.windowId]) return undefined;
    const windowId = from.windowId;
    const replaced = s.peeks[windowId];
    if (replaced) s = withoutPeek(removeTabs(s, [replaced.tabId], false), windowId);
    const tab = { ...makeTab(windowId, from.spaceId, url), openerId: fromId, peekOf: fromId };
    if (adoptId) {
      // Chrome's browser for the link is already loading it; loading it again would drop its POST body and opener.
      tab.adoptId = adoptId;
      tab.navigation = null;
    }
    set({
      ...s,
      tabs: { ...s.tabs, [tab.id]: tab },
      live: { ...s.live, [tab.id]: IDLE_LIVE },
      peeks: { ...s.peeks, [windowId]: { tabId: tab.id, fromId, ...(at && { at }) } },
    });
    return tab.id;
  },

  closePeek(windowId) {
    const s = get();
    const peek = s.peeks[windowId];
    if (!peek) return;
    const url = s.tabs[peek.tabId]?.url;
    const closedPeeks = url ? { ...s.closedPeeks, [windowId]: { url, fromId: peek.fromId, afterTab: lastClosedTab(s, windowId) } } : s.closedPeeks;
    set({ ...withoutPeek(removeTabs(s, [peek.tabId], false), windowId), closedPeeks });
  },

  reopenPeek(windowId) {
    const s = get();
    const closed = s.closedPeeks[windowId];
    // A tab closed in the window since is what ⌘⇧T reopens.
    if (!closed || lastClosedTab(s, windowId) !== closed.afterTab || s.tabs[closed.fromId]?.windowId !== windowId) return false;
    const { [windowId]: _, ...closedPeeks } = s.closedPeeks;
    set({ closedPeeks });
    get().activate(closed.fromId, windowId);
    return !!get().openPeek(closed.fromId, closed.url);
  },

  keepPeek(windowId) {
    const state = get();
    const current = state.peeks[windowId];
    const tab = current && state.tabs[current.tabId];
    const route = tab && !state.windows[windowId]?.incognito ? matchingLinkRule(state.settings.externalLinkRules, tab.url)?.destination : undefined;
    const [next, peek] = listPeek(state, windowId, false);
    if (!peek) return;
    set(apply(next, activated(next, peek.tabId, windowId)));
    if (route?.kind === "littleBay" && tab) return get().createWindow({ small: true, tabIds: [peek.tabId], spaceId: tab.spaceId });
    if (route?.kind === "newWindow") return get().moveTabsToWindow([peek.tabId], null);
    const spaceId = route?.kind === "mostRecentSpace" ? mostRecentSpace(state) : route?.kind === "space" ? route.spaceId : undefined;
    if (!spaceId || !state.spaces[spaceId] || spaceId === tab?.spaceId) return windowId;
    const target = mainWindowFor(state, spaceId) ?? windowId;
    // Hand the page to its destination window before switching profiles, so the opener's window stays in its Space.
    if (target !== windowId) get().moveTabsToWindow([peek.tabId], target);
    get().moveTabToSpace(peek.tabId, spaceId);
    return target;
  },

  splitPeek(windowId) {
    const [next, peek] = listPeek(get(), windowId, true);
    if (!peek) return;
    set(next);
    const result = get().openSplitPane(windowId, { tabId: peek.tabId, anchorTabId: peek.fromId, side: "right", background: true });
    // A split the opener can't take (it's full): the peek's page is still kept, as a tab of its own.
    if (!result.ok) get().activate(peek.tabId, windowId);
  },
});
