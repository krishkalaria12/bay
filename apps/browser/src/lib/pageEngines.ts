import { addHistoryVisits, hasWebKit, setWebKitZoom, setZoom, type PageEngine } from "@bay/chromium";
import * as Effect from "effect/Effect";
import * as v from "valibot";
import { PageWorkService } from "../components/site/pageWorkService";
import { pageOf, patchPage } from "../components/window/pageState";
import { runDesktop } from "../effect/runtime";
import { showToast } from "../components/ui/toasts";
import { useBrowser } from "../store/browserStore";
import { reportBrowserCommand } from "../runtime/commands";
import { updateSettings } from "../runtime/settingsActions";
import {
  canUseWebKit,
  chosenEngine,
  ENGINE_NAMES,
  engineForUrl,
  siteDomainOf,
  siteOf,
  siteRule,
  tabEngine,
  tabPick,
  visitRecorder,
  wantedEngine,
  type WebKitPage,
} from "../store/engines";
import type { Settings } from "../store/settings";
import { webviews } from "./webviews";
import { engineProfile, isIncognitoSpace, navigationTo } from "../store/model";
import type { Tab } from "../store/types";
import { wantsPage } from "./tabNavigation";

// Moving pages between Chromium and WebKit (store/engines.ts decides which a tab is in). A move reloads the page in the
// other engine's view (ContentCard keys the tab's WebView by its engine); each engine keeps its own sign-ins.

const store = () => useBrowser.getState();

// Sites whose move was turned down to keep unsaved work: not moved again this run.
const declinedSites = new Set<string>();
const movingTabs = new Set<string>();
const siteMoves = new Map<string, number>();

// A redirect chain across sites with different engines can't bounce a tab between them.
const SITE_MOVE_SPACING_MS = 10_000;
const hostLabel = (site: string) => new URL(site).hostname.replace(/^www\./, "");

const siteHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** A tab keeps the engine its first view chose. */
export function persistEngine(tabId: string, engine: PageEngine) {
  // Without WebKit every page is Chromium's; there is nothing to keep.
  if (!hasWebKit()) return;
  const t = store().tabs[tabId];

  if (t && !t.engine) store().updateTab(tabId, { engine });
}

// The page moves to another engine only when the user says so: the page work asks whether it holds input a reload
// would lose (pageWorkService.ts), and asks the user when it does.
function mayLeavePage(t: Tab, title: string, message: string, confirmTitle: string): Promise<boolean> {
  return runDesktop(
    Effect.gen(function* () {
      const pageWork = yield* PageWorkService;

      return yield* pageWork.mayLeavePage(t.id, { title, message, confirmTitle, cancelTitle: "Stay on Page", windowId: t.windowId });
    }),
  );
}

const pageUrl = (t: Tab | undefined) => t?.url || t?.navigation?.url || "";

/** Back from the first page a site's engine moved the tab to: the page before it, in the engine it was in. */
export async function goBackAcrossEngines(tabId: string): Promise<boolean> {
  const back = pageOf(tabId).engineBack;
  const t = store().tabs[tabId];

  if (!back || !t) return false;
  const from = pageUrl(t);

  const leaving = await mayLeavePage(
    t,
    "Go back to the previous page?",
    `It opens in ${ENGINE_NAMES[back.engine]}, so changes you made on this page may not be saved.`,
    "Go Back",
  );

  const now = store().tabs[tabId];

  if (!leaving || !now || pageUrl(now) !== from || pageOf(tabId).engineBack !== back) return false;
  patchPage(tabId, { engineBack: null });
  store().updateTab(tabId, { engine: back.engine, adoptId: undefined, navigation: navigationTo(back.url, true) });

  return true;
}

