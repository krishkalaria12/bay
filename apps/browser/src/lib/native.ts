import { onDownload, releaseProfile } from "@bay/nncore";
import { capabilities } from "@bay/platform";
import {
  closeWindow,
  focusWindow,
  isDarkAppearance,
  onAppEvent,
  onCommand,
  onOpenURLs,
  onWindowEvent,
  openWindow,
  replyToTerminate,
  setAppearance,
  setMenuStateParts,
  setWindowTitle,
  windowIds,
  type OpenWindowOptions,
  type MenuBookmark,
  type MenuState,
} from "@bay/shell";
import { Appearance } from "react-native";
import { folderChildren, isBookmarked } from "../store/bookmarks";
import { useBrowser, type BrowserStore, type BrowserState } from "../store/browser";
import { activeTab, bookmarkSpaceId, engineProfile, IDLE_LIVE, incognitoSpaceId, tabLabel, windowTitle } from "../store/model";
import { splitOf } from "../store/splits";
import { canGoBack, canGoForward } from "../components/layout/history";
import type { Bookmarks, BookmarkNode } from "../store/types";
import { startTidyDownloadOffers } from "./tidyDownloads";
import { isUtilityWindowId } from "../components/settings/windows";
import { isInternalTab } from "../components/pages/urls";
import { sidebarMenuState } from "../components/sidebar/commands";
import { openWindow as createWindow } from "./actions";
import { openExternalUrls } from "../components/littleBay/actions";
import { startLittleBayAccess } from "../components/littleBay/access";
import { startLittleBayPutAway } from "../components/littleBay/putAway";
import { meetingToJoin } from "../live/alerts";
import { useCalendar } from "../live/calendar";
import { everySlowly } from "./slowTimers";
import { LITTLE_BAY_DISABLED_COMMANDS } from "../components/littleBay/menu";
import { runCommand } from "./commands";
import { startSidebarMoveUndoSync } from "./folderUndo";
import type { PersistenceOwner } from "./persist";
import { prepareSyncForQuit, resumeSyncAfterQuit } from "../sync/engine";
import { prepareTelemetryForQuit, resumeTelemetryAfterQuit } from "../telemetry/usage";
import { prepareApplicationQuit } from "./quitPreparation";
import { startWindowCloseGuard } from "./windowClose";
import { startExtensionsBridge } from "../components/extensions/bridge";
import { extensionMenu, useExtensions } from "../components/extensions/state";
import { createNativeWindowReconciler } from "./nativeWindows";

let quitting = false;
let quitAttempt = 0;
export const isQuitting = () => quitting;

