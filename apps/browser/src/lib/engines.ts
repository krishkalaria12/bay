import { addHistoryVisits, type PageEngine } from "@bay/nncore";
import { confirm } from "@bay/shell";
import { create } from "zustand";
import { pageOf, patchPage } from "../components/layout/pageState";
import { hideKeyedToast, showToast } from "../components/layout/toasts";
import { useBrowser } from "../store/browser";
import { canSwitchEngine, chosenEngine, ENGINE_NAMES, siteOf, tabEngine, visitRecorder, type WebKitPage } from "../store/engines";
import { engineProfile, isIncognitoSpace, navigationTo } from "../store/model";
import type { Tab } from "../store/types";
import { wantsPage } from "./tabPages";
import { webviews } from "./webviews";

// Moving pages between Chromium and WebKit (store/engines.ts decides which a tab is in). A move reloads the page in the
// other engine's view (ContentCard keys the tab's WebView by its engine); each engine keeps its own sign-ins.

/** Chromium refused a page protected video (page_script.js › Protected video): the offer to play it in WebKit. */
export type EngineOffer = { site: string; host: string; keySystem: string; canRemember: boolean };

export const useEngineOffers = create<Record<string, EngineOffer>>(() => ({}));

const store = () => useBrowser.getState();
// Sites whose offer was turned down: not offered again this run.
const declinedSites = new Set<string>();
const movingTabs = new Set<string>();
const siteMoves = new Map<string, number>();
// A redirect chain across sites with different engines can't bounce a tab between them.
const SITE_MOVE_SPACING_MS = 10_000;
const hostLabel = (site: string) => new URL(site).hostname.replace(/^www\./, "");

const UNSAVED_WORK = `(() => {
  const fields = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]), textarea, select"));
  const changed = (f) => f.type === "checkbox" || f.type === "radio" ? f.checked !== f.defaultChecked : f.tagName === "SELECT" ? Array.from(f.options).some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue;
  const editing = document.activeElement && document.activeElement.isContentEditable;
  post("result", JSON.stringify(fields.some(changed) || !!editing));
})()`;

async function hasUnsavedWork(tabId: string): Promise<boolean> {
  const web = webviews.get(tabId);
  if (!web) return false;
  return (await Promise.race([web.evaluate<boolean>(UNSAVED_WORK), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))])) === true;
}

/** A website rule (null removes it): the site opens in `engine` from then on. */
export function setWebsiteEngine(url: string, engine: PageEngine | null) {
  const site = siteOf(url);
  if (!site) return;
  const rules = { ...store().settings.websiteEngines };
  if (engine) rules[site] = engine;
  else delete rules[site];
  store().updateSettings({ websiteEngines: rules });
}

/** A tab keeps the engine its first view chose, so a later rule or setting doesn't move its page. */
export function persistEngine(tabId: string, engine: PageEngine) {
  const t = store().tabs[tabId];
  if (t && !t.engine) store().updateTab(tabId, { engine });
}

