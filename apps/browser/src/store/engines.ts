import { hasWebKit, type PageEngine } from "@bay/chromium";
import { switchedOff } from "../lib/killSwitches";
import { registrableDomain } from "../lib/siteDomain";
import type { DeepReadonly } from "../runtime/projection";
import type { BrowserState } from "./browserStore";
import type { Settings } from "./settings";
import type { Tab } from "./types";

// Which engine a tab's page runs in: Chromium or WebKit. Chromium is Bay's engine; it has no Widevine, so streaming
// sites (Netflix, Disney+, Prime Video…) open in WebKit, whose FairPlay plays them, and a page whose protected video
// won't play can move there (lib/pageEngines.ts). The person can change that: a mode for the whole browser, a default
// engine, rules for single sites and a pick on any tab. A page's links stay on its engine, so a sign-in that crosses
// sites comes back signed in; a typed address leaves for its own site's engine.
// WebKit is macOS's: a build without the BayWebKit module (Windows, Linux) keeps every page in Chromium, whatever the
// (synced) settings say, and so does one where Bay switched WebKit off remotely (lib/killSwitches.ts).

export const ENGINE_NAMES: Record<PageEngine, string> = { chromium: "Chromium", webkit: "WebKit" };
export const ENGINE_SYMBOLS: Record<PageEngine, string> = { chromium: "globe", webkit: "safari" };

/** The settings engine choice reads. */
export type EnginePrefs = Pick<Settings, "engineMode" | "defaultEngine" | "siteEngines" | "streamingInWebKit">;

// Read-only, so the coordinator's store and a window's projection (runtime/projection.ts) both answer.
type EngineState = DeepReadonly<Pick<BrowserState, "tabs">> & { readonly settings: DeepReadonly<EnginePrefs> };

type Prefs = DeepReadonly<EnginePrefs>;

type Site = { key: string; host: string; domain: string };

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

    if (u.protocol === "http:" || u.protocol === "https:") {
      const host = u.hostname.toLowerCase();
      site = { key: `${u.protocol}//${u.host}`.toLowerCase(), host, domain: registrableDomain(host) };
    }
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

/** A web page's registrable domain, which site rules key by: "accounts.example.com" → "example.com". */
export function siteDomainOf(url: string | undefined | null): string | null {
  return parsedSite(url)?.domain ?? null;
}

/** WebKit is there to open pages in: the build has it, and Bay hasn't switched it off. */
export const webKitOn = () => hasWebKit() && !switchedOff("webkit");

/** A page WebKit can show: a web page or a file, while WebKit is on. */
export const canUseWebKit = (url: string | undefined | null) => webKitOn() && !!url && /^(https?|file):/i.test(url);

/** Bay's and Chrome's own pages, extensions and DevTools exist only in Chromium. */
const chromiumOnly = (url: string | undefined | null) => !!url && /^(bay|chrome|chrome-extension|chrome-untrusted|devtools|view-source):/i.test(url);