export function startNativeSync({
  persistence,
  store = useBrowser,
  shared = false,
}: {
  persistence: Pick<PersistenceOwner, "flush" | "resume">;
  store?: BrowserStore;
  shared?: boolean;
}) {
  const stops: (() => void)[] = [];
  let disposed = false;
  if (!store.getState().windowOrder.length) store.getState().createWindow();

  if (!shared) {
    const commands = onCommand(runCommand);
    stops.push(() => commands.remove());
    stops.push(startSidebarMoveUndoSync());
    stops.push(startWindowCloseGuard());
    startExtensionsBridge();
    if (store === useBrowser) {
      startLittleBayAccess();
      startLittleBayPutAway();
    }
  }
  const urls = onOpenURLs(openExternalUrls);
  const downloads = onDownload((d) => store.getState().upsertDownload(d));
  stops.push(
    () => urls.remove(),
    () => downloads.remove(),
  );
  stops.push(startTidyDownloadOffers(store));

  store.getState().setAppDark(Appearance.getColorScheme() === "dark");
  void setAppearance(store.getState().settings.appearance);
  void isDarkAppearance().then((dark) => {
    if (!disposed) store.getState().setAppDark(dark);
  });

  const appEvents = onAppEvent((e) => {
    const s = store.getState();
    if (e.type === "appearance") s.setAppDark(e.dark);
    if (e.type === "reopen") createWindow();
    if (e.type === "quitWarningSuppressed") s.updateSettings({ warnBeforeQuitting: false });
    if (e.type === "willQuit") {
      quitting = true;
      const attempt = ++quitAttempt;
      const isCurrent = () => quitting && attempt === quitAttempt;
      void prepareApplicationQuit({
        isCurrent,
        prepareSync: prepareSyncForQuit,
        flushSession: () => persistence.flush({ final: true }),
        // The service owner acknowledges Live alongside session/downloads.
        flushLive: () => Promise.resolve(),
        flushTelemetry: prepareTelemetryForQuit,
      })
        .then(
          (prepared) => {
            if (prepared && isCurrent()) return replyToTerminate(true);
          },
          (error) => {
            console.error("Couldn't save app data before quitting", error);
            if (isCurrent()) return replyToTerminate(false);
          },
        )
        .catch((error) => console.error("Couldn't reply to app shutdown", error));
    }
    if (e.type === "quitCancelled") {
      quitting = false;
      quitAttempt++;
      resumeSyncAfterQuit();
      persistence.resume();
      void resumeTelemetryAfterQuit().catch((error) => console.error("Couldn't restore telemetry after cancelled quit", error));
    }
  });

  const windowEvents = onWindowEvent((e) => {
    const s = store.getState();
    if (e.type === "focus") s.setFocusedWindow(e.id);
    if (e.type === "frame") s.setWindowFrame(e.id, e.frame);
    if (e.type === "close") {
      if (quitting) return;
      windows.nativeClosed(e.id);
      s.closeWindow(e.id);
    }
  });

  stops.push(
    () => appEvents.remove(),
    () => windowEvents.remove(),
  );

  const windows = createNativeWindowReconciler<OpenWindowOptions>({
    open: openWindow,
    close: closeWindow,
    setTitle: setWindowTitle,
    focus: focusWindow,
    openFailed: (id) => store.getState().closeWindow(id),
    closed: (id, options) => {
      if (options.incognito) void releaseProfile(incognitoSpaceId(id));
    },
    report: (operation, id, error) => console.error(`Couldn't ${operation} window ${id}`, error),
  });

  const syncWindows = (s: BrowserState, prev?: BrowserState) => {
    if (
      prev &&
      s.tabs === prev.tabs &&
      s.tabLists === prev.tabLists &&
      s.windows === prev.windows &&
      s.spaces === prev.spaces &&
      s.ui.focusedWindowId === prev.ui.focusedWindowId
    )
      return;
    // Dispatch the focused window last so it comes to front.
    const focused = s.ui.focusedWindowId;
    const order = s.windowOrder.filter((id) => id !== focused);
    if (focused && s.windows[focused]) order.push(focused);
    windows.sync(
      order.map((id) => {
        const w = s.windows[id]!;
        const title = windowTitle(s, id);
        const profile = engineProfile(w.spaceId);
        const small = w.kind === "small" ? { kind: "small" as const, size: s.settings.littleBaySize } : {};
        return { id, title, options: { frame: w.frame, incognito: w.incognito, title, focus: id === focused, profile, ...small } };
      }),
      focused,
    );
  };

  let lastMenu = "";
  let lastBookmarkMenus: unknown[] = [];
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  const syncMenu = () => {
    menuTimer = undefined;
    if (!capabilities.menuBar) return;
    const state = menuState(store.getState());
    // The bookmark menus are cached per bookmarks tree (bookmarkMenus), so they compare by identity;
    // stringifying them (thousands of bookmarks) on every store change is what this sync used to spend.
    const { bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks, ...rest } = state;
    const bookmarkMenus = [bookmarkFolders, recentBookmarks, bookmarksBar, otherBookmarks];
    const json = JSON.stringify(rest);
    const bookmarksChanged = !bookmarkMenus.every((menu, i) => menu === lastBookmarkMenus[i]);
    if (json === lastMenu && !bookmarksChanged) return;
    lastMenu = json;
    lastBookmarkMenus = bookmarkMenus;
    void setMenuStateParts(state, bookmarksChanged);
  };

  // The windows open now, without first asking which exist: that answer comes from the main thread, which Chrome's
  // startup holds, and waiting for it put 20–100 ms before the first frame. Opening one that exists (after a JS reload)
  // only brings it forward; the ones the store doesn't have close when the answer comes.
  if (!shared) syncWindows(store.getState());
  syncMenu();
  stops.push(
    store.subscribe((s, prev) => {
      if (!shared) syncWindows(s, prev);
      if (capabilities.menuBar) menuTimer ??= setTimeout(syncMenu, 120);
    }),
  );
  stops.push(
    store.subscribe((s, prev) => {
      if (s.settings.appearance !== prev.settings.appearance) void setAppearance(s.settings.appearance);
    }),
  );
  stops.push(
    useExtensions.subscribe((e, prev) => {
      if (capabilities.menuBar && e.lists !== prev.lists) menuTimer ??= setTimeout(syncMenu, 120);
    }),
  );
  stops.push(
    useCalendar.subscribe((c, prev) => {
      if (capabilities.menuBar && c.events !== prev.events) menuTimer ??= setTimeout(syncMenu, 120);
    }),
  );
  stops.push(
    everySlowly({
      every: 30_000,
      run: () => void (menuTimer ??= setTimeout(syncMenu, 120)),
      needed: () => capabilities.menuBar && useCalendar.getState().events.length > 0,
      watch: (changed) => useCalendar.subscribe(changed),
    }),
  );
  if (!shared)
    void windowIds().then((ids) => {
      if (disposed) return;
      const s = store.getState();
      for (const id of ids) {
        if (!s.windows[id]) {
          if (!isUtilityWindowId(id)) void closeWindow(id);
          continue;
        }
        // One that already existed kept the title it had (openWindow leaves it be): send the current one.
        const title = windowTitle(s, id);
        void setWindowTitle(id, title);
      }
    });
  return {
    async reconcile(state: BrowserState) {
      if (disposed) return;
      syncWindows(state);
      await windows.flush();
    },
    dispose() {
      disposed = true;
      clearTimeout(menuTimer);
      windows.dispose();
      for (const stop of stops.reverse()) stop();
    },
  };
}

