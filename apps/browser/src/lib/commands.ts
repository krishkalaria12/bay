import { closeWindow as closeNativeWindow, copyText, openExternalURL, pickFiles, prompt, setAppearance, sharePage, type CommandEvent } from "@bay/shell";
import { markdownLink } from "@bay/core";
import { useBrowser } from "../store/browser";
import { activeTabId, bookmarkSpaceId, resolveWindowId, viewTabIds } from "../store/model";
import { closeTab, createSpace, cycleSpace, focus, moveTabToSpace, moveTabToWindow, openWindow, switchSpace, toggleMute } from "./actions";
import { bookmarkActivePage, bookmarkAllTabs } from "../components/bookmarks/actions";
import { useClearDataRequest } from "../components/pages/ClearDataDialog";
import { openInternalPage } from "../components/pages/urls";
import { isUtilityWindowId, openImport, openSettings } from "../components/settings/windows";
import { openNewTabPanel } from "./newTab";
import { webviews } from "./webviews";
import { goBack, goForward } from "../components/layout/history";
import { openSplitPane } from "../components/layout/splitActions";
import { runSidebarCommand } from "../components/sidebar/commands";
import { numberedTabs } from "../components/sidebar/entries";
import { openExtensionFromMenu } from "../components/extensions/bridge";
import { toggleCastPicker } from "../components/media/cast";
import { openManageExtensions, openPinDialog, openWebStore } from "../components/extensions/state";
import { requestAutofill } from "../components/site/Autofill";
import { copyPageUrl, jumpToSelection } from "../components/site/selection";
import { toggleDeveloperMode } from "../components/developer/devMode";
import { captureFullPage, startCapture } from "../components/capture/state";
import { newEasel, openLibrary } from "../components/library/actions";
import { openSpaceMenu } from "../components/SpaceIndicator";
import { groupOf } from "../store/organize";
import { shownPeek } from "../store/peeks";
import { isSmall, mainWindowFor } from "../store/small";
import { closeLittleBay, openInMainWindow, openLittleBay } from "../components/littleBay/actions";
import { joinMeetingNow } from "../live/alerts";

