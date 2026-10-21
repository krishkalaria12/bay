import { APP_PAGE_HOSTS, toAppUrl } from "@bay/core";
import type { BrowserStore } from "../store/browser";
import { engineProfileFor, viewTabIds } from "../store/model";
import type { TabLive } from "../store/types";

const URL_LIMIT = 1_048_576;
const TEXT_LIMIT = 65_536;
type ObjectValue = Record<string, unknown>;

function object(value: unknown, fields: readonly string[]): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid page fact object");
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("unknown page fact field");
  return value as ObjectValue;
}
function text(value: unknown, limit = TEXT_LIMIT): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("invalid page fact text");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid page fact boolean");
  return value;
}
function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw new Error("invalid page fact number");
  return value;
}
const url = (value: unknown) => toAppUrl(text(value, URL_LIMIT));
const optionalBoolean = (value: unknown) => (value === undefined ? undefined : boolean(value));
const blank = (value: string) => !value || value === "about:blank";
const internal = (value: string) => APP_PAGE_HOSTS.some((host) => new RegExp(`^bay://${host}(?:[/?#]|$)`, "i").test(value));

type Fact =
  | { event: "onNavigationChange"; url: string; title: string; live: Partial<TabLive>; browserId?: number }
  | { event: "onProgress"; progress: number }
  | { event: "onFavicon"; url: string }
  | { event: "onMedia"; playing: boolean }
  | { event: "onZoom"; zoom: number }
  | { event: "onFindResult"; count: number; active: number }
  | { event: "onDownloadNavigation"; committedUrl: string; skipped: boolean }
  | { event: "onDiscarded"; url: string }
  | { event: "onLoadError" };

function parseFact(event: unknown, value: unknown): Fact {
  switch (event) {
    case "onNavigationChange": {
      const p = object(value, ["url", "title", "isLoading", "canGoBack", "canGoForward", "themeColor", "themeColorSource", "browserId", "audible", "muted"]);
      const themeColor = p.themeColor === null ? null : text(p.themeColor, 128);
      if (themeColor !== null && !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(themeColor)) throw new Error("invalid theme color");
      if (p.themeColorSource !== undefined && p.themeColorSource !== null && !["meta", "header", "background"].includes(text(p.themeColorSource, 32)))
        throw new Error("invalid theme color source");
      const audible = optionalBoolean(p.audible);
      optionalBoolean(p.muted);
      return {
        event,
        url: url(p.url),
        title: text(p.title),
        browserId: p.browserId === undefined ? undefined : number(p.browserId, 1, Number.MAX_SAFE_INTEGER, true),
        live: {
          isLoading: boolean(p.isLoading),
          canGoBack: boolean(p.canGoBack),
          canGoForward: boolean(p.canGoForward),
          themeColor,
          ...(audible === undefined ? {} : { playingAudio: audible }),
        },
      };
    }
    case "onProgress": {
      const p = object(value, ["progress"]);
      return { event, progress: number(p.progress, 0, 1) };
    }
    case "onFavicon": {
      const p = object(value, ["url", "urls"]);
      if (!Array.isArray(p.urls) || p.urls.length > 256) throw new Error("invalid favicon candidates");
      for (let i = 0; i < p.urls.length; i++) text(p.urls[i], URL_LIMIT);
      const favicon = text(p.url, URL_LIMIT);
      if (!favicon) throw new Error("empty favicon");
      return { event, url: favicon };
    }
    case "onMedia": {
      const p = object(value, ["playing", "muted"]);
      boolean(p.muted);
      return { event, playing: boolean(p.playing) };
    }
    case "onZoom": {
      const p = object(value, ["zoom", "host", "isDefault", "pinchScale"]);
      if (p.host !== undefined) text(p.host, 4096);
      optionalBoolean(p.isDefault);
      if (p.pinchScale !== undefined) number(p.pinchScale, 0.01, 100);
      return { event, zoom: number(p.zoom, 0.01, 100) };
    }
    case "onFindResult": {
      const p = object(value, ["count", "active", "final"]);
      optionalBoolean(p.final);
      return { event, count: number(p.count, -1, 1_000_000, true), active: number(p.active, -1, 1_000_000, true) };
    }
    case "onDownloadNavigation": {
      const p = object(value, ["url", "committedUrl", "skipped"]);
      if (p.url !== undefined) url(p.url);
      return { event, committedUrl: url(p.committedUrl), skipped: boolean(p.skipped) };
    }
    case "onDiscarded": {
      const p = object(value, ["url"]);
      return { event, url: url(p.url) };
    }
    case "onLoadError": {
      const p = object(value, ["url", "code", "text"]);
      url(p.url);
      number(p.code, -2_147_483_648, 2_147_483_647, true);
      text(p.text);
      return { event };
    }
    default:
      throw new Error("unknown page fact event");
  }
}

