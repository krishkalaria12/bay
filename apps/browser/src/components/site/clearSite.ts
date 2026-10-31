import { clearBrowsingData } from "@bay/nncore";
import { confirm } from "@bay/shell";
import { useBrowser } from "../../store/browser";
import { engineProfile, isIncognitoSpace, plural } from "../../store/model";
import { webviews } from "../../lib/webviews";
import { showToast } from "../layout/toasts";

/**
 * The command bar's Clear Cookies and Cache: the page's site signed out and loaded fresh. Cookies and storage are the
 * site's alone; Chromium's HTTP cache only clears whole, so it goes for the space. A private window's goes when it closes.
 */
export async function clearCookiesAndCache(tabId: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab?.url) return;
  const host = new URL(tab.url).hostname;
  const { confirmed } = await confirm({
    title: `Clear cookies and cache for ${host}?`,
    message: "You'll be signed out of this site, and its offline data will be deleted. Cached files are cleared for the whole space.",
    confirmTitle: "Clear",
    destructive: true,
    windowId: tab.windowId,
  });
  if (!confirmed) return;
  const [result] = await Promise.all([
    webviews.get(tabId)?.clearSiteData(),
    isIncognitoSpace(tab.spaceId) ? undefined : clearBrowsingData(engineProfile(tab.spaceId), ["cache"]),
  ]);
  if (!result?.storage)
    return showToast(tab.windowId, "Couldn't Clear Site Data", `Cookies for ${host} may still be there. Try again.`, { icon: "exclamationmark.triangle" });
  const cookies = typeof result.cookies === "number" ? result.cookies : 0;
  showToast(tab.windowId, "Cookies and Cache Cleared", cookies ? `${plural(cookies, "cookie")} removed from ${host}.` : `Removed site data for ${host}.`);
  void webviews.get(tabId)?.reload();
}