/** Reloads the tab's page in `engine`, first asking when the page has input that would be lost. */
async function openPageIn(tabId: string, engine: PageEngine, options: { checkWork?: boolean } = {}): Promise<boolean> {
  const t = store().tabs[tabId];

  if (!t) return false;
  const url = pageUrl(t);

  if (!canUseWebKit(url)) return false;

  if (tabEngine(store(), tabId) === engine) return true;
  const name = ENGINE_NAMES[engine];

  if (
    options.checkWork !== false &&
    !(await mayLeavePage(t, `Open this page in ${name}?`, `The page reloads in ${name}, so changes you made on it may not be saved.`, `Open in ${name}`))
  )
    return false;
  const now = store().tabs[tabId];

  if (!now || pageUrl(now) !== url) return false;

  if (tabEngine(store(), tabId) === engine) return true;

  if (wantsPage(now)) await carryPage(now, engine);
  const moved = store().tabs[tabId];

  if (!moved || pageUrl(moved) !== url) return false;
  store().updateTab(tabId, wantsPage(moved) ? { engine, adoptId: undefined, navigation: navigationTo(moved.url || url, true) } : { engine });

  return true;
}

// MARK: Keeping the page in view

// How long a switching page's picture covers it at most, while the other engine loads it.
const HOLD_MS = 3000;
const SCROLL_TIMEOUT_MS = 3000;
const restoring = new Map<string, { engine: PageEngine; x: number; y: number }>();
const holdTimers = new Map<string, ReturnType<typeof setTimeout>>();

const ScrollSchema = v.tuple([v.number(), v.number()]);

/** Before a page switches engines: its zoom goes to the other engine's zoom for its host, and (Settings › Engines ›
 *  Keep the page in view) a picture of it stays on screen, its scroll position to be restored once the other engine
 *  has loaded it (engineViewLoaded). */
async function carryPage(t: Tab, engine: PageEngine) {
  const host = siteHost(pageUrl(t));
  const profile = engineProfile(t.spaceId);

  if (host && Math.abs(t.zoom - 1) > 0.001) {
    if (engine === "webkit") setWebKitZoom(profile, host, t.zoom);
    else await setZoom(profile, host, t.zoom).catch(() => {});
  }

  const view = webviews.get(t.id);

  if (!store().settings.engineSwitchKeepsPage || !view) return;
  const [picture, scroll] = await Promise.all([view.capturePicture(1).catch(() => null), view.evaluate("[window.scrollX, window.scrollY]").catch(() => null)]);
  const position = v.safeParse(ScrollSchema, scroll);

  if (position.success && (position.output[0] > 0 || position.output[1] > 0)) restoring.set(t.id, { engine, x: position.output[0], y: position.output[1] });

  if (!picture) return;
  patchPage(t.id, { engineHold: `data:image/jpeg;base64,${picture.data}` });
  clearTimeout(holdTimers.get(t.id));
  holdTimers.set(
    t.id,
    setTimeout(() => releaseHold(t.id), HOLD_MS),
  );
}

function releaseHold(tabId: string) {
  clearTimeout(holdTimers.get(tabId));
  holdTimers.delete(tabId);

  if (pageOf(tabId).engineHold) patchPage(tabId, { engineHold: null });
}

/** A tab's view in `engine` reported its page: once it has loaded, the page goes back to where it was scrolled and its
 *  picture goes. */
export function engineViewLoaded(tabId: string, engine: PageEngine, isLoading: boolean) {
  const scroll = restoring.get(tabId);

  if (isLoading || (!scroll && !holdTimers.has(tabId))) return;

  if (scroll && scroll.engine === engine) {
    restoring.delete(tabId);
    // Pages that build themselves after load aren't tall enough at once: try until they are, for a few seconds.
    void webviews
      .get(tabId)
      ?.executeJavaScript(
        `(() => { const x = ${scroll.x}, y = ${scroll.y}, until = Date.now() + ${SCROLL_TIMEOUT_MS}; const go = () => { window.scrollTo(x, y); if (Math.abs(window.scrollY - y) > 2 && Date.now() < until) setTimeout(go, 100); }; go(); })()`,
      )
      .catch(() => {});
  }

  // Two frames after the load, so the page has painted under the picture.
  requestAnimationFrame(() => requestAnimationFrame(() => releaseHold(tabId)));
}

