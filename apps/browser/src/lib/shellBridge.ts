import { type MenuBookmark, type MenuState } from "@bay/desktop";
import { Appearance } from "react-native";
import { folderChildren, isBookmarked } from "../store/bookmarks";
import { useBrowser, type BrowserState, type BrowserStore } from "../store/browserStore";
import { activeTab, bookmarkSpaceId, IDLE_LIVE, tabLabel, windowTitle } from "../store/model";
import { pinnableSplit, pinRowTitle, splitOf } from "../store/splits";
import { canGoBack, canGoForward } from "../components/window/historyMenu";
import type { Bookmarks, BookmarkNode } from "../store/types";
import { startTidyDownloads } from "./tidyDownloads";
import { isInternalTab } from "../components/pages/pageUrls";
import { sidebarMenuState } from "../components/sidebar/sidebarCommands";
import { openWindow as createWindow } from "./actions";
import { openExternalUrls } from "../components/littleBay/actions";
import { meetingToJoin } from "../activity/meetingAlerts";
import { LITTLE_BAY_DISABLED_COMMANDS } from "../components/littleBay/menu";
import { runCommand } from "./appCommands";
import { startSidebarMoveUndoSync } from "./folderUndo";
import { beginQuit, cancelQuit } from "./quit";
import { startWindowCloseGuard } from "./windowClose";
import { startExtensionsBridge } from "../components/extensions/bridge";
import { extensionMenu } from "../components/extensions/state";
import { runtimeForStore, type ApplicationRuntime } from "../effect/runtime";
import { captureException } from "../telemetry/errors";
import * as Effect from "effect/Effect";
import { ShellService, type Shell, type ShellHandlers } from "./shellService";
import type { PersistenceOwner } from "./persist";

export { isQuitting } from "./quit";

/**
 * Starts the shell: the native listeners are registered and the native chrome is kept in step with the app.
 *
 * The runtime owns the service: this module only hands it the app's own handlers.
 */
const startShell = (runtime: ApplicationRuntime, handlers: ShellHandlers): Promise<Shell> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const shell = yield* ShellService;

      yield* shell.start(handlers);

      return shell;
    }),
  );

/** The native chrome, as the coordinator reaches it. */
export type NativeSync = {
  /** Brings the native windows in step with an accepted state. */
  reconcile(state: BrowserState): Promise<void>;
  /** Gives the native listeners back. */
  dispose(): void;
};

/**
 * Starts the app's native wiring for one store: the listeners, the native windows, and the quit handshake.
 *
 * A shared window leaves the app's own wiring to the coordinator that owns the document: it starts the commands and
 * the extensions bridge itself, and it hands this the store the native chrome follows.
 */
export function startNativeSync({
  persistence,
  store = useBrowser,
  shared = false,
}: {
  /** The saving the quit handshake flushes. The app's own saving is used when there is none. */
  persistence?: Pick<PersistenceOwner, "flush" | "resume">;
  store?: BrowserStore;
  shared?: boolean;
} = {}): NativeSync {
  if (!store.getState().windowOrder.length) store.getState().createWindow();

  // The app's own wiring: the sidebar's undo, the window that asks before it closes and the extensions. It stays
  // here, and it stays synchronous. Little Bay's put-away and shortcut are its service's (startAppServices).
  if (!shared) {
    startSidebarMoveUndoSync();
    startWindowCloseGuard();
    startExtensionsBridge();
  }

  const stopDownloads = startTidyDownloads(store);

  // The app's own appearance: the Mac is asked about it, and told what the app wants.
  store.getState().setAppDark(Appearance.getColorScheme() === "dark");

  // The native listeners are the shell's: it registers them once, in its own scope, and gives them back when it
  // is given back. This only hands it the app's own handlers.
  const runtime = runtimeForStore(store);

  const shell = startShell(runtime, {
    command: runCommand,
    appEvent: (event) => {
      const s = store.getState();

      if (event.type === "appearance") s.setAppDark(event.dark);

      if (event.type === "reopen") createWindow();

      if (event.type === "quitWarningSuppressed") s.updateSettings({ warnBeforeQuitting: false });

      // The quit handshake: the app saves what it has and answers, and keeps running when the user calls it off.
      if (event.type === "willQuit") void beginQuit(persistence).catch((error) => console.error("Couldn't reply to app shutdown", error));

      if (event.type === "quitCancelled") cancelQuit(persistence);
    },
    openURLs: openExternalUrls,
    menu: menuState,
  });

  void shell.catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));

    captureException(error, "console");
    console.error("The native shell could not start", error);
  });

  return {
    reconcile: (state) => shell.then((service) => runtime.runPromise(service.reconcile(state))),
    dispose: () => {
      stopDownloads();
      void shell
        .then((service) => Effect.runPromise(service.stop))
        .catch((error) => {
          console.error("Couldn't stop the native shell", error);
        });
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
          ...[...folderChildren(b, roots.bar), ...folderChildren(b, roots.other)].flatMap((n) => (n.kind === "folder" ? [{ id: n.id, title: n.title }] : [])),
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

  if (tab?.pinnedRow || (tab && pinnableSplit(s, tab.id))) titles.togglePinRow = pinRowTitle(s, tab.id);

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
