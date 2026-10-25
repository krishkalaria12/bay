import type { CommandAction } from "@bay/core";
import type { BrowserCommand } from "@bay/shell";
import { runCommand } from "../../lib/commands";
import { isBookmarked } from "../../store/bookmarks";
import { useBrowser, type BrowserState } from "../../store/browser";
import { activeTab, bookmarkSpaceId } from "../../store/model";
import { isDeveloperUrl, siteKey } from "../developer/sites";
import type { Tab } from "../../store/types";
import { boostHost } from "../../lib/boosts";
import { boostsForHost, useBoosts } from "../boosts/state";

const siteHasBoosts = (url: string | undefined) => {
  const host = boostHost(url);
  return !!host && boostsForHost(useBoosts.getState(), host).length > 0;
};
const siteBoostsOn = (url: string) => useBoosts.getState().on && boostsForHost(useBoosts.getState(), boostHost(url)).some((b) => b.enabled);

type Context = { s: BrowserState; windowId: string; tab: Tab | undefined };

type ActionDef = {
  command: BrowserCommand;
  arg?: string;
  title: string | ((c: Context) => string);
  icon: string;
  hint?: string;
  keywords?: string[];
  needs?: "page" | "site" | "tab" | "spaces" | "boost" | "boosted";
};

const page = "page" as const;

