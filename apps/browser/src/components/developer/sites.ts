import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection as BrowserState } from "../../runtime/projection";
import { activeTabId } from "../../store/model";

// Which sites are in Developer Mode (devMode.ts), without the app's UI: the window's layout asks.

/** The site a URL is on, as Developer Mode keeps it: "localhost:3000", "app.test"; "" for anything but http(s). */
export function siteKey(url: string): string {
  const m = /^https?:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : "";
}

function hostname(site: string): string {
  return site.startsWith("[") ? site.slice(0, site.indexOf("]") + 1) : site.replace(/:\d+$/, "");
}

/** A server on this machine or the local network: what someone building a site runs it on. */
export function isLocalDevSite(url: string): boolean {
  const site = siteKey(url);
  if (!site) return false;
  const host = hostname(site);
  if (host === "localhost" || host === "[::1]" || host === "0.0.0.0" || /\.(localhost|local|test)$/.test(host)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  // A private address only with a port: a router's or a printer's page is on one without.
  const port = site.length > host.length;
  return port && /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host);
}

export function isDeveloperUrl(s: BrowserState, url: string): boolean {
  const site = siteKey(url);
  return !!site && (s.settings.developerSites ?? []).includes(site);
}

export function isDeveloperTab(s: BrowserState, tabId: string | undefined): boolean {
  const url = tabId ? s.tabs[tabId]?.url : undefined;
  return !!url && isDeveloperUrl(s, url);
}

export const useIsDeveloperTab = (tabId: string | undefined) => useBrowser((s) => isDeveloperTab(s, tabId));

/** The window's shown tab is in Developer Mode: its address is over its page, not in the sidebar. */
export function developerTabShown(s: BrowserState, windowId: string): boolean {
  return isDeveloperTab(s, activeTabId(s, windowId));
}