const PAGE_COMMANDS = [
  "reload",
  "forceReload",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "print",
  "devTools",
  "toggleDevTools",
  "findInPage",
  "findNext",
  "findPrevious",
  "useSelectionForFind",
  "copyUrl",
  "copyUrlAsMarkdown",
  "bookmarkPage",
  "addBookmarkToFolder",
  "toggleMute",
  "findAndReplace",
  "jumpToSelection",
  "viewSource",
  "javaScriptConsole",
  "inspectElements",
  "savePage",
  "capture",
  "captureFullPage",
  "capturePortrait",
  "newBoost",
  "editBoost",
  "zapElements",
  "toggleSiteBoosts",
  "emailPageLocation",
  "printWithSystemDialog",
  "stop",
  "caretBrowsing",
];
const INTERNAL_PAGE_COMMANDS = ["copyUrl", "copyUrlAsMarkdown", "bookmarkPage", "addBookmarkToFolder"];
const WINDOW_COMMANDS = [
  ...PAGE_COMMANDS,
  "focusCommandBar",
  "closeTab",
  "closeAllTabs",
  "back",
  "forward",
  "nextTab",
  "previousTab",
  "togglePin",
  "togglePinRow",
  "duplicateTab",
  "moveTabToSpace",
  "moveTabToWindow",
  "toggleSidebar",
  "downloads",
  "newEasel",
  "openLibrary",
  "mergeAllWindows",
  "switchSpace",
  "nextSpace",
  "previousSpace",
  "openBookmark",
  "selectTab",
  "selectLastTab",
  "moveTabDown",
  "moveTabUp",
  "closeTabGroup",
  "openSpaceMenu",
];

