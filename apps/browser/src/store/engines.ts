import { hasWebKit, type PageEngine } from "@bay/chromium";
import type { DeepReadonly } from "../runtime/projection";
import type { BrowserState } from "./browserStore";
import type { Tab } from "./types";

// Which engine a tab's page runs in. Bay chooses it; there is no switch. Chromium is Bay's engine; it has no Widevine, so
// streaming sites (Netflix, Disney+, Prime Video…) open in WebKit, whose FairPlay plays them, and any other page whose
// protected video won't play moves there (lib/pageEngines.ts). A page's links stay on its engine, so a sign-in that
// crosses sites comes back signed in; a typed address leaves for its own site's engine.
// WebKit is macOS's: a build without the BayWebKit module (Windows, Linux) keeps every page in Chromium.

export const ENGINE_NAMES: Record<PageEngine, string> = { chromium: "Chromium", webkit: "WebKit" };
export const ENGINE_SYMBOLS: Record<PageEngine, string> = { chromium: "globe", webkit: "safari" };

// Read-only, so the coordinator's store and a window's projection (runtime/projection.ts) both answer.
type EngineState = DeepReadonly<Pick<BrowserState, "tabs">>;

type Site = { key: string; host: string };

// Every tab icon asks on every store update. URL parsing in Hermes otherwise repeats for all rows even when only
// another page's progress changed. Cache only address-derived facts, so opener changes still apply.
const sites = new Map<string, Site | null>();
const MAX_CACHED_SITES = 1024;

function parsedSite(url: string | undefined | null): Site | null {
  if (!url) return null;
  const cached = sites.get(url);

  if (cached !== undefined) return cached;
  let site: Site | null = null;

  try {
    const u = new URL(url);

    if (u.protocol === "http:" || u.protocol === "https:") site = { key: `${u.protocol}//${u.host}`.toLowerCase(), host: u.hostname.toLowerCase() };
  } catch {}

  // Don't retain unusually large query strings after their tabs close.
  if (url.length > 4096) return site;

  if (sites.size >= MAX_CACHED_SITES) sites.delete(sites.keys().next().value!);
  sites.set(url, site);

  return site;
}

/** A site's key: scheme, host and port (no subdomains), for web pages only. */
export function siteOf(url: string | undefined | null): string | null {
  return parsedSite(url)?.key ?? null;
}

/** A page WebKit can show: a web page or a file, on a build that has WebKit. */
export const canUseWebKit = (url: string | undefined | null) => hasWebKit() && !!url && /^(https?|file):/i.test(url);

/** Bay's and Chrome's own pages, extensions and DevTools exist only in Chromium. */
const chromiumOnly = (url: string | undefined | null) => !!url && /^(bay|chrome|chrome-extension|chrome-untrusted|devtools|view-source):/i.test(url);

/** Sites whose video is DRM-protected (Widevine in Chrome, FairPlay in Safari), subdomains included. */
const PROTECTED_VIDEO_SITES: readonly string[] = [
  "netflix.com",
  "disneyplus.com",
  "max.com",
  "hbomax.com",
  "primevideo.com",
  "hulu.com",
  "tv.apple.com",
  "music.apple.com",
  "open.spotify.com",
  "peacocktv.com",
  "paramountplus.com",
  "crunchyroll.com",
  "hotstar.com",
  "jiohotstar.com",
];

