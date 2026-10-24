import { capabilities, isMac, shortcutForCommand } from "@bay/platform";
import type { CommandAction } from "@bay/core";
import type { BrowserCommand } from "@bay/shell";
import { runCommand } from "../../lib/commands";
import { isBookmarked } from "../../store/bookmarks";
import { useBrowserRead as useBrowser } from "../../store/read";
import type { BrowserProjection as BrowserState } from "../../runtime/projection";
import { activeTab, bookmarkSpaceId } from "../../store/model";
import { isDeveloperUrl, siteKey } from "../developer/sites";
import type { Tab } from "../../store/types";
import { isInternalTab } from "../pages/urls";
import { splitOf } from "../../store/splits";
import { LITTLE_BAY_DISABLED_COMMANDS } from "../littleBay/menu";

type Context = { s: BrowserState; windowId: string; tab: Tab | undefined };

type ActionDef = {
  command: BrowserCommand;
  arg?: string;
  title: string | ((c: Context) => string);
  icon: string;
  hint?: string;
  keywords?: string[];
  needs?: "page" | "site" | "tab" | "spaces";
  available?: (context: Context) => boolean;
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
  { command: "share", title: "Share", icon: "square.and.arrow.up", needs: page, available: () => isMac },
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

// macOS already exposes these commands through its native menu bar. Other
// desktop hosts keep the same handlers discoverable in the command panel.
const nativePage = ({ tab }: Context) => !!tab?.url && !isInternalTab(tab);
const splitPage = ({ s, tab }: Context) => !!tab && !!splitOf(s, tab.id);
const WINDOW_MENU_DEFS: ActionDef[] = [
  {
    command: "openFile",
    title: ({ s, windowId }) => (s.windows[windowId]?.kind === "small" ? "Open in Main Window" : "Open File…"),
    icon: "doc",
    hint: "⌘O",
    keywords: ["open local file", "html", "pdf", "open in main window"],
  },
  { command: "newLittleBay", title: "New Little Bay Window", icon: "macwindow", hint: "⌥⌘N", keywords: ["small window"] },
  {
    command: "toggleOpenLinksInLittleBay",
    title: ({ s }) => (s.settings.openLinksInLittleBay ? "Open Links from Other Apps in Main Window" : "Open Links from Other Apps in Little Bay"),
    icon: "link",
  },
  { command: "reopenClosedWindow", title: "Reopen Closed Window", icon: "arrow.uturn.backward", available: ({ s }) => !!s.closedWindows.length },
  { command: "closeOtherTabs", title: "Close Other Tabs", icon: "xmark", needs: "tab" },
  { command: "savePage", title: "Save Page As…", icon: "doc", hint: "⌘S", available: nativePage },
  { command: "printWithSystemDialog", title: "Print Using System Dialog…", icon: "doc", available: nativePage },
  { command: "emailPageLocation", title: "Email Page Location", icon: "bubble.left", available: ({ tab }) => !!tab && /^https?:/i.test(tab.url) },
  { command: "stop", title: "Stop Loading", icon: "xmark", available: (c) => nativePage(c) && !!c.tab && !!c.s.live[c.tab.id]?.isLoading },
  { command: "findAndReplace", title: "Find and Replace…", icon: "magnifyingglass", available: nativePage },
  { command: "findNext", title: "Find Next", icon: "arrow.down", hint: "⌘G", available: nativePage },
  { command: "findPrevious", title: "Find Previous", icon: "arrow.up", hint: "⇧⌘G", available: nativePage },
  { command: "useSelectionForFind", title: "Use Selection for Find", icon: "magnifyingglass", hint: "⌘E", available: nativePage },
  { command: "jumpToSelection", title: "Jump to Selection", icon: "magnifyingglass", available: nativePage },
  {
    command: "viewSource",
    title: "View Page Source",
    icon: "chevron.left.forwardslash.chevron.right",
    hint: "⌥⌘U",
    available: ({ tab }) => !!tab && /^(https?|file):/i.test(tab.url),
  },
  { command: "caretBrowsing", title: "Caret Browsing", icon: "doc", available: nativePage },
  {
    command: "toggleTabLayout",
    title: ({ s, windowId }) => ((s.windows[windowId]?.tabLayout ?? s.settings.tabLayout) === "top" ? "Show Tabs in Sidebar" : "Show Tabs on Top"),
    icon: "rectangle.split.2x1",
  },
  {
    command: "toggleAddressBar",
    title: ({ s }) => (s.settings.addressBar === "sidebar" ? "Show Address Bar in Toolbar" : "Show Address Bar in Sidebar"),
    icon: "line.3.horizontal",
  },
  { command: "openSplitPane", title: "Open Split Pane", icon: "rectangle.split.2x1", needs: "tab" },
  { command: "focusNextPane", title: "Focus Next Split Pane", icon: "arrow.right", hint: "⌃⇧]", available: splitPage },
  { command: "focusPreviousPane", title: "Focus Previous Split Pane", icon: "arrow.left", hint: "⌃⇧[", available: splitPage },
  { command: "back", title: "Go Back", icon: "chevron.left", hint: "⌘[", available: ({ s, tab }) => !!tab && !!s.live[tab.id]?.canGoBack },
  { command: "forward", title: "Go Forward", icon: "chevron.right", hint: "⌘]", available: ({ s, tab }) => !!tab && !!s.live[tab.id]?.canGoForward },
  { command: "nextTab", title: "Next Tab", icon: "chevron.right", hint: "⇧⌘]", needs: "tab" },
  { command: "previousTab", title: "Previous Tab", icon: "chevron.left", hint: "⇧⌘[", needs: "tab" },
  { command: "bookmarkAllTabs", title: "Bookmark All Tabs…", icon: "bookmark", hint: "⇧⌘D", needs: "tab" },
  { command: "manageExtensions", title: "Manage Extensions", icon: "puzzlepiece.extension", keywords: ["extension settings"] },
  { command: "addExtension", title: "Add Extension", icon: "puzzlepiece.extension", keywords: ["chrome web store", "install extension"] },
  { command: "pinExtensions", title: "Pin Extensions", icon: "pin", keywords: ["extension toolbar"] },
  { command: "cast", title: "Cast…", icon: "tv.and.mediabox", available: nativePage },
];

const actionId = (d: Pick<ActionDef, "command" | "arg">) => (d.arg ? `${d.command}:${d.arg}` : d.command);

export function barActions(s: BrowserState, windowId: string): CommandAction[] {
  const w = s.windows[windowId];
  const tab = activeTab(s, windowId);
  const c: Context = { s, windowId, tab };
  const out: CommandAction[] = [];
  const defs = capabilities.menuBar ? DEFS : [...DEFS, ...WINDOW_MENU_DEFS];
  for (const d of defs) {
    if (!capabilities.menuBar && w?.kind === "small" && LITTLE_BAY_DISABLED_COMMANDS.includes(d.command)) continue;
    if (d.available && !d.available(c)) continue;
    if (d.needs === "page" && !tab?.url) continue;
    if (d.needs === "tab" && !tab) continue;
    if (d.needs === "site" && !siteKey(tab?.url ?? "")) continue;
    if (d.needs === "spaces" && w?.incognito) continue;
    out.push({
      id: actionId(d),
      title: typeof d.title === "string" ? d.title : d.title(c),
      icon: d.icon,
      ...(d.hint ? { hint: shortcutForCommand(d.command, d.hint) } : {}),
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
        hint: capabilities.menuBar && i < 9 ? `⌃${i + 1}` : undefined,
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