type Page = { sequence: number; profile: string; browserId: number; retired: Set<number>; navigation: number | undefined; pending: string | null };

/** Applies browser-authenticated facts to the coordinator's store, independent of page/window ownership. */
export function createPageFactConsumer(store: BrowserStore) {
  const pages = new Map<string, Page>();
  let disposed = false;
  // Removals (including peeks) change tabLists; closing loaded pinned tabs also changes closedTabs.
  // Ordinary title/progress reports change neither, so they never scan the tracked pages.
  const unsubscribe = store.subscribe((state, before) => {
    if (state.tabLists === before.tabLists && state.spaces === before.spaces && state.closedTabs === before.closedTabs) return;
    for (const [id, page] of pages) {
      const tab = state.tabs[id];
      if (!tab || tab.unloaded || engineProfileFor(tab.spaceId, state.spaces) !== page.profile) pages.delete(id);
    }
  });
  return {
    apply(input: unknown): boolean {
      if (disposed) return false;
      let tabId: string, profile: string, browserId: number, sequence: number, fact: Fact;
      try {
        const envelope = object(input, ["tabId", "profile", "browserId", "sequence", "event", "payload"]);
        tabId = text(envelope.tabId, 1024);
        if (!tabId) return false;
        profile = text(envelope.profile, 1024);
        browserId = number(envelope.browserId, 1, Number.MAX_SAFE_INTEGER, true);
        sequence = number(envelope.sequence, 1, Number.MAX_SAFE_INTEGER, true);
        fact = parseFact(envelope.event, envelope.payload);
        if (fact.event === "onNavigationChange" && fact.browserId !== undefined && fact.browserId !== browserId) return false;
      } catch {
        return false;
      }
      const s = store.getState();
      const tab = s.tabs[tabId];
      if (!tab || tab.unloaded) {
        pages.delete(tabId);
        return false;
      }
      if (internal(tab.navigation?.url ?? tab.url) || engineProfileFor(tab.spaceId, s.spaces) !== profile) return false;
      let previous = pages.get(tabId);
      if (previous && previous.profile !== profile) {
        pages.delete(tabId);
        previous = undefined;
      }
      if (previous && (sequence <= previous.sequence || previous.retired.has(browserId))) return false;
      const page = previous ?? {
        sequence: 0,
        profile,
        browserId,
        retired: new Set<number>(),
        navigation: tab.navigation?.seq,
        pending: tab.navigation?.url ?? (tab.adoptId ? tab.url : null),
      };
      if (page.browserId !== browserId) {
        page.retired.add(page.browserId);
        page.browserId = browserId;
        page.pending = tab.navigation?.url ?? (tab.adoptId ? tab.url : null);
      }
      if (page.navigation !== tab.navigation?.seq) {
        page.navigation = tab.navigation?.seq;
        page.pending = tab.navigation?.url ?? null;
      }
      // Native sequence orders page reports, not command issuance. A URL alone cannot distinguish an older
      // queued report from a redirect, so keep the existing blank-page suppression rather than guess.
      page.sequence = sequence;
      pages.set(tabId, page);
      switch (fact.event) {
        case "onNavigationChange":
          if (page.pending !== null && blank(fact.url) && !page.pending.startsWith("about:")) s.updateLive(tabId, { isLoading: true });
          else {
            page.pending = null;
            s.navigated(tabId, { url: fact.url, title: fact.title }, fact.live);
          }
          break;
        case "onProgress":
          s.updateLive(tabId, { progress: fact.progress });
          break;
        case "onFavicon":
          s.faviconChanged(tabId, fact.url);
          break;
        case "onMedia":
          s.updateLive(tabId, { playingAudio: fact.playing });
          break;
        case "onZoom":
          s.updateTab(tabId, { zoom: fact.zoom });
          break;
        case "onFindResult":
          s.setFind(tabId, { count: fact.count, active: fact.active });
          break;
        case "onDownloadNavigation": {
          page.pending = null;
          s.updateLive(tabId, { isLoading: false });
          if (fact.committedUrl) s.updateTab(tabId, { url: fact.committedUrl });
          else if (
            !fact.skipped &&
            (tab.openerId || tab.adoptId) &&
            !s.live[tabId]?.canGoBack &&
            viewTabIds(s, tab.windowId, tab.spaceId).some((id) => id !== tabId)
          )
            s.closeTab(tabId);
          else s.updateTab(tabId, { url: "", title: "", favicon: null, newTabHistory: undefined });
          break;
        }
        case "onDiscarded":
          page.pending = fact.url;
          s.updateLive(tabId, { isLoading: false, progress: 0, canGoBack: false, canGoForward: false, playingAudio: false });
          break;
        case "onLoadError":
          page.pending = null;
          break;
      }
      return true;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      pages.clear();
    },
  };
}