export function runCommand({ command, arg, windowId: requested }: CommandEvent) {
  const s = useBrowser.getState();

  if (isUtilityWindowId(requested)) {
    if (command === "closeTab") return void closeNativeWindow(requested!);
    requested = null;
  }
  if (isSmall(s, requested) && runLittleBayCommand(command, requested!)) return;
  // A peek on screen takes ⌘W and ⌘O first (⌘O is Open File… otherwise), unless the command bar is open over it.
  const peekWindow = resolveWindowId(s, requested);
  if (peekWindow && !s.windowUi[peekWindow]?.panel.open && runPeekCommand(command, peekWindow)) return;
  if (command === "newTab" && requested && s.windows[requested]) return openNewTabPanel(requested);

  switch (command) {
    case "undoPinnedFolderMove":
      return s.undoPinnedFolderMove();
    case "newWindow":
      return void openWindow({ spaceId: arg ?? undefined });
    case "newIncognitoWindow":
      return void openWindow({ incognito: true });
    case "newLittleBay":
      return void openLittleBay();
    case "joinMeeting":
      return void joinMeetingNow();
    case "toggleOpenLinksInLittleBay":
      return s.updateSettings({ openLinksInLittleBay: !s.settings.openLinksInLittleBay });
    case "reopenClosedWindow":
      return s.reopenClosedWindow();
    case "setAppearance":
      if (arg === "auto" || arg === "light" || arg === "dark") {
        s.updateSettings({ appearance: arg });
        void setAppearance(arg);
      }
      return;
    case "toggleFullUrl":
      return s.updateSettings({ showFullUrl: !s.settings.showFullUrl });
    case "toggleAddressBar":
      return s.updateSettings({ addressBar: s.settings.addressBar === "sidebar" ? "toolbar" : "sidebar" });
    case "toggleSidebarPosition":
      return s.updateSettings({ sidebarPosition: s.settings.sidebarPosition === "right" ? "left" : "right" });
    case "openSettings":
      return openSettings();
    case "keyboardShortcuts":
      return openSettings("shortcuts");
    case "importBrowserData":
      return openImport();
    case "openFile":
      return void openFiles(requested);
    case "manageExtensions":
      return openManageExtensions();
    case "setBookmarksBar":
      if (arg === "always" || arg === "newTab" || arg === "never") s.updateSettings({ bookmarksBar: arg });
      return;
    case "toggleBookmarksBar": {
      const mode = s.settings.bookmarksBar;
      const target = resolveWindowId(s, requested);
      const active = target ? activeTabId(s, target) : undefined;
      const shown = mode === "always" || (mode === "newTab" && !(active && s.tabs[active]?.url));
      return s.updateSettings({ bookmarksBar: shown ? "never" : "always" });
    }
  }

  // From Little Bay, tabs, windows and the sidebar's commands act on the main window.
  if (isSmall(s, requested) && !LITTLE_BAY_PAGE_COMMANDS.has(command)) {
    requested = mainWindowFor(s, s.windows[requested!]!.spaceId) ?? null;
    if (requested) focus(requested);
  }

  const windowId = resolveWindowId(s, requested);
  if (!windowId) {
    if (command === "newTab") {
      const created = openWindow();
      useBrowser.getState().openPanel(created);
    }
    if (command === "reopenClosedTab" || command === "restoreClosed") {
      if (arg) s.restoreClosed(arg);
      else s.reopenClosed();
    }
    return;
  }
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  const page = tab?.url ? tab : undefined;
  const web = tabId ? webviews.get(tabId) : undefined;
  const ui = s.windowUi[windowId];
  const find = tabId ? s.find[tabId] : undefined;
  if (runSidebarCommand(command, arg, windowId)) return;

  switch (command) {
    case "newTab":
      return openNewTabPanel(windowId);
    case "reopenClosedTab":
      // A peek closed last comes back over its tab, as Arc's (store/peeks.ts).
      if (s.reopenPeek(windowId)) return;
      return s.reopenClosed(windowId);
    case "restoreClosed":
      return arg ? s.restoreClosed(arg, windowId) : undefined;
    case "focusCommandBar":
      if (page) return s.openPanel(windowId, page.url);
      return s.openPanel(windowId, "");
    case "closeTab":
      if (ui?.panel.open) return s.closePanel(windowId);
      if (tabId && find?.open) return closeFind(tabId);
      return tabId ? void closeTab(tabId) : undefined;
    case "print":
      return void web?.print();
    case "printWithSystemDialog":
      return void web?.runPageCommand("systemPrint");
    case "savePage":
      return void web?.runPageCommand("savePage");
    case "capture":
      return page ? void startCapture(page.id) : undefined;
    case "captureFullPage":
      return page ? void captureFullPage(page.id) : undefined;
    case "caretBrowsing":
      return void web?.runPageCommand("caretBrowsing");
    case "emailPageLocation":
      if (!page || !/^https?:/i.test(page.url)) return;
      return void openExternalURL(`mailto:?subject=${encodeURIComponent(page.customTitle || page.title || page.url)}&body=${encodeURIComponent(page.url)}`);
    case "stop":
      return void web?.stopLoading();
    case "share":
      return page && /^https?:/i.test(page.url) ? void sharePage(page.url, page.customTitle || page.title, windowId) : undefined;
    case "copyUrl":
      return page ? void copyPageUrl(page.id) : undefined;
    case "copyUrlAsMarkdown":
      return page ? copyText(markdownLink(page.customTitle || page.title, page.url)) : undefined;
    case "findInPage":
      return page ? s.setFind(page.id, { open: true, replace: false, focusRequest: Date.now() }) : undefined;
    case "findAndReplace":
      return page ? s.setFind(page.id, { open: true, replace: true, focusRequest: Date.now() }) : undefined;
    case "jumpToSelection":
      return page ? void jumpToSelection(page.id) : undefined;
    case "useSelectionForFind":
      if (!page || !web) return;
      return void web.evaluate<string>("post('result', JSON.stringify(String(getSelection() || '').trim().slice(0, 500)))").then((query) => {
        if (query) useBrowser.getState().setFind(page.id, { open: true, query, focusRequest: Date.now() });
      });
    case "findNext":
    case "findPrevious":
      if (!page) return;
      if (!find?.query) return s.setFind(page.id, { open: true });
      return void web?.find(find.query, command === "findNext", true);
    case "reload":
      return void web?.reload();
    case "forceReload":
      return void web?.forceReload();
    case "toggleTabLayout":
      return s.toggleTabLayout(windowId);
    case "openSplitPane":
      return void openSplitPane(windowId);
    case "focusNextPane":
      return s.focusPane(windowId, 1);
    case "focusPreviousPane":
      return s.focusPane(windowId, -1);
    case "removeFromSplit":
      return tab ? s.removeTabFromSplit(tab.id) : undefined;
    case "toggleSidebar":
      return s.toggleSidebar(windowId);
    case "zoomIn":
      return page ? void web?.zoomStep(1) : undefined;
    case "zoomOut":
      return page ? void web?.zoomStep(-1) : undefined;
    case "zoomReset":
      return page ? void web?.zoomStep(0) : undefined;
    case "devTools":
      return void web?.showDevTools();
    case "toggleDeveloperMode":
      return page ? toggleDeveloperMode(page.id) : undefined;
    case "toggleDevTools":
      return void web?.showDevTools("toggle");
    case "inspectElements":
      return void web?.showDevTools("inspect");
    case "javaScriptConsole":
      return void web?.showDevTools("console");
    case "viewSource":
      if (!page || !web || !/^(https?|file):/.test(page.url)) return;
      return void s.newTab(windowId, { url: `view-source:${page.url}`, openerId: page.id, spaceId: page.spaceId });
    case "back":
      return tabId ? goBack(tabId) : undefined;
    case "forward":
      return tabId ? goForward(tabId) : undefined;
    case "nextTab":
      return s.cycle(windowId, 1);
    case "previousTab":
      return s.cycle(windowId, -1);
    case "selectTab":
    case "selectLastTab": {
      const rows = numberedTabs(s, windowId);
      const id = command === "selectLastTab" ? rows.at(-1) : rows[Number(arg) - 1];
      return id ? s.activate(id, windowId) : undefined;
    }
    case "togglePin":
      return tab ? s.togglePin(tab.id) : undefined;
    case "togglePinRow":
      return tab ? s.pinRows([tab.id], !tab.pinnedRow) : undefined;
    case "moveTabDown":
    case "moveTabUp": {
      if (!tab) return;
      const section = viewTabIds(s, windowId, tab.spaceId).filter((id) => !!s.tabs[id]?.pinned === tab.pinned);
      const at = section.indexOf(tab.id) + (command === "moveTabDown" ? 1 : -1);
      return at >= 0 && at < section.length ? s.moveTab(tab.id, at) : undefined;
    }
    case "closeTabGroup": {
      const group = groupOf(s, tabId);
      return group ? s.closeGroup(group.id) : undefined;
    }
    case "openSpaceMenu":
      return s.windows[windowId]?.incognito ? undefined : void openSpaceMenu(windowId);
    case "duplicateTab":
      return tab ? void s.duplicateTab(tab.id) : undefined;
    case "moveTabToSpace":
      return tab && arg ? void moveTabToSpace(tab.id, arg) : undefined;
    case "moveTabToWindow":
      return tab && arg ? moveTabToWindow(tab.id, arg) : undefined;
    case "bookmarkPage":
      return page ? bookmarkActivePage(windowId) : undefined;
    case "addBookmarkToFolder":
      return page && arg ? void addBookmarkToFolder(windowId, arg) : undefined;
    case "openBookmark": {
      const node = arg ? s.bookmarks.nodes[arg] : undefined;
      return node?.kind === "url" && tab ? s.navigate(tab.id, node.url) : undefined;
    }
    case "toggleMute":
      return page ? toggleMute(page.id) : undefined;
    case "newEasel":
      return newEasel(windowId);
    case "openLibrary":
      return openLibrary(windowId, arg ?? undefined);
    case "downloads":
      return s.setDownloadsOpen(windowId, !ui?.downloadsOpen);
    case "cast":
      return void toggleCastPicker(windowId);
    case "showHistory":
      return openInternalPage("history", windowId);
    case "clearBrowsingData":
      openInternalPage("history", windowId);
      return useClearDataRequest.getState().request(windowId);
    case "manageBookmarks":
      return openInternalPage("bookmarks", windowId);
    case "bookmarkAllTabs":
      return bookmarkAllTabs(windowId);
    case "mergeAllWindows":
      return s.mergeAllWindows(windowId);
    case "switchSpace":
      return arg ? switchSpace(windowId, arg, true) : undefined;
    case "nextSpace":
      return cycleSpace(windowId, 1);
    case "previousSpace":
      return cycleSpace(windowId, -1);
    case "openExtension":
      return arg ? openExtensionFromMenu(windowId, arg) : undefined;
    case "addExtension":
      return void openWebStore(windowId);
    case "pinExtensions":
      return openPinDialog(windowId);
    case "autofill":
      return void requestAutofill(windowId, arg);
    case "newSpace":
      return void createSpace(windowId).then((id) => id && switchSpace(windowId, id));
  }
}

