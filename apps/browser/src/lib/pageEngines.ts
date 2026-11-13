import { addHistoryVisits, type PageEngine } from "@bay/chromium";
import * as Effect from "effect/Effect";
import { PageWorkService } from "../components/site/pageWorkService";
import { pageOf, patchPage } from "../components/window/pageState";
import { runDesktop } from "../effect/runtime";
import { showToast } from "../components/ui/toasts";
import { useBrowser } from "../store/browserStore";
import { canUseWebKit, chosenEngine, ENGINE_NAMES, siteOf, tabEngine, visitRecorder, type WebKitPage } from "../store/engines";
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

/** A tab keeps the engine its first view chose. */
export function persistEngine(tabId: string, engine: PageEngine) {
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
  store().updateTab(tabId, wantsPage(now) ? { engine, adoptId: undefined, navigation: navigationTo(now.url || url, true) } : { engine });

  return true;
}

/** A Chromium page's protected video couldn't play (page_script.js › Protected video): it moves to WebKit, which can play it. */
export async function playInWebKit(tabId: string) {
  const s = store();
  const t = s.tabs[tabId];

  if (!t || !canUseWebKit(t.url) || tabEngine(s, tabId) === "webkit") return;
  const site = siteOf(t.url);

  if (!site || declinedSites.has(site) || movingTabs.has(tabId)) return;
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

/** A link followed in the tab to a site that needs another engine (a streaming site): the page moves there once it
 *  commits, and Back returns to the page before in the engine it was in. Tabs a page opened keep their opener's engine. */
export function followSiteChoice(tabId: string, engine: PageEngine, url: string, previousUrl: string) {
  const site = siteOf(url);

  if (!site || site === siteOf(previousUrl)) return;
  const t = store().tabs[tabId];

  if (!t || t.openerId) return;
  const chosen = chosenEngine(url);

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