const DEFS: ActionDef[] = [
  { command: "newTab", title: "New Tab", icon: "plus", hint: "⌘T", keywords: ["open tab"] },
  { command: "newWindow", title: "New Window", icon: "macwindow", hint: "⌘N" },
  { command: "newIncognitoWindow", title: "New Incognito Window", icon: "eyeglasses", hint: "⇧⌘N", keywords: ["private window", "incognito"] },
  { command: "closeTab", title: "Close Tab", icon: "xmark", hint: "⌘W", needs: "tab" },
  { command: "closeAllTabs", title: "Close All Tabs", icon: "xmark.square", hint: "⇧⌘K" },
  { command: "reopenClosedTab", title: "Reopen Closed Tab", icon: "arrow.uturn.backward", hint: "⇧⌘T", keywords: ["undo close", "restore tab"] },
  {
    command: "togglePin",
    title: ({ tab }) => (tab?.pinned ? "Unpin from Top Apps" : "Move to Top Apps"),
    icon: "pin",
    keywords: ["pin", "unpin", "pin tab", "unpin tab", "remove from top apps", "favorites"],
    needs: "tab",
  },
  { command: "duplicateTab", title: "Duplicate Tab", icon: "plus.square.on.square", needs: "tab" },
  { command: "renameTab", title: "Rename Tab", icon: "pencil", needs: "tab" },
  { command: "searchTabs", title: "Search Tabs", icon: "magnifyingglass", hint: "⇧⌘A" },
  { command: "cleanUpTabs", title: "Clean Up Tabs", icon: "sparkles", hint: "⌥⌘K", keywords: ["tidy tabs"] },
  { command: "newGroupWithTabs", title: "New Group with Tab", icon: "folder.badge.plus", hint: "⌃⌘N", keywords: ["tab group"], needs: "tab" },
  { command: "reload", title: "Reload Page", icon: "arrow.clockwise", hint: "⌘R", keywords: ["refresh"], needs: page },
  { command: "forceReload", title: "Force Reload Page", icon: "arrow.clockwise", hint: "⇧⌘R", keywords: ["hard reload", "hard refresh"], needs: page },
  {
    command: "toggleMute",
    title: ({ tab }) => (tab?.muted ? "Unmute Site" : "Mute Site"),
    icon: "speaker.slash",
    keywords: ["mute", "unmute", "silence"],
    needs: page,
  },
  { command: "copyUrl", title: "Copy URL", icon: "link", hint: "⇧⌘C", keywords: ["copy link"], needs: page },
  { command: "copyUrlAsMarkdown", title: "Copy URL as Markdown", icon: "link", hint: "⌥⇧⌘C", keywords: ["markdown link"], needs: page },
  { command: "findInPage", title: "Find in Page", icon: "text.magnifyingglass", hint: "⌘F", needs: page },
  {
    command: "bookmarkPage",
    title: ({ s, windowId, tab }) =>
      tab?.url && isBookmarked(s.bookmarks, bookmarkSpaceId(s, s.windows[windowId]), tab.url) ? "Remove Bookmark" : "Bookmark This Page",
    icon: "bookmark",
    hint: "⌘D",
    keywords: ["add bookmark", "bookmark"],
    needs: page,
  },
  { command: "print", title: "Print", icon: "printer", hint: "⌘P", needs: page },
  { command: "share", title: "Share", icon: "square.and.arrow.up", needs: page },
  {
    command: "capture",
    title: "Capture",
    icon: "camera.viewfinder",
    hint: "⇧⌘2",
    keywords: ["screenshot", "screen capture", "snip", "capture element", "capture area"],
    needs: page,
  },
  {
    command: "captureFullPage",
    title: "Capture Full Page",
    icon: "camera",
    keywords: ["full page screenshot", "screenshot", "scrolling screenshot"],
    needs: page,
  },
  {
    command: "capturePortrait",
    title: "Capture in Portrait",
    icon: "photo.on.rectangle",
    keywords: ["portrait mode", "screenshot", "framed screenshot", "pretty screenshot"],
    needs: page,
  },
  {
    command: "newBoost",
    title: "Boost This Site",
    icon: "paintbrush.pointed",
    keywords: ["new boost", "boost", "customize site", "restyle", "custom css", "site colors", "change font", "dark mode for site"],
    needs: "boost",
  },
  {
    command: "zapElements",
    title: "Zap Elements",
    icon: "bolt",
    keywords: ["zap", "hide element", "remove element", "block element", "boost"],
    needs: "boost",
  },
  {
    command: "editBoost",
    title: "Edit Boost",
    icon: "paintbrush.pointed.fill",
    keywords: ["boost", "edit boost"],
    needs: "boosted",
  },
  {
    command: "toggleSiteBoosts",
    title: ({ tab }) => (tab && siteBoostsOn(tab.url) ? "Turn Off Boosts for This Site" : "Turn On Boosts for This Site"),
    icon: "paintbrush.pointed",
    keywords: ["boost", "disable boost", "enable boost"],
    needs: "boosted",
  },
  { command: "zoomIn", title: "Zoom In", icon: "plus.magnifyingglass", hint: "⌘+", needs: page },
  { command: "zoomOut", title: "Zoom Out", icon: "minus.magnifyingglass", hint: "⌘-", needs: page },
  { command: "zoomReset", title: "Actual Size", icon: "1.magnifyingglass", hint: "⌘0", keywords: ["reset zoom"], needs: page },
  { command: "devTools", title: "Developer Tools", icon: "hammer", hint: "⌥⌘I", keywords: ["inspect", "devtools", "console"], needs: page },
  {
    command: "toggleDeveloperMode",
    title: ({ s, tab }) => (tab && isDeveloperUrl(s, tab.url) ? "Turn Off Developer Mode for This Site" : "Turn On Developer Mode for This Site"),
    icon: "chevron.left.forwardslash.chevron.right",
    keywords: ["developer mode", "dev mode", "inspect", "localhost", "ruler"],
    needs: "site",
  },
  {
    command: "toggleSidebarPosition",
    title: ({ s }) => (s.settings.sidebarPosition === "right" ? "Move Sidebar to the Left" : "Move Sidebar to the Right"),
    icon: "sidebar.right",
    keywords: ["sidebar position", "sidebar side", "right sidebar", "left sidebar", "flip sidebar"],
  },
  { command: "toggleFullUrl", title: ({ s }) => (s.settings.showFullUrl ? "Hide Full URL" : "Show Full URL"), icon: "text.alignleft" },
  {
    command: "toggleSidebar",
    title: "Auto-Hide Tabs",
    icon: "sidebar.left",
    hint: "⌘S",
    keywords: ["toggle sidebar", "hide sidebar", "show sidebar", "focus mode"],
  },
  { command: "toggleBookmarksBar", title: "Toggle Bookmarks Bar", icon: "menubar.rectangle", hint: "⇧⌘B", keywords: ["bookmarks bar"] },
  { command: "newEasel", title: "New Easel", icon: "scribble.variable", hint: "⌃⇧E", keywords: ["whiteboard", "canvas", "create easel"] },
  { command: "openLibrary", title: "Open Library", icon: "books.vertical", keywords: ["media", "captures", "easels", "archived tabs", "library"] },
  { command: "downloads", title: "Downloads", icon: "arrow.down.circle", hint: "⇧⌘J", keywords: ["show downloads", "dl"] },
  { command: "showHistory", title: "History", icon: "clock", hint: "⌘Y", keywords: ["show history"] },
  { command: "manageBookmarks", title: "Bookmarks", icon: "book", hint: "⌥⌘B", keywords: ["manage bookmarks", "show bookmarks"] },
  { command: "openSettings", title: "Settings", icon: "gearshape", hint: "⌘,", keywords: ["preferences", "prefs", "options"] },
  { command: "clearBrowsingData", title: "Clear Browsing Data", icon: "trash", keywords: ["clear history", "clear cache", "clear cookies"] },
  { command: "importBrowserData", title: "Import Browser Data", icon: "square.and.arrow.down", keywords: ["import bookmarks", "import passwords"] },
  { command: "keyboardShortcuts", title: "Keyboard Shortcuts", icon: "keyboard", keywords: ["shortcuts", "hotkeys"] },
  { command: "mergeAllWindows", title: "Merge All Windows", icon: "rectangle.stack", needs: "spaces" },
  { command: "newSpace", title: "New Space", icon: "plus.square.on.square", keywords: ["create space", "new profile", "create profile"], needs: "spaces" },
  { command: "setAppearance", arg: "dark", title: "Dark Appearance", icon: "moon", keywords: ["dark mode"] },
  { command: "setAppearance", arg: "light", title: "Light Appearance", icon: "sun.max", keywords: ["light mode"] },
  { command: "setAppearance", arg: "auto", title: "Use System Appearance", icon: "circle.lefthalf.filled", keywords: ["auto appearance", "system appearance"] },
];