// What Little Bay runs on its own page; everything else goes to the main window (menuState disables the tab and
// sidebar commands that make no sense from there).
const LITTLE_BAY_PAGE_COMMANDS = new Set<string>([
  "print",
  "printWithSystemDialog",
  "savePage",
  "capture",
  "captureFullPage",
  "caretBrowsing",
  "emailPageLocation",
  "stop",
  "share",
  "copyUrl",
  "copyUrlAsMarkdown",
  "findInPage",
  "findAndReplace",
  "jumpToSelection",
  "useSelectionForFind",
  "findNext",
  "findPrevious",
  "reload",
  "forceReload",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "devTools",
  "toggleDevTools",
  "inspectElements",
  "javaScriptConsole",
  "viewSource",
  "back",
  "forward",
  "bookmarkPage",
  "addBookmarkToFolder",
  "openBookmark",
  "toggleMute",
  "cast",
  "openExtension",
  "addExtension",
  "autofill",
  "reopenClosedTab",
  "restoreClosed",
  "downloads",
]);

function runLittleBayCommand(command: string, windowId: string): boolean {
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  switch (command) {
    case "closeTab":
      // A blank Little Bay (⌘⌥N, nothing typed yet) closes with its field open.
      if (s.windowUi[windowId]?.panel.open && tab?.url) s.closePanel(windowId);
      else if (tabId && s.find[tabId]?.open) closeFind(tabId);
      else closeLittleBay(windowId);
      return true;
    case "focusCommandBar":
      s.openPanel(windowId, tab?.url ?? "");
      return true;
    case "openFile":
      openInMainWindow(windowId);
      return true;
  }
  return false;
}