// MARK: Following settings

// Awake tabs in the background whose engine a settings change moved: they move when next shown, so a big session
// doesn't reload at once.
const pendingMoves = new Map<string, PageEngine>();
let unwatchSettings: (() => void) | null = null;

const sameEnginePrefs = (a: Settings, b: Settings) =>
  a.engineMode === b.engineMode && a.defaultEngine === b.defaultEngine && a.siteEngines === b.siteEngines && a.streamingInWebKit === b.streamingInWebKit;

/** Open tabs follow a change to Settings › Engines (the mode, the default engine, a site rule, the streaming list):
 *  a tab in the engine the old settings wanted moves to the one the new settings want. A tab another engine for a
 *  reason of its own (an opener's engine, a pick) stays. A sleeping tab just takes the new engine; a shown one moves
 *  now, asking first if it holds unsaved work; one awake in the background moves when shown. Once, on a Mac. */
export function followEngineSettings() {
  if (!hasWebKit() || unwatchSettings) return;
  unwatchSettings = useBrowser.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs)
      for (const map of [pendingMoves, restoring]) {
        for (const id of map.keys()) if (!s.tabs[id]) map.delete(id);
      }

    if (s.settings === prev.settings || sameEnginePrefs(s.settings, prev.settings)) return;
    const before = { tabs: s.tabs, settings: prev.settings };

    for (const id of Object.keys(s.tabs)) {
      const t = s.tabs[id]!;
      const was = wantedEngine(before, id);
      const wanted = wantedEngine(s, id);

      if (was === wanted || !t.engine || t.engine !== was) continue;

      if (!webviews.get(id)) store().updateTab(id, { engine: wanted, wakeAdoptId: undefined });
      else if (shownTabs.has(id)) void openPageIn(id, wanted);
      else pendingMoves.set(id, wanted);
    }
  });
}

const shownTabs = new Set<string>();

/** A tab's page is on screen (or not): a move a settings change left for it happens now. */
export function engineTabShown(tabId: string, shown: boolean) {
  if (!shown) return void shownTabs.delete(tabId);
  shownTabs.add(tabId);
  const engine = pendingMoves.get(tabId);

  if (!engine) return;
  pendingMoves.delete(tabId);

  // Only if nothing has moved it since.
  if (wantedEngine(store(), tabId) === engine && tabEngine(store(), tabId) !== engine) void openPageIn(tabId, engine);
}

/** A Chromium page's protected video couldn't play (page_script.js › Protected video): it moves to WebKit, which can
 *  play it, or offers to, as Settings › Engines › When protected video won't play says. A site or tab the person put
 *  in Chromium stays there. */
export async function playInWebKit(tabId: string) {
  const s = store();
  const t = s.tabs[tabId];

  if (!t || !canUseWebKit(t.url) || tabEngine(s, tabId) === "webkit" || s.settings.engineMode === "chromium") return;

  if (s.settings.protectedVideoFallback === "stay" || siteRule(s.settings, t.url) === "chromium" || tabPick(t) === "chromium") return;
  const site = siteOf(t.url);

  if (!site || declinedSites.has(site) || movingTabs.has(tabId)) return;

  if (s.settings.protectedVideoFallback === "ask") return patchPage(tabId, { engineOffer: hostLabel(site) });
  await moveForProtectedVideo(tabId, site);
}

async function moveForProtectedVideo(tabId: string, site: string) {
  movingTabs.add(tabId);

  try {
    if (!(await openPageIn(tabId, "webkit"))) {
      declinedSites.add(site);

      return;
    }
  } finally {
    movingTabs.delete(tabId);
  }

  const moved = store().tabs[tabId];

  if (moved)
    showToast(moved.windowId, "Opened in Safari's engine for protected media", `${hostLabel(site)} plays here. You may need to sign in once.`, {
      icon: "play.rectangle",
    });
}

