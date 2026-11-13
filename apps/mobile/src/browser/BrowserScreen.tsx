import { cleanUrl } from "@bay/core/src/cleanUrl.ts";
import { hostOf } from "@bay/core/src/input.ts";
import { clearData, privateBrowsingSupported, saveImage, type LinkPress, type NavigationState, type PageRequest, type PageScroll, type Tab } from "@bay/engine";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import * as Clipboard from "expo-clipboard";
import * as LocalAuthentication from "expo-local-authentication";
import { StatusBar } from "expo-status-bar";
import { useThemeColor } from "heroui-native";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { AppState, BackHandler, Keyboard, Platform, Pressable, Share, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";

import { BrowserBar } from "@/chrome/BrowserBar";
import { tick } from "@/chrome/haptics";
import { Icon } from "@/chrome/Icon";
import { hiddenFromScreenReaders } from "@/chrome/screenReader";
import { Text } from "@/chrome/Text";
import { iconSize, space } from "@/chrome/tokens";
import { crashReportText, crashReports } from "@/crashReports";
import { runCommand } from "@/effect/commands";
import { Diagnostics } from "@/effect/ports/diagnostics";
import { Engine } from "@/effect/ports/engine";
import { Lifecycle } from "@/effect/ports/lifecycle";
import { useCommand } from "@/effect/react";
import { useT, type Translate } from "@/i18n";
import { ArchivePanel, LinkMenu, PageMenu, SettingsPanel, SiteSettingsPanel, TabsMenu } from "@/panels";
import { DownloadsPanel } from "@/panels/DownloadsPanel";
import { HistoryPanel } from "@/panels/HistoryPanel";
import { ImportPanel } from "@/panels/ImportPanel";
import { useSheetOpen } from "@/panels/openSheets";
import { PageRequestPanel } from "@/panels/PageRequest";
import { youtubeSelectors } from "@/pagescripts/youtube";
import { parseImagePress } from "@/pagescripts/images";
import { useBlockerStatus, type BlockerStatus } from "@/privacy/contentBlocking";
import { newId, useBrowserStore } from "@/store/browser";
import { siteSettingFor, type SiteSetting } from "@/store/model";
import type { BrowserTab } from "@/store/types";
import { engineFor, isWebURL, SEARCH_ENGINES } from "./address";
import { Logins } from "./credentials";
import { originOf } from "./logins";
import { PrivateLock } from "./PrivateLock";
import { SearchCard, type OpenTarget } from "./SearchCard";
import { ON_PHOTO_MUTED, StartPage } from "./StartPage";
import { TabPage } from "./TabPage";
import { TabSwitcher } from "./TabSwitcher";
import { TabSwipe } from "./TabSwipe";
import { TabZoom, type Frame } from "./TabZoom";
import { Wallpaper } from "./Wallpaper";
import { FindBar } from "./FindBar";
import { Favicons } from "./favicons";
import type { ImportedTab } from "./importTabs";
import { IncomingLinks } from "./incoming";
import { bayCommand, incomingLink, type BayCommand } from "./incomingLink";
import { sameNavigation } from "./navigationEvents";
import { Snapshots } from "./snapshots";
import { MiniPlayer } from "./MiniPlayer";
import { PageError } from "./PageError";
import { Toast, useToast } from "./Toast";
import { DownloadToast, useDownloads } from "./useDownloads";
import { useFindInPage } from "./useFindInPage";
import { useReadingTools } from "./useReadingTools";
import { useTabMedia } from "./useTabMedia";

// Live page views kept in memory; other tabs reload from their address when opened.
const MAX_LIVE = 4;
const BAR_HEIGHT = 52;
const views = new Map<string, Tab>();
const visited = new Map<string, string>();

// Tabs whose current load failed: the engine shows its own error document, whose title and snapshot aren't the page's.
const failed = new Set<string>();

// Work tied to a tab's current page, like a silent sign-in waiting on the secure store. It ends when the tab loads
// again or its view goes, because the engine cancels the page's requests then.
const tabWork = new Map<string, Scope.Closeable>();

/** Runs a program for a tab's current page: a new load or a closed tab interrupts it. */
function runForTab(tabId: string, name: string, program: Effect.Effect<void, never, Logins>): void {
  let scope = tabWork.get(tabId);

  if (!scope) {
    scope = Effect.runSync(Scope.make());
    tabWork.set(tabId, scope);
  }

  runCommand({ name, resource: tabId }, Effect.flatMap(Effect.forkIn(program, scope), Fiber.join));
}

/** Ends the work tied to a tab's page. */
function endTabWork(tabId: string): void {
  const scope = tabWork.get(tabId);

  if (!scope) return;

  tabWork.delete(tabId);
  void Effect.runPromise(Scope.close(scope, Exit.void));
}

type Overlay = "none" | "search" | "tabs";

type Panel = "archive" | "settings" | "page" | "site" | "downloads" | "tabs" | "history" | "import" | null;

const blankNavigation: NavigationState = { url: "", title: "", progress: 0, isLoading: false, canGoBack: false, canGoForward: false };

export function BrowserScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const t = useT();
  const muted = useThemeColor("muted");
  // An open sheet is modal for screen readers: the browser behind it steps out of their way. Toasts stay, since they
  // answer what was done in the sheet.
  const behindSheet = hiddenFromScreenReaders(useSheetOpen());

  const {
    ready,
    data,
    dispatch,
    openTab,
    closeTab,
    restoreTab,
    reset,
    importTabs,
    selectSpace,
    createSpace,
    renameSpace,
    deleteSpace,
    moveTab,
    newFolder,
    renameFolder,
    deleteFolder,
  } = useBrowserStore();

  const [live, setLive] = useState<string[]>([]);
  const [navigation, setNavigation] = useState<Record<string, NavigationState>>({});
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [searchInNewTab, setSearchInNewTab] = useState(false);
  const [searchPrivately, setSearchPrivately] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [link, setLink] = useState<LinkPress | null>(null);
  // Dialogs pages are waiting on (`alert`/`confirm`/`prompt`, I3), in the order they asked; the engine holds each
  // page paused until its answer goes back, so they queue rather than replace each other.
  const [pageRequests, setPageRequests] = useState<Array<{ tabId: string; request: PageRequest }>>([]);
  const pageRequest = pageRequests[0] ?? null;
  // A main-frame load failure, shown in place of that tab's page.
  const [error, setError] = useState<{ tabId: string; url: string; message: string } | null>(null);
  const toast = useToast();
  const [locked, setLocked] = useState(false);
  // Each tab's colour at the top of its page, so the strip behind the status bar continues the page.
  const [pageColors, setPageColors] = useState<Record<string, [number, number, number] | null>>({});
  // Tabs whose video is fullscreen (A2, Android): chrome stays hidden until it reports leaving fullscreen.
  const [fullscreenByTab, setFullscreenByTab] = useState<Record<string, boolean>>({});
  // The tab open before this one, for Arc's drag up on Tabs; activating a tab makes the one it left the last.
  const lastTab = useRef<string | null>(null);
  // A card in the switcher, growing into the page it stands for (A1).
  const [zoom, setZoom] = useState<{ tab: BrowserTab; frame: Frame } | null>(null);
  const barHidden = useSharedValue(0);

  const active = data.tabs.find((tab) => tab.id === data.activeTabId) ?? data.tabs[0]!;
  const spaceTabs = data.tabs.filter((tab) => tab.spaceId === data.activeSpaceId);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const switcherTabs = spaceTabs.filter((tab) => !activeFolderId || tab.folderId === activeFolderId);
  const page = navigation[active.id] ?? { ...blankNavigation, url: active.url, title: active.title };
  const hasPage = Boolean(active.url);
  const engine = engineFor(data.preferences.searchEngineId);
  const existing = new Set(data.tabs.map((tab) => tab.id));
  // A search for a new tab opens over the wallpaper, like the switcher it came from.
  const showPages = overlay === "none" || (overlay === "search" && !searchInNewTab);
  const media = useTabMedia({ tabs: data.tabs, views, onScreenTabId: showPages && hasPage ? active.id : null, locked });
  // A tab playing media stays mounted, so its sound doesn't stop when other tabs are opened.
  const playing = media.playingTabIds.filter((id) => existing.has(id));
  const mounted = [...new Set([active.id, ...playing, ...live.filter((id) => existing.has(id))])].slice(0, MAX_LIVE);
  const mountedKey = mounted.join(" ");
  const { blockContent, blockingPausedHosts, lockPrivateTabs } = data.preferences;
  const hasPrivateTabs = data.tabs.some((tab) => tab.private);
  const lockEnabled = lockPrivateTabs && hasPrivateTabs;

  const { theme, startPageAfterHours } = data.preferences;
  useEffect(() => {
    Uniwind.setTheme(theme);
  }, [theme]);

  // Back after a long time away (or launched again after it): a fresh start page, like a new day. Tabs stay in the
  // switcher. The time Bay left is saved, since the system usually ends Bay in the background before then.
  const startFresh = useRef<() => void>(() => {});
  startFresh.current = () => {
    const { data: current } = useBrowserStore.getState();

    if (startPageAfterHours === null || current.leftAt === null) return;

    if (Date.now() - current.leftAt < startPageAfterHours * 60 * 60 * 1000) return;

    if (current.tabs.find((tab) => tab.id === current.activeTabId)?.url === "") return;
    const empty = current.tabs.find((tab) => !tab.url && !tab.private);

    if (empty) dispatch({ type: "activate-tab", id: empty.id, now: Date.now() });
    else openTab("");
    setOverlay("none");
    setPanel(null);
    setLink(null);
  };

  useEffect(() => {
    if (ready) startFresh.current();
  }, [ready]);
  // Leaving the foreground and coming back, heard through the app's one lifecycle registration. The screen joins it
  // once the saved tabs are in, after the store's own handler, so each change is handled in the order it always was.
  const { run: runLifecycleWork } = useCommand();
  useEffect(() => {
    if (!ready) return;

    runLifecycleWork(
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle;
        const engine = yield* Engine;
        const diagnostics = yield* Diagnostics;
        // Each save starts inside the native callback, before Bay is suspended.
        const run = yield* FiberSet.makeRuntime<never>();

        yield* lifecycle.onChange((state) => {
          if (state === "active") {
            startFresh.current();

            return;
          }

          // The system may end Bay while it is in the background: keep each page's history, scroll and form text. A
          // page that can't be saved reopens from its address, so a failure is only worth a warning.
          for (const view of views.values()) {
            run(
              engine
                .saveState(view)
                .pipe(
                  Effect.catch((error) =>
                    diagnostics.warn(`Couldn't save a page's state: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`),
                  ),
                ),
            );
          }
        });
      }),
    );
  }, [ready, runLifecycleWork]);
  const blockerStatus = useBlockerStatus((state) => state.status);

  // Private tabs lock as soon as Bay leaves the foreground, which also keeps them out of the app switcher.
  useEffect(() => {
    if (!lockEnabled) {
      setLocked(false);

      return;
    }

    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setLocked(true);
    });

    return () => subscription.remove();
  }, [lockEnabled]);

  // Links from other apps (B9, B14): the default browser hands Bay whole web addresses. The app listens for them and
  // keeps one that launched Bay until the saved tabs load; the screen opens each as it is handed over, with the
  // newest of its own handlers.
  const openIncoming = useRef<(url: string) => void>(() => {});
  openIncoming.current = openIncomingLink;
  const { run: listenForLinks } = useCommand<never, never>();

  useEffect(() => {
    listenForLinks(IncomingLinks.use((incoming) => incoming.receive((url) => openIncoming.current(url))));
  }, [listenForLinks]);

  async function authenticate(): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: t("lock.prompt") });

    return result.success;
  }

  useEffect(() => {
    media.keepOnly(new Set(mountedKey.split(" ")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedKey]);

  useEffect(() => {
    setLive(mountedKey.split(" "));
    barHidden.value = withTiming(0);
  }, [mountedKey, barHidden]);

  const showToast = toast.show;
  const fail = useCallback((_tabId: string, cause: unknown) => showToast(cause instanceof Error ? cause.message : t("toast.somethingWrong")), [showToast, t]);

  const downloads = useDownloads((message) => toast.show(message));
  // The download toast rides on the bottom bar, so a download started (or finished) while the bar is scrolled away
  // brings it back; otherwise the tap looks like it did nothing.
  const downloadToastKey = downloads.toast ? `${downloads.toast.id} ${downloads.toast.state}` : null;
  useEffect(() => {
    if (downloadToastKey) barHidden.value = withTiming(0, { duration: 180 });
  }, [downloadToastKey, barHidden]);
  const find = useFindInPage(views.get(active.id), `${active.id} ${active.url}`);
  const reading = useReadingTools(active, views.get(active.id), page.isLoading, locked && Boolean(active.private), (cause) => fail(active.id, cause));

  /** Takes the tab's picture for the switcher now. Snapshots skips private tabs and failed pages. */
  function capture(tabId: string): void {
    const view = views.get(tabId);

    if (!view) return;
    runCommand(
      { name: "snapshots.capture", resource: tabId },
      Effect.gen(function* () {
        yield* (yield* Snapshots).capture(tabId, view, () => failed.has(tabId));
      }),
    );
  }

  function onNavigation(tabId: string, state: NavigationState): void {
    // Hidden tabs report progress too; the screen only renders when something it shows changes.
    setNavigation((previous) => {
      const before = previous[tabId];

      return before && sameNavigation(before, state, tabId !== active.id) ? previous : { ...previous, [tabId]: state };
    });
    const started = state.isLoading && !navigation[tabId]?.isLoading;

    if (started) {
      // A new document has no media until it reports some.
      media.loadStarted(tabId);
      // The engine cancels a pending dialog when a tab loads, so its sheet goes with it, and so does a sign-in lookup.
      endTabWork(tabId);
      setPageRequests((previous) => (previous.some((entry) => entry.tabId === tabId) ? previous.filter((entry) => entry.tabId !== tabId) : previous));
      failed.delete(tabId);
      setError((current) => (current?.tabId === tabId ? null : current));
    }

    if (state.blank) return dispatch({ type: "update-tab", id: tabId, update: { url: "", title: "" } });

    if (!isWebURL(state.url)) return;

    if (failed.has(tabId)) return dispatch({ type: "update-tab", id: tabId, update: { url: state.url } });
    dispatch({ type: "update-tab", id: tabId, update: { url: state.url, ...(state.title ? { title: state.title } : undefined) } });

    // Private pages stay out of history.
    if (data.tabs.find((tab) => tab.id === tabId)?.private) return;

    if (state.title && visited.get(tabId) === state.url) dispatch({ type: "page-title", url: state.url, title: state.title });

    if (!state.isLoading && visited.get(tabId) !== state.url) {
      visited.set(tabId, state.url);
      dispatch({ type: "visit", url: state.url, title: state.title, favicon: null, now: Date.now() });
      const view = views.get(tabId);

      // The site's icon, and the tab's picture once the page has drawn: a newer visit replaces the picture.
      if (view) {
        runCommand(
          { name: "page.visited", resource: tabId },
          Effect.gen(function* () {
            yield* (yield* Favicons).fetch(view, state.url);
            yield* (yield* Snapshots).visited(tabId, view, () => failed.has(tabId));
          }),
        );
      }
    }
  }

  function onScroll(tabId: string, { offsetY, deltaY }: PageScroll): void {
    if (tabId !== active.id || reading.picking) return;

    if (offsetY < 24 || deltaY < -8) barHidden.value = withTiming(0, { duration: 180 });
    else if (deltaY > 8) barHidden.value = withTiming(1, { duration: 220 });
  }

  function navigate(tabId: string, url: string): void {
    dispatch({ type: "update-tab", id: tabId, update: { url } });
    views
      .get(tabId)
      ?.load(url)
      .catch((cause: unknown) => fail(tabId, cause));
  }

  function activate(id: string): void {
    if (id !== data.activeTabId && data.tabs.some((tab) => tab.id === id)) lastTab.current = data.activeTabId;
    dispatch({ type: "activate-tab", id, now: Date.now() });
    setOverlay("none");
  }

  // Drag up on Tabs toggles back to the tab that was open before this one.
  function lastOpenTab(): void {
    const id = lastTab.current;

    if (!id || !data.tabs.some((tab) => tab.id === id)) return;
    tick();
    activate(id);
  }

  function open(target: OpenTarget, privately: boolean): void {
    Keyboard.dismiss();
    setOverlay("none");

    if (target.kind === "tab") return activate(target.id);

    if (target.kind === "archived") return void restoreTab(target.id);
    // The current tab takes the page unless the search was for a new tab, or private mode changed.
    const reuse = (!searchInNewTab || !hasPage) && Boolean(active.private) === privately;

    if (reuse) return navigate(active.id, target.url);
    const emptyTab = hasPage ? null : active.id;
    openTab(target.url, false, privately);

    if (emptyTab) closeTab(emptyTab);
  }

  // Quick actions and the search widget (B15) hand their `bay://` commands to the same desk as incoming links (B9):
  // a fresh tab, a private tab, or the search card over the current tab, exactly as the bar and the tabs menu open
  // them. A private tab here is a private tab or nothing: the menus don't offer one the engine can't keep private.
  function openIncomingCommand(command: Exclude<BayCommand, "search">): void {
    setOverlay("none");
    setPanel(null);
    setLink(null);

    if (command === "new-tab") openTab("");
    else if (privateBrowsingSupported) openTab("", false, true);
  }

  function openIncomingLink(incomingUrl: string): void {
    const command = bayCommand(incomingUrl);

    if (command) {
      if (command === "search") search(false);
      else openIncomingCommand(command);

      return;
    }

    const url = incomingLink(incomingUrl);

    if (!url) return;
    setOverlay("none");
    setPanel(null);
    setLink(null);

    const current = useBrowserStore.getState().data;
    const blank = current.tabs.find((tab) => tab.id === current.activeTabId);

    if (blank && !blank.url) navigate(blank.id, url);
    else openTab(url);
  }

  function search(inNewTab: boolean, privately = false): void {
    setSearchInNewTab(inNewTab);
    setSearchPrivately(privately);
    setOverlay("search");
  }

  // The bar swipe moves through tabs in the switcher's order.
  const activeIndex = data.tabs.findIndex((tab) => tab.id === active.id);

  function swipeTabs(step: 1 | -1): void {
    const next = data.tabs[data.tabs.findIndex((tab) => tab.id === active.id) + step];

    if (!next) return;
    capture(active.id);
    activate(next.id);
  }

  function showTabs(): void {
    if (hasPage) capture(active.id);
    setOverlay("tabs");
  }

  // A card in the switcher grows into the page it stands for (A1). A tab with no picture has nothing to grow from.
  function pickTab(tab: BrowserTab, frame: Frame): void {
    if (!tab.snapshot) {
      activate(tab.id);

      return;
    }

    setZoom({ tab, frame });
  }

  // A sheet reports its dismissal after it animates away, by which time another panel may have opened.
  function closePanel(which: Panel): void {
    setPanel((current) => (current === which ? null : current));
  }

  function run(command: (tab: Tab) => Promise<void>): void {
    const view = views.get(active.id);

    if (view) command(view).catch((cause: unknown) => fail(active.id, cause));
  }

  // Shared and copied links leave their tracking parameters behind.
  async function share(url: string): Promise<void> {
    const clean = cleanUrl(url);
    await Share.share(Platform.OS === "ios" ? { url: clean } : { message: clean });
  }

  function copy(url: string): void {
    // Android 13+ confirms copies itself with the system clipboard preview.
    void Clipboard.setStringAsync(cleanUrl(url)).then(() => Platform.OS === "ios" && toast.show(t("toast.linkCopied")));
  }

  // What went wrong since Bay was opened (B8): sent on, so it can be looked at.
  async function reportProblem(): Promise<void> {
    await Share.share({ message: crashReports().length ? crashReportText() : t("crash.none") });
  }

  // Closing a tab archives it, so it can come straight back.
  function archiveTab(id: string): void {
    const tab = data.tabs.find((entry) => entry.id === id);
    closeTab(id);

    if (!tab?.url || tab.private) return;
    toast.show(t("toast.tabArchived"), { label: t("toast.undo"), onPress: () => void restoreTab(id) });
  }

  function importLinks(tabs: readonly ImportedTab[], target: "tabs" | "archive"): void {
    const count = importTabs(tabs, target);
    setPanel(null);

    if (!count) {
      toast.show(t("toast.linksAlreadyHere"));

      return;
    }

    const message = target === "tabs" ? (count === 1 ? "toast.openedTab" : "toast.openedTabs") : count === 1 ? "toast.archivedTab" : "toast.archivedTabs";

    toast.show(t(message, { count }));
  }

  function onPageRequest(tabId: string, request: PageRequest): void {
    // A site Bay already saved a login for signs in without being asked again (B20). A private tab's logins stay in
    // the private session, so it is never answered this way.
    if (request.kind === "auth") {
      const origin = originOf(request.url);
      const privately = Boolean(useBrowserStore.getState().data.tabs.find((tab) => tab.id === tabId)?.private);

      if (origin && !privately) {
        // The lookup belongs to the page that asked: when the tab loads again or closes, it stops, so a login found
        // late never reaches the next page.
        runForTab(
          tabId,
          "logins.signIn",
          Effect.gen(function* () {
            const logins = yield* Logins;
            // A secure store that can't be read asks the user instead.
            const login = yield* logins.find(origin).pipe(Effect.orElseSucceed(() => null));

            if (!login) {
              yield* Effect.sync(() =>
                setPageRequests((previous) => (previous.some((entry) => entry.request.id === request.id) ? previous : [...previous, { tabId, request }])),
              );

              return;
            }

            const view = views.get(tabId);

            if (!view) return;

            // The page may have dropped the request on its own; then there is no one left to answer.
            yield* Effect.tryPromise(() => view.answerPageRequest(request.id, true, undefined, login.username, login.password)).pipe(Effect.ignore);
          }),
        );

        return;
      }
    }

    setPageRequests((previous) => (previous.some((entry) => entry.request.id === request.id) ? previous : [...previous, { tabId, request }]));
  }

  function answerPageRequest(accepted: boolean, value?: string, username?: string, password?: string, save?: boolean): void {
    const current = pageRequests[0];

    if (!current) return;
    setPageRequests((previous) => previous.filter((entry) => entry.request.id !== current.request.id));
    void views
      .get(current.tabId)
      ?.answerPageRequest(current.request.id, accepted, value, username, password)
      .catch(() => {});

    // Saved logins (B20) are filed when the user chose to save them on the sign-in sheet. Never from a private tab.
    if (save && accepted && current.request.kind === "auth" && username && password) {
      const origin = originOf(current.request.url);
      const privately = Boolean(useBrowserStore.getState().data.tabs.find((tab) => tab.id === current.tabId)?.private);

      if (origin && !privately) {
        const login = { origin, username, password, savedAt: Date.now() };

        runCommand(
          { name: "logins.save", resource: origin },
          Logins.use((logins) => logins.save(login)),
        );
      }
    }
  }

  function archiveAll(): void {
    const space = data.tabs.filter((tab) => tab.spaceId === data.activeSpaceId);
    const archived = space.filter((tab) => tab.url && !tab.private).map((tab) => tab.id);

    for (const tab of space) closeTab(tab.id);
    setOverlay("none");

    if (!archived.length) return;
    toast.show(archived.length === 1 ? t("toast.oneTabArchived") : t("toast.tabsArchived", { count: archived.length }), {
      label: t("toast.undo"),
      onPress: () => {
        for (const id of archived) restoreTab(id);

        // Closing every tab left a blank one behind.
        for (const tab of useBrowserStore.getState().data.tabs) if (!tab.url && tab.spaceId === data.activeSpaceId) closeTab(tab.id);
      },
    });
  }

  const host = hostOf(active.url);
  // What this site (B12) keeps instead of the globals: a per-site zoom, auto Reader and desktop mode.
  const siteSetting = siteSettingFor(data.preferences.siteSettings, active.url);
  const pausedEntry = blockingPausedHosts.find((entry) => host === entry || host.endsWith(`.${entry}`));
  const blocking = !blockContent ? "off" : pausedEntry ? "paused" : "on";

  function toggleBlocking(): void {
    if (!host) return;
    dispatch({ type: "pause-blocking", host: pausedEntry ?? host, paused: !pausedEntry });
    // The change applies to new loads; reload so this page shows it.
    run((tab) => tab.reload());
  }

  // Site settings (B12) are written whole: the store keeps an entry only while some value differs from the globals.
  function changeSiteSetting(update: Partial<SiteSetting>): void {
    dispatch({ type: "site-settings", host, update: { ...siteSetting, ...update } });
  }

  async function setLockPrivateTabs(enabled: boolean): Promise<void> {
    // Turning the lock on proves Face ID, Touch ID or the passcode works before relying on it.
    if (enabled && !(await authenticate())) return;
    dispatch({ type: "lock-private-tabs", enabled });
  }

  async function wipe(): Promise<void> {
    reset();
    setNavigation({});
    setLive([]);
    visited.clear();
    failed.clear();
    // Let the page views unmount first so no page writes fresh data.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await clearData();
  }

  // Android Back, newest state each press; registered once while the screen is focused.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    // Back cancels a page's dialog first: the page is paused until Bay answers it.
    if (pageRequests.length) {
      answerPageRequest(false);

      return true;
    }

    // Back closes an open sheet first, as on every Android sheet.
    if (panel || link) {
      setPanel(null);
      setLink(null);

      return true;
    }

    if (reading.back()) return true;

    if (overlay !== "none") {
      setOverlay("none");

      return true;
    }

    if (find.open) {
      find.done();

      return true;
    }

    if (page.canGoBack) {
      views
        .get(active.id)
        ?.goBack()
        .catch(() => {});

      return true;
    }

    return false;
  };

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => backRef.current());

      return () => subscription.remove();
    }, []),
  );

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: barHidden.value * (BAR_HEIGHT + insets.bottom + 24) }],
    opacity: 1 - barHidden.value,
  }));

  const player = media.player;
  // A locked private tab or an error page shows Bay's own screen there, not the page.
  const topColor = locked && active.private ? null : error?.tabId === active.id ? null : (pageColors[active.id] ?? null);
  const tabError = error?.tabId === active.id ? error : null;
  const fullscreen = fullscreenByTab[active.id] ?? false;
  const onPhoto = data.preferences.wallpaper === "photo" && Boolean(data.preferences.wallpaperPhoto);

  return (
    <View className="flex-1 bg-background">
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false} {...behindSheet}>
        <Wallpaper id={data.preferences.wallpaper} photo={data.preferences.wallpaperPhoto} />
        {ready ? (
          <View style={[StyleSheet.absoluteFill, { top: insets.top }]} pointerEvents="box-none">
            {mounted.map((id) => {
              const tab = data.tabs.find((entry) => entry.id === id)!;
              const visible = showPages && id === active.id && hasPage;

              return (
                <TabPage
                  key={id}
                  tab={tab}
                  visible={visible}
                  // The active tab stays live behind the switcher and search so its snapshot and return are instant.
                  suspended={id !== active.id && !playing.includes(id)}
                  hiddenSelectors={[...reading.selectorsFor(tab), ...youtubeSelectors(data.preferences.youtube, hostOf(tab.url))]}
                  // A site's own zoom (B12) takes over the global one.
                  tweaks={{
                    textSize: siteSettingFor(data.preferences.siteSettings, tab.url).textSize ?? data.preferences.textSize,
                    skipAmp: data.preferences.skipAmp,
                  }}
                  desktopMode={siteSettingFor(data.preferences.siteSettings, tab.url).desktopMode}
                  pullToRefresh={data.preferences.pullToRefresh}
                  pageColor={pageColors[id] ?? null}
                  onPageColor={(color) => setPageColors((previous) => (String(previous[id]) === String(color) ? previous : { ...previous, [id]: color }))}
                  onPageMessage={(message) => {
                    if (!media.pageMessage(id, message) && id === active.id) {
                      // A bare image's long press (B13), reported by the page on iOS; Android's hit test covers it natively.
                      const press = Platform.OS === "ios" ? parseImagePress(message) : null;

                      if (press) {
                        tick();
                        setLink(press);
                      } else reading.pageMessage(message);
                    }
                  }}
                  register={(view) => {
                    if (view) views.set(id, view);
                    else {
                      views.delete(id);
                      endTabWork(id);
                    }
                  }}
                  onNavigation={(state) => onNavigation(id, state)}
                  onError={({ url, message }) => {
                    failed.add(id);
                    setError({ tabId: id, url: url || tab.url, message });
                  }}
                  onScroll={(scroll) => onScroll(id, scroll)}
                  onLinkPress={(press) => {
                    if (id === active.id) {
                      tick();
                      setLink(press);
                    }
                  }}
                  onPageRequest={(request) => onPageRequest(id, request)}
                  onNewWindow={(window) => {
                    // New windows (B19) become a real tab: the opener's own page is untouched, a private opener stays
                    // private, and the tab opens to the front — the way a popup sign-in takes the screen.
                    if (isWebURL(window.url)) openTab(window.url, false, Boolean(window.private));
                  }}
                  onFullscreenChange={(fullscreen) =>
                    setFullscreenByTab((previous) => (previous[id] === fullscreen ? previous : { ...previous, [id]: fullscreen }))
                  }
                />
              );
            })}
          </View>
        ) : null}

        {tabError && hasPage && showPages ? (
          <View style={[StyleSheet.absoluteFill, { top: insets.top }]}>
            <PageError
              url={tabError.url}
              message={tabError.message}
              onRetry={() => {
                setError(null);
                navigate(active.id, tabError.url);
              }}
            />
          </View>
        ) : null}

        {hasPage && showPages && !fullscreen ? (
          <View
            className="absolute inset-x-0 top-0 bg-background"
            style={{ height: insets.top, backgroundColor: topColor ? `rgb(${topColor.join(",")})` : undefined }}
          >
            {/* Dark icons on a light page, light ones on a dark page. */}
            {topColor ? <StatusBar style={0.2126 * topColor[0] + 0.7152 * topColor[1] + 0.0722 * topColor[2] > 140 ? "dark" : "light"} /> : null}
          </View>
        ) : null}

        {ready && !hasPage && overlay === "none" ? (
          <View style={StyleSheet.absoluteFill}>
            {/* The whole screen searches. The pins sit beside it rather than inside it: VoiceOver can't reach controls
              inside another control, so nested in the backdrop they would be lost to it. */}
            <Pressable
              testID="start-screen"
              accessibilityRole="button"
              accessibilityLabel={t("start.tapToSearch")}
              style={StyleSheet.absoluteFill}
              onPress={() => search(false)}
            />
            <View className="flex-1 items-center justify-end" style={{ paddingBottom: insets.bottom + BAR_HEIGHT + space.xxl }} pointerEvents="box-none">
              <View className="w-full" style={{ marginBottom: space.xl, paddingLeft: insets.left, paddingRight: insets.right }} pointerEvents="box-none">
                <StartPage
                  pins={data.pinnedSites}
                  history={data.history}
                  onPhoto={onPhoto}
                  onOpen={(url) => open({ kind: "url", url }, false)}
                  onUnpin={(site) => {
                    const index = data.pinnedSites.indexOf(site);
                    tick();
                    dispatch({ type: "remove-pin", id: site.id });
                    toast.show(t("toast.unpinned"), { label: t("toast.undo"), onPress: () => dispatch({ type: "add-pin", site, index }) });
                  }}
                />
              </View>
              {/* The backdrop's label says this; touches pass through to it. */}
              <View
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="items-center"
                style={{ gap: 2 }}
              >
                <Text variant="subhead" weight="medium" color={onPhoto ? ON_PHOTO_MUTED : muted}>
                  {t("start.tapToSearch")}
                </Text>
                <Icon name="down" color={onPhoto ? ON_PHOTO_MUTED : muted} size={iconSize.small} />
              </View>
            </View>
          </View>
        ) : null}

        {overlay === "tabs" ? (
          <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom + BAR_HEIGHT + 16 }]}>
            <TabSwitcher
              tabs={switcherTabs}
              activeTabId={active.id}
              onPick={pickTab}
              onClose={archiveTab}
              onCloseAll={archiveAll}
              privateLocked={locked}
              spaces={data.spaces}
              activeSpaceId={data.activeSpaceId}
              onSelectSpace={(id) => {
                if (id !== data.activeSpaceId) {
                  setActiveFolderId(null);
                  selectSpace(id);
                }
              }}
              folders={data.folders.filter((folder) => folder.spaceId === data.activeSpaceId)}
              activeFolderId={activeFolderId}
              onSelectFolder={setActiveFolderId}
            />
          </View>
        ) : null}

        {locked && active.private && overlay === "none" ? (
          <PrivateLock
            bottomInset={insets.bottom + BAR_HEIGHT}
            onUnlock={() => {
              void authenticate().then((success) => success && setLocked(false));
            }}
          />
        ) : null}

        {find.open && overlay === "none" && hasPage ? (
          <FindBar query={find.query} count={find.count} index={find.index} onChange={find.change} onStep={find.step} onDone={find.done} />
        ) : null}
      </View>

      {overlay !== "search" && !find.open && !fullscreen ? (
        <Animated.View
          className="absolute inset-x-0"
          style={[
            {
              gap: space.md,
              bottom: Math.max(insets.bottom, space.md) + space.xs,
              paddingLeft: insets.left + space.edge,
              paddingRight: insets.right + space.edge,
            },
            barStyle,
          ]}
          pointerEvents="box-none"
        >
          {hasPage && showPages && !(locked && active.private) ? reading.controls : null}
          {player ? (
            <View collapsable={false} {...behindSheet}>
              <MiniPlayer
                title={player.title}
                site={hostOf(player.tab.url)}
                playing={player.playing}
                video={player.video}
                onOpen={() => {
                  setOverlay("none");
                  activate(player.tab.id);
                }}
                onToggle={() => media.toggle(player.tab.id)}
                onSeek={(seconds) => media.seek(player.tab.id, seconds)}
                onPictureInPicture={() => media.pictureInPicture(player.tab.id)}
                onClose={() => media.stop(player.tab.id)}
              />
            </View>
          ) : null}
          {downloads.toast && !(locked && downloads.toast.private) ? (
            <DownloadToast
              key={downloads.toast.id}
              item={downloads.toast}
              onOpen={() => downloads.toast && downloads.open(downloads.toast)}
              onShowAll={() => {
                downloads.dismissToast();
                setPanel("downloads");
              }}
            />
          ) : null}
          {toast.toast ? <Toast key={toast.toast.key} text={toast.toast.text} action={toast.toast.action} onDone={toast.dismiss} /> : null}
          <View collapsable={false} {...behindSheet}>
            {hasPage && showPages ? (
              <TabSwipe
                onSwipe={swipeTabs}
                hasPrevious={activeIndex > 0}
                hasNext={activeIndex < data.tabs.length - 1}
                contentKey={`${active.id} ${host ?? ""}`}
              >
                {(capsuleStyle) => (
                  <BrowserBar
                    capsuleStyle={capsuleStyle}
                    mode="page"
                    site={locked && active.private ? undefined : host}
                    insecure={active.url.startsWith("http:")}
                    privately={Boolean(active.private)}
                    // The capsule's edge carries the load's progress (A6).
                    progress={page.progress}
                    loading={page.isLoading}
                    onTabs={() => showTabs()}
                    onTabsLongPress={() => {
                      tick();
                      setPanel("tabs");
                    }}
                    onTabsSwipeUp={lastOpenTab}
                    tabCount={data.tabs.length}
                    onSearch={() => search(false)}
                    onMore={() => {
                      if (!(locked && active.private)) setPanel("page");
                    }}
                    onMoreLongPress={() => {
                      if (locked && active.private) return;
                      tick();
                      void share(active.url);
                    }}
                  />
                )}
              </TabSwipe>
            ) : (
              <BrowserBar
                mode="start"
                newTab={overlay === "tabs"}
                onArchive={() => setPanel("archive")}
                onSearch={() => search(overlay === "tabs")}
                onSettings={() => setPanel("settings")}
              />
            )}
          </View>
        </Animated.View>
      ) : null}

      {overlay === "search" ? (
        <SearchCard
          initialText={searchInNewTab ? "" : active.url}
          engine={engine}
          data={data}
          privateAvailable={privateBrowsingSupported}
          initialPrivate={searchPrivately || (!searchInNewTab && Boolean(active.private))}
          onOpen={open}
          onDismiss={() => {
            Keyboard.dismiss();
            setOverlay(searchInNewTab ? "tabs" : "none");
          }}
        />
      ) : null}

      <PageMenu
        visible={panel === "page" && !(locked && active.private)}
        onClose={() => closePanel("page")}
        url={page.url || active.url}
        title={page.title || active.title}
        canGoBack={page.canGoBack}
        canGoForward={page.canGoForward}
        isLoading={page.isLoading}
        isPinned={data.pinnedSites.some((site) => site.url === active.url)}
        blocking={blocking}
        readerActive={reading.reader}
        onReader={reading.openReader}
        onHideElements={reading.startPicking}
        onCopyMarkdown={reading.copyMarkdown}
        onFind={find.start}
        onInspect={reading.startInspecting}
        onToggleBlocking={toggleBlocking}
        hiddenCount={reading.selectorsFor(active).length}
        onShowHidden={reading.showHidden}
        onSiteSettings={() => setPanel("site")}
        privateAvailable={privateBrowsingSupported}
        onNewTab={() => search(true)}
        onNewPrivateTab={() => search(true, true)}
        onTranslate={() => navigate(active.id, translateUrl(active.url))}
        onDownloads={() => setPanel("downloads")}
        onBack={() => run((tab) => tab.goBack())}
        onForward={() => run((tab) => tab.goForward())}
        onReload={() => run((tab) => tab.reload())}
        onStop={() => run((tab) => tab.stop())}
        onPin={() => {
          tick();
          const pinned = data.pinnedSites.some((site) => site.url === active.url);
          dispatch({ type: "pin-site", tabId: active.id, pinId: newId() });
          toast.show(pinned ? t("toast.unpinned") : t("toast.pinned"));
        }}
        onShare={() => void share(active.url)}
        onCopy={() => copy(active.url)}
        onCloseTab={() => archiveTab(active.id)}
        onSettings={() => setPanel("settings")}
        onHistory={() => setPanel("history")}
      />
      <TabsMenu
        visible={panel === "tabs"}
        onClose={() => closePanel("tabs")}
        tabCount={spaceTabs.length}
        privateAvailable={privateBrowsingSupported}
        onNewTab={() => search(true)}
        onNewPrivateTab={() => search(true, true)}
        onArchiveTab={() => archiveTab(active.id)}
        onArchiveAll={archiveAll}
        spaces={data.spaces}
        activeSpaceId={data.activeSpaceId}
        onSelectSpace={(id) => {
          if (id !== data.activeSpaceId) {
            setActiveFolderId(null);
            selectSpace(id);
          }
        }}
        onNewSpace={createSpace}
        onRenameSpace={renameSpace}
        onDeleteSpace={deleteSpace}
        folders={data.folders.filter((folder) => folder.spaceId === data.activeSpaceId)}
        activeFolderId={activeFolderId}
        onSelectFolder={setActiveFolderId}
        onNewFolder={newFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={(id) => {
          setActiveFolderId((current) => (current === id ? null : current));
          deleteFolder(id);
        }}
        onMoveTab={(spaceId, folderId) => {
          moveTab(active.id, spaceId, folderId);
          setActiveFolderId(folderId);
        }}
      />
      <SiteSettingsPanel
        visible={panel === "site"}
        onClose={() => closePanel("site")}
        url={active.url}
        textSize={siteSetting.textSize}
        globalTextSize={data.preferences.textSize}
        reader={siteSetting.reader}
        desktop={siteSetting.desktopMode}
        onTextSize={(textSize) => changeSiteSetting({ textSize })}
        onReader={(reader) => {
          changeSiteSetting({ reader });

          if (reader && !reading.reader) reading.openReader();
          else if (!reader && reading.reader) reading.closeReader();
        }}
        onDesktop={(desktopMode) => changeSiteSetting({ desktopMode })}
      />
      <ArchivePanel
        visible={panel === "archive"}
        onClose={() => closePanel("archive")}
        items={data.archive}
        onRestore={(id) => {
          restoreTab(id);
          setOverlay("none");
        }}
        onRemove={(id) => dispatch({ type: "remove-archived", id })}
        onClear={() => dispatch({ type: "clear-archive" })}
      />
      <SettingsPanel
        visible={panel === "settings"}
        onClose={() => closePanel("settings")}
        engines={SEARCH_ENGINES}
        searchEngineId={engine.id}
        onSearchEngineChange={(id) => dispatch({ type: "search-engine", id })}
        archiveAfterDays={data.preferences.archiveAfterDays}
        onArchiveAfterDaysChange={(days) => dispatch({ type: "archive-days", days })}
        blockContent={blockContent}
        blockerDetail={blockerDetail(blockerStatus, t)}
        onBlockContentChange={(enabled) => dispatch({ type: "block-content", enabled })}
        privateAvailable={privateBrowsingSupported}
        lockPrivateTabs={lockPrivateTabs}
        onLockPrivateTabsChange={(enabled) => void setLockPrivateTabs(enabled)}
        wallpaper={data.preferences.wallpaper}
        wallpaperPhoto={data.preferences.wallpaperPhoto}
        onWallpaperChange={(id, photo) => dispatch({ type: "wallpaper", id, photo })}
        pausedHosts={blockingPausedHosts}
        onResumeBlocking={(paused) => dispatch({ type: "pause-blocking", host: paused, paused: false })}
        preferences={data.preferences}
        onPreferencesChange={(update) => dispatch({ type: "preferences", update })}
        onClearData={wipe}
        onImport={() => setPanel("import")}
        downloadCount={downloads.downloads.length}
        onDownloads={() => setPanel("downloads")}
        historyCount={data.history.length}
        onHistory={() => setPanel("history")}
        crashCount={crashReports().length}
        onReportProblem={() => void reportProblem()}
      />
      <HistoryPanel
        visible={panel === "history"}
        onClose={() => closePanel("history")}
        history={data.history}
        onOpen={(url) => {
          setOverlay("none");

          // A page on screen stays; the history page opens beside it.
          if (hasPage) openTab(url);
          else navigate(active.id, url);
        }}
        onRemove={(url) => dispatch({ type: "remove-history", url })}
        onClear={() => dispatch({ type: "clear-history" })}
      />
      <DownloadsPanel
        visible={panel === "downloads"}
        onClose={() => closePanel("downloads")}
        downloads={locked ? downloads.downloads.filter((item) => !item.private) : downloads.downloads}
        onOpen={downloads.open}
        onCancel={downloads.cancel}
        onRemove={downloads.remove}
        onClear={downloads.clear}
      />
      <ImportPanel visible={panel === "import"} onClose={() => closePanel("import")} onImport={importLinks} />
      <LinkMenu
        visible={link !== null}
        onClose={() => setLink(null)}
        url={link?.url ?? ""}
        title={link?.title ?? ""}
        privately={Boolean(active.private)}
        // A link to a site that keeps its desktop page (B12) previews it that way too.
        desktopMode={siteSettingFor(data.preferences.siteSettings, link?.url ?? "").desktopMode}
        image={link?.image ?? false}
        onOpenTab={() => link && openTab(link.url)}
        onOpenBackground={() => link && openTab(link.url, true)}
        onCopy={() => link && copy(link.url)}
        onShare={() => link && void share(link.url)}
        onSave={() => {
          if (!link) return;
          void saveImage(link.url)
            .then(() => toast.show(Platform.OS === "ios" ? t("toast.savedToPhotos") : t("toast.savedToDownloads")))
            .catch(() => toast.show(t("toast.imageNotSaved")));
        }}
      />
      <PageRequestPanel request={pageRequest?.request ?? null} onAnswer={answerPageRequest} />

      {/* The card's picture, grown into the page (A1). It is drawn over everything, and the live page takes over. */}
      {zoom ? (
        <TabZoom
          snapshot={zoom.tab.snapshot ?? ""}
          from={zoom.frame}
          onDone={() => {
            const target = zoom;

            setZoom(null);

            if (target) activate(target.tab.id);
          }}
        />
      ) : null}
    </View>
  );
}

function blockerDetail(status: BlockerStatus, t: Translate): string {
  switch (status.state) {
    case "ready":
      return t("settings.blocker.ready", { lists: status.lists });
    case "loading":
      return t("settings.blocker.loading");
    case "failed":
      return t("settings.blocker.failed");
    case "off":
      return t("settings.blocker.off");
  }
}

/** The page through Google Translate, into the phone's language. */
function translateUrl(url: string): string {
  if (/^https:\/\/[^/]+\.translate\.goog\//.test(url)) return url;
  const language = Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0] || "en";

  return `https://translate.google.com/translate?sl=auto&tl=${language}&u=${encodeURIComponent(url)}`;
}
