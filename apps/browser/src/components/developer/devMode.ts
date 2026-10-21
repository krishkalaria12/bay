import { reportBrowserCommand } from "../../runtime/commands";
import * as settingsCommands from "../../runtime/settingsActions";
import { copyText } from "@bay/shell";
import { create } from "zustand";
import { webviews } from "../../lib/webviews";
import { useBrowserRead as useBrowser } from "../../store/read";
import { activeTabId } from "../../store/model";
import { showToast } from "../layout/splitActions";
import { inspectorScript } from "./inspectorScript";
import { isDeveloperUrl, isLocalDevSite, siteKey } from "./sites";

// Developer Mode, as Arc and yab have it: a site you build gets its whole address over the page, an inspector and
// one-click DevTools. Turned on per site (its host and port); a local server is offered it the first time it's shown.

export function setDeveloperMode(url: string, on: boolean) {
  const site = siteKey(url);
  if (!site) return;
  const s = useBrowser.getState();
  const sites = (s.settings.developerSites ?? []).filter((x) => x !== site);
  reportBrowserCommand(settingsCommands.updateSettings({ developerSites: on ? [...sites, site] : sites }));
  declined.add(site);
  useDeveloperUi.setState((u) => ({ offers: withoutSite(u.offers, site) }));
}

export function toggleDeveloperMode(tabId: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || !siteKey(tab.url)) return;
  const on = !isDeveloperUrl(s, tab.url);
  setDeveloperMode(tab.url, on);
  if (!on) setInspecting(tabId, false);
  showToast(tab.windowId, on ? "Developer Mode On" : "Developer Mode Off", siteKey(tab.url), { icon: "chevron.left.forwardslash.chevron.right" });
}

// MARK: Offers and the inspector

type DeveloperUi = {
  // The site offered Developer Mode on a tab, until it's answered.
  offers: Record<string, string>;
  // Tabs whose page shows the inspector.
  inspecting: Record<string, true>;
};

export const useDeveloperUi = create<DeveloperUi>()(() => ({ offers: {}, inspecting: {} }));
// Sites answered (or turned off) this session: not offered again until the app starts over.
const declined = new Set<string>();

function withoutSite(offers: Record<string, string>, site: string) {
  const out: Record<string, string> = {};
  for (const [tabId, s] of Object.entries(offers)) if (s !== site) out[tabId] = s;
  return out;
}

export const useDeveloperOffer = (tabId: string) => useDeveloperUi((u) => u.offers[tabId] ?? null);
export const useIsInspecting = (tabId: string) => useDeveloperUi((u) => !!u.inspecting[tabId]);

export function answerDeveloperOffer(tabId: string, turnOn: boolean) {
  const site = useDeveloperUi.getState().offers[tabId];
  if (!site) return;
  const url = useBrowser.getState().tabs[tabId]?.url ?? "";
  declined.add(site);
  if (turnOn && siteKey(url) === site) setDeveloperMode(url, true);
  else useDeveloperUi.setState((u) => ({ offers: withoutSite(u.offers, site) }));
  void webviews.get(tabId)?.focus();
}

export function setInspecting(tabId: string, on: boolean) {
  if (!!useDeveloperUi.getState().inspecting[tabId] === on) return;
  useDeveloperUi.setState((u) => {
    const inspecting = { ...u.inspecting };
    if (on) inspecting[tabId] = true;
    else delete inspecting[tabId];
    return { inspecting };
  });
  void webviews.get(tabId)?.evaluate(inspectorScript(on));
  if (on) void webviews.get(tabId)?.focus();
}

export const toggleInspecting = (tabId: string) => setInspecting(tabId, !useDeveloperUi.getState().inspecting[tabId]);

/** What the inspector in a page sends (inspectorScript's send): untrusted, as everything from a page. */
export function onDeveloperMessage(tabId: string, data: unknown) {
  const message = data && typeof data === "object" ? (data as { type?: unknown; text?: unknown }) : null;
  const tab = useBrowser.getState().tabs[tabId];
  if (!message || !tab || !useDeveloperUi.getState().inspecting[tabId]) return;
  if (message.type === "exit") return setInspecting(tabId, false);
  if (message.type === "copy" && typeof message.text === "string") {
    copyText(message.text.slice(0, 200_000));
    return showToast(tab.windowId, "Copied for Agent", "The element, its styles and where it is.", { icon: "doc.on.doc" });
  }
  if (message.type === "elements") {
    setInspecting(tabId, false);
    void webviews.get(tabId)?.showDevTools("inspect");
  }
}

let started = false;

/** Offers Developer Mode to local servers as windows show them, and keeps the inspector on the page it was opened on. */
export function startDeveloperMode() {
  if (started) return;
  started = true;
  useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows && s.tabs === prev.tabs && s.live === prev.live && s.settings === prev.settings) return;
    const ui = useDeveloperUi.getState();
    const offers: Record<string, string> = {};
    for (const [tabId, site] of Object.entries(ui.offers)) if (siteKey(s.tabs[tabId]?.url ?? "") === site && !declined.has(site)) offers[tabId] = site;
    for (const w of Object.values(s.windows)) {
      const id = activeTabId(s, w.id);
      const url = id ? s.tabs[id]?.url : undefined;
      if (!id || !url || offers[id] || !isLocalDevSite(url) || isDeveloperUrl(s, url)) continue;
      const site = siteKey(url);
      // One offer per site at a time, on the tab it was first shown on.
      if (!declined.has(site) && !Object.values(offers).includes(site)) offers[id] = site;
    }
    const keys = Object.keys(offers);
    if (keys.length !== Object.keys(ui.offers).length || keys.some((k) => ui.offers[k] !== offers[k])) useDeveloperUi.setState({ offers });

    for (const tabId of Object.keys(ui.inspecting)) {
      const tab = s.tabs[tabId];
      if (!tab || !isDeveloperUrl(s, tab.url)) {
        setInspecting(tabId, false);
        continue;
      }
      // A new document has no inspector: put it back once the page is loaded.
      if (prev.live[tabId]?.isLoading && !s.live[tabId]?.isLoading) void webviews.get(tabId)?.evaluate(inspectorScript(true));
    }
  });
}