/** The person's answer to "Play <site> in WebKit?": stay this time, open it there, or keep the site in Chromium. */
export function answerEngineOffer(tabId: string, answer: "stay" | "open" | "never") {
  const t = store().tabs[tabId];
  const site = siteOf(t?.url);
  patchPage(tabId, { engineOffer: null });

  if (!t || !site) return;

  if (answer === "open") return void moveForProtectedVideo(tabId, site);
  declinedSites.add(site);

  if (answer === "never") void alwaysOpenSiteIn(tabId, "chromium");
}

/** Reopen in…: the tab's page reloads in `engine`, which stays the tab's while it's on this site. */
export async function reopenIn(tabId: string, engine: PageEngine): Promise<boolean> {
  const t = store().tabs[tabId];
  const site = siteDomainOf(pageUrl(t));

  if (!t || !site || !(await openPageIn(tabId, engine))) return false;
  const now = store().tabs[tabId];

  if (!now) return false;
  // A pick the site's own choice already makes isn't kept, so a later rule still reaches the tab.
  const follows = engineForUrl(store().settings, pageUrl(now)) === engine;
  store().updateTab(tabId, { enginePick: follows ? undefined : { engine, site } });

  return true;
}

/** Always Open <site> in…: a site rule, and the tab moves there now. */
export async function alwaysOpenSiteIn(tabId: string, engine: PageEngine): Promise<void> {
  const s = store();
  const t = s.tabs[tabId];
  const site = siteDomainOf(pageUrl(t));

  if (!t || !site) return;
  reportBrowserCommand(updateSettings({ siteEngines: { ...s.settings.siteEngines, [site]: engine } }));

  if (t.enginePick) store().updateTab(tabId, { enginePick: undefined });

  if (tabEngine(store(), tabId) !== engine) await openPageIn(tabId, engine);
}

/** Forgets a site's rule; its pages follow the default engine again. */
export function forgetSiteRule(site: string) {
  const rules = { ...store().settings.siteEngines };
  delete rules[site];
  reportBrowserCommand(updateSettings({ siteEngines: rules }));
}

/** A link followed in the tab to a site that needs another engine (a streaming site): the page moves there once it
 *  commits, and Back returns to the page before in the engine it was in. Tabs a page opened keep their opener's engine. */
export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const site = siteOf(url);

  if (!site || site === siteOf(previousUrl)) return;
  const t = store().tabs[tabId];

  if (!t || t.openerId) return;
  const chosen = chosenEngine(store().settings, url);

  if (!chosen || chosen === engine) return;
  const now = Date.now();

  if (now - (siteMoves.get(tabId) ?? 0) < SITE_MOVE_SPACING_MS) return;
  siteMoves.set(tabId, now);
  void openPageIn(tabId, chosen, { checkWork: false }).then((moved) => {
    if (moved && canUseWebKit(previousUrl)) patchPage(tabId, { engineBack: { engine, url: previousUrl } });
  });
}

const visits = visitRecorder(
  (profile, visit) => void addHistoryVisits(profile, [{ url: visit.url, title: visit.title, visitTimes: [visit.at] }]).catch(() => {}),
  { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle) },
  Date.now,
);

const visitedTabs = new Set<string>();
let unwatch: (() => void) | null = null;

function watchClosedTabs() {
  unwatch ??= useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;

    for (const id of visitedTabs) {
      if (s.tabs[id]) continue;
      visitedTabs.delete(id);
      visits.close(id);
    }
  });
}

/** A WebKit page's visit goes into the profile's (Chromium's) history; a private window's never does. */
export function noteWebKitPage(tabId: string, page: WebKitPage) {
  const t = store().tabs[tabId];

  if (!t) return;
  watchClosedTabs();
  visitedTabs.add(tabId);
  visits.note(tabId, isIncognitoSpace(t.spaceId) ? null : engineProfile(t.spaceId), page);
}
