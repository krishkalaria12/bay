import { focus, openWindow } from "../../lib/actions";
import { defaultLinkDestination, matchingLinkRule } from "../../lib/externalLinkRules";
import { browserRead } from "../../store/read";
import { dispatchBrowserCommand, reportBrowserCommand } from "../../runtime/commands";
import { navigate, newTab } from "../../runtime/tabActions";
import { closeWindow, createWindow } from "../../runtime/windowActions";
import { viewTabIds } from "../../store/model";
import { isSmall, mainWindowFor, mostRecentSpace } from "../../store/small";
import { handleSharedCollectionUrl } from "../../lib/collectionSharing";

const store = () => browserRead.getState();

// ⌘⌥N, and links from other apps. Without a page the bar's field opens, ready to type.
export async function openLittleBay(url?: string, spaceId?: string): Promise<string> {
  return createWindow({ small: true, url, spaceId }, !url);
}

const opensInLittleBay = (url: string) => /^(https?|file):/i.test(url);

// Incoming desktop links use the first matching route, then the configured default.
export async function openExternalUrls(urls: string[], sourceApp?: string) {
  for (const url of urls) {
    if (handleSharedCollectionUrl(url)) continue;
    const s = store();
    const matched = matchingLinkRule(s.settings.externalLinkRules, url, sourceApp)?.destination;
    const target =
      matched?.kind === "space" && !s.spaces[matched.spaceId] ? defaultLinkDestination(s.settings) : (matched ?? defaultLinkDestination(s.settings));
    const spaceId =
      target.kind === "space" && s.spaces[target.spaceId] ? target.spaceId : target.kind === "mostRecentSpace" ? mostRecentSpace(s) : s.settings.defaultSpaceId;
    if (target.kind === "littleBay" && opensInLittleBay(url)) await openLittleBay(url, spaceId);
    else if (target.kind === "newWindow") focus(await openWindow({ url, spaceId }));
    else await openLinksInMainWindow([url], spaceId);
  }
}

// New tabs in the frontmost main window showing the profile (else the frontmost main window, paged to it), which
// comes forward; a new window when there's none. The blank window a launch opens takes the first link itself.
async function openLinksInMainWindow(urls: string[], spaceId: string) {
  let target = mainWindowFor(store(), spaceId);
  for (const url of urls) {
    const s = store();
    const w = target ? s.windows[target] : undefined;
    const view = target ? viewTabIds(s, target) : [];
    const blank = w && view.length === 1 ? s.tabs[view[0]!] : undefined;
    if (!w) target = await openWindow({ url, spaceId });
    else if (blank && !blank.url && !blank.navigation && blank.spaceId === spaceId && !s.windowUi[w.id]?.panel.open) await navigate(blank.id, url);
    else await newTab(w.id, { url, spaceId });
  }
  if (target) focus(target);
}

// ⌘O / the bar's button: the live page (history, scroll, playback) moves into the frontmost main window of its
// profile, which opens if there's none, and Little Bay closes with it.
export function openInMainWindow(windowId: string): Promise<null> {
  return dispatchBrowserCommand({ method: "openInMainWindow", windowId });
}

export async function closeLittleBay(windowId: string) {
  if (isSmall(store(), windowId)) await closeWindow(windowId);
}

// An Esc the page didn't want (not typed into a field, no page full screen) closes Little Bay.
export function closeLittleBayOnEscape(tabId: string) {
  const s = store();
  const tab = s.tabs[tabId];
  if (!tab || !isSmall(s, tab.windowId) || s.find[tabId]?.open || s.windowUi[tab.windowId]?.panel.open) return;
  reportBrowserCommand(closeLittleBay(tab.windowId));
}