// A link's peek on screen (store/peeks.ts): ⌘W closes it and ⌘O keeps it as a tab, as Arc's; Little Bay's keys.
function runPeekCommand(command: string, windowId: string): boolean {
  const s = useBrowser.getState();
  if (!shownPeek(s, windowId)) return false;
  switch (command) {
    case "closeTab":
      s.closePeek(windowId);
      return true;
    case "openFile":
      const target = s.keepPeek(windowId);
      if (target) focus(target);
      return true;
  }
  return false;
}

function closeFind(tabId: string) {
  useBrowser.getState().setFind(tabId, { open: false, count: null, active: 0 });
  void webviews.get(tabId)?.stopFinding(false);
  void webviews.get(tabId)?.focus();
}

async function addBookmarkToFolder(windowId: string, folder: string) {
  const s = useBrowser.getState();
  const tabId = activeTabId(s, windowId);
  const tab = tabId ? s.tabs[tabId] : undefined;
  if (!tab?.url) return;
  const spaceId = bookmarkSpaceId(s, s.windows[windowId]);
  let parentId = folder;
  if (folder === "new") {
    const title = await prompt({ title: "New Folder", placeholder: "Folder name", confirmTitle: "Create", windowId });
    if (!title) return;
    parentId = useBrowser.getState().addBookmarkFolder({ spaceId, title });
  }
  useBrowser.getState().addBookmark({ spaceId, url: tab.url, title: tab.title, favicon: tab.favicon, parentId });
}

async function openFiles(windowId: string | null) {
  const urls = await pickFiles();
  if (!urls.length) return;
  const s = useBrowser.getState();
  const target = resolveWindowId(s, windowId);
  if (!target) return void openWindow({ url: urls[0] });
  let last: string | undefined;
  for (const url of urls) last = useBrowser.getState().newTab(target, { url });
  if (last) useBrowser.getState().activate(last, target);
}