export function protectedVideoSite(url: string | undefined | null): boolean {
  const site = parsedSite(url);

  if (!site?.key.startsWith("https://")) return false;
  const host = site.host;

  return PROTECTED_VIDEO_SITES.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The engine a site needs, if it needs one: WebKit for a streaming site, from its first visit. */
export const chosenEngine = (url: string | undefined | null): PageEngine | undefined => (hasWebKit() && protectedVideoSite(url) ? "webkit" : undefined);

export const engineForUrl = (url: string | undefined | null): PageEngine => chosenEngine(url) ?? "chromium";

const fromAdoption = (s: EngineState, t: DeepReadonly<Tab>, depth: number): PageEngine | undefined => {
  const id = t.adoptId;

  if (!id) return undefined;

  if (id.startsWith("webkit:")) return "webkit";

  if (id.startsWith("nncore:") || id.startsWith("tab:")) return "chromium";

  if (id.startsWith("clone:")) {
    const source = s.tabs[id.slice("clone:".length)];

    return source && depth < 8 ? engineOf(s, source, depth + 1) : undefined;
  }

  return undefined;
};

function engineOf(s: EngineState, t: DeepReadonly<Tab>, depth: number): PageEngine {
  if (!hasWebKit() || chromiumOnly(t.navigation?.url ?? t.url)) return "chromium";

  if (t.engine) return t.engine;
  const adopted = fromAdoption(s, t, depth);

  if (adopted) return adopted;
  const opener = t.openerId ? s.tabs[t.openerId] : undefined;

  if (opener?.engine && (opener.url || opener.navigation)) return opener.engine;

  return engineForUrl(t.navigation?.url ?? t.url);
}

/** The tab's engine: the one it has, else its adopted page's, its opener's, then its address's. */
export function tabEngine(s: EngineState, tabId: string): PageEngine {
  const t = s.tabs[tabId];

  return t ? engineOf(s, t, 0) : "chromium";
}

/** An address the user typed follows its site's engine, else keeps the page's engine. */
export function typedNavigationEngine(s: EngineState, tab: DeepReadonly<Tab>, url: string): PageEngine {
  if (chromiumOnly(url)) return "chromium";
  const chosen = chosenEngine(url);

  if (chosen) return chosen;

  return tab.url || tab.navigation ? tabEngine(s, tab.id) : "chromium";
}

/** The engine a tab's icon is marked with: only a web page away from Chromium. */
export function engineMark(s: EngineState, tabId: string): PageEngine | null {
  const t = s.tabs[tabId];

  if (!t || !canUseWebKit(t.url || t.navigation?.url)) return null;
  const engine = tabEngine(s, tabId);

  return engine === "chromium" ? null : engine;
}

export type WebKitPage = { url: string; title: string; isLoading: boolean; committedUrl: string };

export type RecordedVisit = { url: string; title: string; at: number };

type TimerHandle = Parameters<typeof clearTimeout>[0];

type Visit = RecordedVisit & { staleTitle: string; profile: string | null; timer?: TimerHandle };

type VisitTimers = { set(run: () => void, ms: number): TimerHandle; clear(handle: TimerHandle): void };

export const VISIT_SETTLE_MS = 1500;

/** WebKit pages' visits, for Chromium's history: one per committed address, with the page's own title once it has
 *  one (the previous page's title lingers while the next loads), else whatever it has once loading settles. */
export function visitRecorder(write: (profile: string, visit: RecordedVisit) => void, timers: VisitTimers, now: () => number) {
  const open = new Map<string, Visit>();
  const done = new Map<string, string>();

  const finish = (tabId: string, visit: Visit) => {
    if (visit.timer !== undefined) timers.clear(visit.timer);
    visit.timer = undefined;

    if (open.get(tabId) === visit) open.delete(tabId);
    done.set(tabId, visit.url);

    if (visit.profile !== null) write(visit.profile, { url: visit.url, title: visit.title, at: visit.at });
  };

  return {
    note(tabId: string, profile: string | null, page: WebKitPage) {
      const { url, title, isLoading, committedUrl } = page;

      if (!/^https?:/i.test(url) || url !== committedUrl) return;
      let visit = open.get(tabId);

      if (visit && visit.url !== url) {
        finish(tabId, visit);
        visit = undefined;
      }

      if (!visit) {
        if (done.get(tabId) === url) return;
        done.delete(tabId);
        visit = { url, title, at: now(), staleTitle: title, profile };
        open.set(tabId, visit);
      } else if (title) visit.title = title;

      if (title && title !== visit.staleTitle) return finish(tabId, visit);

      if (isLoading || visit.timer !== undefined) return;
      const settling = visit;
      settling.timer = timers.set(() => {
        if (open.get(tabId) === settling) finish(tabId, settling);
      }, VISIT_SETTLE_MS);
    },
    close(tabId: string) {
      const visit = open.get(tabId);

      if (visit) finish(tabId, visit);
      open.delete(tabId);
      done.delete(tabId);
    },
    size: () => open.size + done.size,
  };
}