/** Sites whose video is DRM-protected (Widevine in Chrome, FairPlay in Safari), subdomains included. */
export const PROTECTED_VIDEO_SITES: readonly string[] = [
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

/** The one engine every page opens in, in Chromium or WebKit mode. */
const singleEngine = (prefs: Prefs): PageEngine | undefined => (prefs.engineMode === "automatic" ? undefined : prefs.engineMode);

/** The engine pages open in when nothing else decides: the mode's, else the default engine. */
export const defaultEngineOf = (prefs: Prefs): PageEngine => (webKitOn() ? (singleEngine(prefs) ?? prefs.defaultEngine) : "chromium");

/** The person's rule for a page's site, if there is one. */
export const siteRule = (prefs: Prefs, url: string | undefined | null): PageEngine | undefined => {
  const domain = siteDomainOf(url);

  return domain ? prefs.siteEngines[domain] : undefined;
};

/** The engine a page's site asks for, if anything does: the mode's single engine, the site's rule, then WebKit for a
 *  streaming site. A link to it moves there; a site with no answer keeps the linking page's engine. */
export function chosenEngine(prefs: Prefs, url: string | undefined | null): PageEngine | undefined {
  if (!canUseWebKit(url)) return undefined;

  return singleEngine(prefs) ?? siteRule(prefs, url) ?? (prefs.streamingInWebKit && protectedVideoSite(url) ? "webkit" : undefined);
}

/** A fresh page's engine at an address: Chromium for Bay's own pages, else its site's choice, else the default. */
export function engineForUrl(prefs: Prefs, url: string | undefined | null): PageEngine {
  if (!canUseWebKit(url)) return "chromium";

  return chosenEngine(prefs, url) ?? defaultEngineOf(prefs);
}

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

const pageAddress = (t: DeepReadonly<Tab>) => t.navigation?.url ?? t.url;

function engineOf(s: EngineState, t: DeepReadonly<Tab>, depth: number): PageEngine {
  if (!webKitOn() || chromiumOnly(pageAddress(t))) return "chromium";

  if (t.engine) return t.engine;
  const adopted = fromAdoption(s, t, depth);

  if (adopted) return adopted;
  const single = singleEngine(s.settings);

  if (single) return single;
  const opener = t.openerId ? s.tabs[t.openerId] : undefined;

  if (opener?.engine && (opener.url || opener.navigation)) return opener.engine;

  return engineForUrl(s.settings, pageAddress(t));
}

/** The tab's engine now: the one its page has, else its adopted page's, the mode's, its opener's, then its address's.
 *  A page keeps its engine until it's moved (lib/pageEngines.ts), so a settings change moves pages when they're
 *  shown instead of reloading every tab at once. */
export function tabEngine(s: EngineState, tabId: string): PageEngine {
  const t = s.tabs[tabId];

  return t ? engineOf(s, t, 0) : "chromium";
}

/** A tab whose page Chromium made for it (an extension's tab, a pop-up from Chromium's page) keeps Chromium even in
 *  WebKit mode: extensions exist only there, and a pop-up needs its opener. */
const chromiumDriven = (t: DeepReadonly<Tab>) => !!t.adoptId && /^(nncore|tab):/.test(t.adoptId);

/** The engine the person picked for the tab with Reopen in…, while the tab stays on that site. */
export const tabPick = (t: DeepReadonly<Tab>, url = pageAddress(t)): PageEngine | undefined =>
  t.enginePick && t.enginePick.site === siteDomainOf(url) ? t.enginePick.engine : undefined;

/** The engine the settings want the tab in, first answer winning: Chromium-only pages, the single-engine mode, the
 *  tab's own pick, the site's rule, streaming sites, the default engine. (A link's tab starts in its opener's engine,
 *  so the opener isn't asked here: tabEngine answers for it.) */
export function wantedEngine(s: EngineState, tabId: string): PageEngine {
  const t = s.tabs[tabId];
  const url = t && pageAddress(t);

  if (!t || !canUseWebKit(url)) return "chromium";
  const single = singleEngine(s.settings);

  if (single) return single === "webkit" && chromiumDriven(t) ? "chromium" : single;

  return tabPick(t, url) ?? engineForUrl(s.settings, url);
}

/** An address the user typed: its site's choice (the tab's pick while it stays on the site), else the default
 *  engine. It doesn't follow the page it replaces. */
export function typedNavigationEngine(s: EngineState, tab: DeepReadonly<Tab>, url: string): PageEngine {
  if (!canUseWebKit(url)) return "chromium";

  return (!singleEngine(s.settings) && tabPick(tab, url)) || engineForUrl(s.settings, url);
}

/** The engine a tab's icon is marked with: a web page in the engine other pages don't open in. */
export function engineMark(s: EngineState, tabId: string): PageEngine | null {
  const t = s.tabs[tabId];

  if (!t || !canUseWebKit(t.url || t.navigation?.url)) return null;
  const engine = tabEngine(s, tabId);

  return engine === defaultEngineOf(s.settings) ? null : engine;
}

export type EngineSwitch = { engine: PageEngine; other: PageEngine; site: string; rule: PageEngine | undefined };

/** What a tab's engine switch offers (Site Controls, the tab menu, the command bar): its page's engine and the other
 *  one, its site and the site's rule. Only for a web page in Automatic mode on a build with WebKit; in a single-engine
 *  mode, on Bay's own pages and on Windows and Linux there's nothing to switch. */
export function engineSwitchFor(s: EngineState, tabId: string): EngineSwitch | null {
  const t = s.tabs[tabId];
  const url = t && (t.url || t.navigation?.url);
  const site = siteDomainOf(url);

  if (!t || !site || !canUseWebKit(url) || s.settings.engineMode !== "automatic") return null;
  const engine = tabEngine(s, tabId);

  return { engine, other: engine === "webkit" ? "chromium" : "webkit", site, rule: siteRule(s.settings, url) };
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