function menuBookmarks(b: Bookmarks, folderId: string, depth = 0): MenuBookmark[] {
  return folderChildren(b, folderId).map((n: BookmarkNode) =>
    n.kind === "url"
      ? { id: n.id, title: n.title || n.url, url: n.url }
      : { id: n.id, title: n.title, children: depth < 6 ? menuBookmarks(b, n.id, depth + 1) : [] },
  );
}

type BookmarkMenus = Pick<MenuState, "bookmarkFolders" | "recentBookmarks" | "bookmarksBar" | "otherBookmarks">;
const bookmarkMenuCache = new WeakMap<Bookmarks, Map<string, BookmarkMenus>>();

function bookmarkMenus(b: Bookmarks, spaceId: string): BookmarkMenus {
  let perProfile = bookmarkMenuCache.get(b);
  if (!perProfile) bookmarkMenuCache.set(b, (perProfile = new Map()));
  const cached = perProfile.get(spaceId);
  if (cached) return cached;
  const roots = b.roots[spaceId];
  const menus: BookmarkMenus = roots
    ? {
        bookmarkFolders: [
          { id: roots.bar, title: "Bookmarks Bar" },
          { id: roots.other, title: "Other Bookmarks" },
          ...[...folderChildren(b, roots.bar), ...folderChildren(b, roots.other)].filter((n) => n.kind === "folder").map((n) => ({ id: n.id, title: n.title })),
        ],
        recentBookmarks: Object.values(b.nodes)
          .filter((n): n is Extract<BookmarkNode, { kind: "url" }> => n.kind === "url" && isInTree(b, n.id, [roots.bar, roots.other]))
          .sort((x, y) => y.addedAt - x.addedAt)
          .slice(0, 5)
          .map((n) => ({ id: n.id, title: n.title || n.url, url: n.url })),
        bookmarksBar: menuBookmarks(b, roots.bar),
        otherBookmarks: menuBookmarks(b, roots.other),
      }
    : { bookmarkFolders: [], recentBookmarks: [], bookmarksBar: [], otherBookmarks: [] };
  perProfile.set(spaceId, menus);
  return menus;
}