const actionId = (d: Pick<ActionDef, "command" | "arg">) => (d.arg ? `${d.command}:${d.arg}` : d.command);

export function barActions(s: BrowserState, windowId: string): CommandAction[] {
  const w = s.windows[windowId];
  const tab = activeTab(s, windowId);
  const c: Context = { s, windowId, tab };
  const out: CommandAction[] = [];
  for (const d of DEFS) {
    if (d.needs === "page" && !tab?.url) continue;
    if (d.needs === "tab" && !tab) continue;
    if (d.needs === "site" && !siteKey(tab?.url ?? "")) continue;
    if (d.needs === "spaces" && w?.incognito) continue;
    if (d.needs === "boost" && !boostHost(tab?.url)) continue;
    if (d.needs === "boosted" && !siteHasBoosts(tab?.url)) continue;
    out.push({
      id: actionId(d),
      title: typeof d.title === "string" ? d.title : d.title(c),
      icon: d.icon,
      ...(d.hint ? { hint: d.hint } : {}),
      ...(d.keywords ? { keywords: d.keywords } : {}),
    });
  }
  if (w && !w.incognito) {
    s.spaceOrder.forEach((id, i) => {
      if (id === w.spaceId) return;
      const name = s.spaces[id]?.name ?? "";
      out.push({
        id: `switchSpace:${id}`,
        title: `Switch to ${name}`,
        icon: "person.crop.circle",
        hint: i < 9 ? `⌃${i + 1}` : undefined,
        keywords: [name, "profile"],
      });
    });
  }
  return out;
}

export function runBarAction(id: string, windowId: string) {
  const i = id.indexOf(":");
  const command = (i < 0 ? id : id.slice(0, i)) as BrowserCommand;
  const arg = i < 0 ? null : id.slice(i + 1);
  runCommand({ command, arg, windowId });
}

export const currentBarActions = (windowId: string) => barActions(useBrowser.getState(), windowId);