async function mayLeavePage(t: Tab, title: string, message: string, confirmTitle: string): Promise<boolean> {
  if (!wantsPage(t) || !(await hasUnsavedWork(t.id))) return true;
  const { confirmed } = await confirm({ title, message, confirmTitle, cancelTitle: "Stay on Page", windowId: t.windowId });
  return confirmed;
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

/** Reloads the tab's page in `engine`, first asking when the page has input that would be lost. `rule` also saves a
 *  website rule (null removes the site's), never for a private window's page. */
export async function openPageIn(tabId: string, engine: PageEngine, options: { rule?: PageEngine | null; checkWork?: boolean } = {}): Promise<boolean> {
  const t = store().tabs[tabId];
  if (!t) return false;
  const url = pageUrl(t);
  if (!canSwitchEngine(url)) return false;
  const saveRule = () => options.rule !== undefined && !isIncognitoSpace(t.spaceId) && setWebsiteEngine(url, options.rule);
  clearEngineOffer(tabId);
  if (tabEngine(store(), tabId) === engine) {
    saveRule();
    return true;
  }
  const name = ENGINE_NAMES[engine];
  if (
    options.checkWork !== false &&
    !(await mayLeavePage(t, `Open this page in ${name}?`, `The page reloads in ${name}, so changes you made on it may not be saved.`, `Open in ${name}`))
  )
    return false;
  const now = store().tabs[tabId];
  if (!now || pageUrl(now) !== url) return false;
  saveRule();
  if (tabEngine(store(), tabId) === engine) return true;
  store().updateTab(tabId, wantsPage(now) ? { engine, adoptId: undefined, navigation: navigationTo(now.url || url, true) } : { engine });
  return true;
}

export const togglePageEngine = (tabId: string) => openPageIn(tabId, tabEngine(store(), tabId) === "webkit" ? "chromium" : "webkit");

/** A Chromium page's protected video couldn't play: a site chosen for WebKit moves there, any other is offered it. */
export function offerWebKit(tabId: string, data: unknown) {
  const s = store();
  const t = s.tabs[tabId];
  if (!t || !canSwitchEngine(t.url) || tabEngine(s, tabId) === "webkit") return;
  const site = siteOf(t.url);
  if (!site) return;
  const chosen = chosenEngine(s, t.url);
  if (chosen === "chromium" || declinedSites.has(site)) return;
  if (chosen === "webkit") return void moveForProtectedVideo(tabId, site);
  if (useEngineOffers.getState()[tabId]?.site === site) return;
  const keySystem = typeof (data as { keySystem?: unknown } | null)?.keySystem === "string" ? (data as { keySystem: string }).keySystem : "";
  useEngineOffers.setState({ [tabId]: { site, host: hostLabel(site), keySystem, canRemember: !isIncognitoSpace(t.spaceId) } });
}

export function clearEngineOffer(tabId: string) {
  if (!useEngineOffers.getState()[tabId]) return;
  useEngineOffers.setState((offers) => {
    const { [tabId]: _, ...rest } = offers;
    return rest;
  }, true);
}

/** The offer turned down: not asked again this run, or ever (`remember`: a Chromium rule for the site). */
export function stayOnPage(tabId: string, remember = false) {
  const offer = useEngineOffers.getState()[tabId];
  if (offer) declinedSites.add(offer.site);
  if (offer && remember && offer.canRemember) setWebsiteEngine(offer.site, "chromium");
  clearEngineOffer(tabId);
}

export const acceptEngineOffer = (tabId: string) => openPageIn(tabId, "webkit", { rule: "webkit" });

async function moveForProtectedVideo(tabId: string, site: string) {
  if (movingTabs.has(tabId)) return;
  movingTabs.add(tabId);
  try {
    if (!(await openPageIn(tabId, "webkit"))) {
      declinedSites.add(site);
      return;
    }
  } finally {
    movingTabs.delete(tabId);
  }
  const t = store().tabs[tabId];
  if (!t) return;
  const key = `engine-move:${tabId}`;
  const stillThere = () => siteOf(pageUrl(store().tabs[tabId])) === site;
  showToast(t.windowId, "Opened in WebKit for protected video", `${hostLabel(site)} plays here with FairPlay. WebKit keeps its own sign-ins.`, {
    icon: "play.rectangle",
    key,
    action: { title: "Move Back", run: () => void (stillThere() && openPageIn(tabId, "chromium", { rule: "chromium" })) },
  });
  const unwatchSite = useBrowser.subscribe((s, prev) => {
    if (s.tabs[tabId] === prev.tabs[tabId] || stillThere()) return;
    unwatchSite();
    hideKeyedToast(t.windowId, key);
  });
}

/** A link followed in the tab to another site that has a chosen engine (a rule, or a streaming site): the page moves
 *  there once it commits, and Back returns to the page before in the engine it was in. Tabs a page opened keep their
 *  opener's engine. */
export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const site = siteOf(url);
  if (!site || site === siteOf(previousUrl)) return;
  const s = store();
  const t = s.tabs[tabId];
  if (!t || t.openerId) return;
  const chosen = chosenEngine(s, url);
  if (!chosen || chosen === engine) return;
  const now = Date.now();
  if (now - (siteMoves.get(tabId) ?? 0) < SITE_MOVE_SPACING_MS) return;
  siteMoves.set(tabId, now);
  void openPageIn(tabId, chosen, { checkWork: false }).then((moved) => {
    if (moved && canSwitchEngine(previousUrl)) patchPage(tabId, { engineBack: { engine, url: previousUrl } });
  });
}

const visits = visitRecorder(
  (profile, visit) => void addHistoryVisits(profile, [{ url: visit.url, title: visit.title, visitTimes: [visit.at] }]).catch(() => {}),
  { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
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