export function menuState(s: BrowserState): MenuState {
  const windowId = s.ui.focusedWindowId && s.windows[s.ui.focusedWindowId] ? s.ui.focusedWindowId : undefined;
  const w = windowId ? s.windows[windowId] : undefined;
  const tab = windowId ? activeTab(s, windowId) : undefined;
  const live = tab ? s.live[tab.id] : undefined;
  const bookmarkProfile = bookmarkSpaceId(s, w);
  const regularWindows = s.windowOrder.filter((id) => !s.windows[id]!.incognito && s.windows[id]!.kind !== "small");

  const disabled: string[] = [];
  if (!tab || !splitOf(s, tab.id)) disabled.push("focusNextPane", "focusPreviousPane", "removeFromSplit");
  if (w && (w.tabLayout ?? s.settings.tabLayout) === "top") disabled.push("toggleAddressBar");
  if (!w) disabled.push(...WINDOW_COMMANDS, "toggleTabLayout", "openSplitPane");
  else {
    if (!tab?.url) disabled.push(...PAGE_COMMANDS);
    else if (isInternalTab(tab)) disabled.push(...PAGE_COMMANDS.filter((c) => !INTERNAL_PAGE_COMMANDS.includes(c)));
    if (!tab || !canGoBack(tab.id, live ?? IDLE_LIVE)) disabled.push("back");
    if (!tab || !canGoForward(tab.id, live ?? IDLE_LIVE)) disabled.push("forward");
    if (!live?.isLoading) disabled.push("stop");
    if (w.incognito) disabled.push("moveTabToSpace", "moveTabToWindow", "switchSpace", "nextSpace", "previousSpace");
    else if (tab) disabled.push(`moveTabToSpace:${tab.spaceId}`);
    if (regularWindows.length < 2) disabled.push("mergeAllWindows");
  }
  if (!s.closedTabs.length && !s.closedWindows.length && !s.closedGroups.length) disabled.push("reopenClosedTab");
  if (!s.closedWindows.length) disabled.push("reopenClosedWindow");

  const checked = [`setAppearance:${s.settings.appearance}`];
  if (s.settings.showFullUrl) checked.push("toggleFullUrl");
  if (s.settings.addressBar === "sidebar") checked.push("toggleAddressBar");
  if (s.settings.sidebarPosition === "right") checked.push("toggleSidebarPosition");
  checked.push(`setBookmarksBar:${s.settings.bookmarksBar}`);
  if ((w?.tabLayout ?? s.settings.tabLayout) === "sidebar") checked.push("toggleTabLayout");
  if (w && !w.sidebarOpen) checked.push("toggleSidebar");

  const titles: Record<string, string> = {};
  if (tab?.pinned) titles.togglePin = "Remove from Essentials";
  if (tab?.pinnedRow) titles.togglePinRow = "Unpin Tab";
  if (tab?.muted) titles.toggleMute = "Unmute Site";
  if (tab?.url && isBookmarked(s.bookmarks, bookmarkProfile, tab.url)) {
    titles.bookmarkPage = "Edit Bookmark…";
  }

  if (!s.settings.openLinksInLittleBay) titles.toggleOpenLinksInLittleBay = "Open Links from Other Apps in Little Bay";
  const meeting = meetingToJoin();
  if (meeting) titles.joinMeeting = `Join “${meeting.title || "Untitled event"}”`;
  else disabled.push("joinMeeting");

  const sidebar = sidebarMenuState(s, windowId);
  disabled.push(...sidebar.disabled);
  Object.assign(titles, sidebar.titles);
  if (w?.kind === "small") {
    disabled.push(...LITTLE_BAY_DISABLED_COMMANDS);
    // ⌘O is Open File in a main window and Open in Bay in Little Bay, as in Little Arc.
    titles.openFile = "Open in Bay";
  }

  const closed = [
    ...s.closedTabs.filter((c) => !c.tab.spaceId.startsWith("incognito:")).map((c) => ({ id: c.id, title: c.tab.title || tabLabel(c.tab), at: c.closedAt })),
    ...s.closedWindows.map((c) => ({ id: c.id, title: c.tabs.length === 1 ? "Window (1 Tab)" : `Window (${c.tabs.length} Tabs)`, at: c.closedAt })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 10)
    .map(({ id, title }) => ({ id, title }));

  return {
    checked,
    disabled,
    titles,
    spaces: s.spaceOrder.map((id) => ({ id, title: s.spaces[id]!.name, current: w?.spaceId === id })),
    windows: w?.incognito ? [] : regularWindows.filter((id) => id !== windowId).map((id) => ({ id, title: windowTitle(s, id) })),
    ...bookmarkMenus(s.bookmarks, bookmarkProfile),
    recentlyClosed: closed,
    recentlyClosedGroups: sidebar.recentlyClosedGroups,
    warnBeforeQuitting: s.settings.warnBeforeQuitting,
    warnBeforeClosingWindow: s.settings.warnBeforeClosingWindow,
    downloadsInProgress: s.downloads.filter((d) => d.state === "downloading").length,
    shortcuts: s.settings.shortcuts,
    extensions: extensionMenu(s, windowId),
  };
}

function isInTree(b: Bookmarks, id: string, roots: string[]): boolean {
  let node = b.nodes[id];
  for (let i = 0; node && i < 64; i++) {
    if (roots.includes(node.id)) return true;
    node = node.parentId ? b.nodes[node.parentId] : undefined;
  }
  return false;
}
