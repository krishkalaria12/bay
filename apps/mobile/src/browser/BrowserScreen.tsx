import { cleanUrl } from "@bay/core/src/cleanUrl.ts";
import { hostOf } from "@bay/core/src/input.ts";
import { clearData, privateBrowsingSupported, type LinkPress, type NavigationState, type PageRequest, type PageScroll, type Tab } from "@bay/engine";
import * as Clipboard from "expo-clipboard";
import * as LocalAuthentication from "expo-local-authentication";
import { StatusBar } from "expo-status-bar";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { AppState, BackHandler, Keyboard, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "heroui-native";
import { Uniwind } from "uniwind";

import { BrowserBar } from "@/chrome/BrowserBar";
import { tick } from "@/chrome/haptics";
import { ArchivePanel, LinkMenu, PageMenu, SettingsPanel, TabsMenu } from "@/panels";
import { DownloadsPanel } from "@/panels/DownloadsPanel";
import { HistoryPanel } from "@/panels/HistoryPanel";
import { ImportPanel } from "@/panels/ImportPanel";
import { PageRequestPanel } from "@/panels/PageRequest";
import { youtubeSelectors } from "@/pagescripts/youtube";
import { useBlockerStatus, useContentBlocking, type BlockerStatus } from "@/privacy/contentBlocking";
import { newId, useBrowserStore } from "@/store/browser";
import { engineFor, isWebURL, SEARCH_ENGINES } from "./address";
import { PrivateLock } from "./PrivateLock";
import { SearchCard, type OpenTarget } from "./SearchCard";
import { StartPage } from "./StartPage";
import { TabPage } from "./TabPage";
import { TabSwitcher } from "./TabSwitcher";
import { TabSwipe } from "./TabSwipe";
import { Wallpaper } from "./Wallpaper";
import { FindBar } from "./FindBar";
import { fetchFavicon } from "./favicons";
import type { ImportedTab } from "./importTabs";
import { sameNavigation } from "./navigationEvents";
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

type Overlay = "none" | "search" | "tabs";

type Panel = "archive" | "settings" | "page" | "downloads" | "tabs" | "history" | "import" | null;

const blankNavigation: NavigationState = { url: "", title: "", progress: 0, isLoading: false, canGoBack: false, canGoForward: false };

export function BrowserScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const muted = useThemeColor("muted");
  const accent = useThemeColor("accent");
  const { ready, data, dispatch, openTab, closeTab, restoreTab, reset, importTabs } = useBrowserStore();
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
  const barHidden = useSharedValue(0);

  useEffect(() => {
    void useBrowserStore.getState().load();
  }, []);

  const active = data.tabs.find((tab) => tab.id === data.activeTabId) ?? data.tabs[0]!;
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
  const lockEnabled = lockPrivateTabs && data.tabs.some((tab) => tab.private);

  useContentBlocking(ready, blockContent, blockingPausedHosts);

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
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        startFresh.current();
      } else {
        // The system may end Bay while it is in the background: keep each page's history, scroll and form text.
        for (const view of views.values()) void view.saveState().catch(() => {});
      }
    });

    return () => subscription.remove();
  }, []);
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

  async function authenticate(): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock private tabs" });

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
  const fail = useCallback((_tabId: string, cause: unknown) => showToast(cause instanceof Error ? cause.message : "Something went wrong."), [showToast]);

  const downloads = useDownloads((message) => toast.show(message));
  // The download toast rides on the bottom bar, so a download started (or finished) while the bar is scrolled away
  // brings it back; otherwise the tap looks like it did nothing.
  const downloadToastKey = downloads.toast ? `${downloads.toast.id} ${downloads.toast.state}` : null;
  useEffect(() => {
    if (downloadToastKey) barHidden.value = withTiming(0, { duration: 180 });
  }, [downloadToastKey, barHidden]);
  const find = useFindInPage(views.get(active.id), `${active.id} ${active.url}`);
  const reading = useReadingTools(active, views.get(active.id), page.isLoading, locked && Boolean(active.private), (cause) => fail(active.id, cause));

  function capture(tabId: string): void {
    // Private pages leave no snapshot files behind.
    if (failed.has(tabId) || data.tabs.find((tab) => tab.id === tabId)?.private) return;
    void views
      .get(tabId)
      ?.snapshot()
      .then((uri) => uri && dispatch({ type: "update-tab", id: tabId, update: { snapshot: uri } }))
      .catch(() => {});
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
      // The engine cancels a pending dialog when a tab loads, so its sheet goes with it.
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

      if (view) fetchFavicon(view, state.url);
      setTimeout(() => capture(tabId), 700);
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
    void Clipboard.setStringAsync(cleanUrl(url)).then(() => Platform.OS === "ios" && toast.show("Link copied"));
  }

  // Closing a tab archives it, so it can come straight back.
  function archiveTab(id: string): void {
    const tab = data.tabs.find((entry) => entry.id === id);
    closeTab(id);

    if (!tab?.url || tab.private) return;
    toast.show("Tab archived", { label: "Undo", onPress: () => void restoreTab(id) });
  }

  function importLinks(tabs: readonly ImportedTab[], target: "tabs" | "archive"): void {
    const count = importTabs(tabs, target);
    setPanel(null);

    if (!count) {
      toast.show("Those links are already here");

      return;
    }

    toast.show(target === "tabs" ? `Opened ${count} ${count === 1 ? "tab" : "tabs"}` : `Archived ${count} ${count === 1 ? "tab" : "tabs"}`);
  }

  function onPageRequest(tabId: string, request: PageRequest): void {
    setPageRequests((previous) => (previous.some((entry) => entry.request.id === request.id) ? previous : [...previous, { tabId, request }]));
  }

  function answerPageRequest(accepted: boolean, value?: string, username?: string, password?: string): void {
    const current = pageRequests[0];

    if (!current) return;
    setPageRequests((previous) => previous.filter((entry) => entry.request.id !== current.request.id));
    void views
      .get(current.tabId)
      ?.answerPageRequest(current.request.id, accepted, value, username, password)
      .catch(() => {});
  }

  function archiveAll(): void {
    const archived = data.tabs.filter((tab) => tab.url && !tab.private).map((tab) => tab.id);

    for (const tab of data.tabs) closeTab(tab.id);
    setOverlay("none");

    if (!archived.length) return;
    toast.show(archived.length === 1 ? "1 tab archived" : `${archived.length} tabs archived`, {
      label: "Undo",
      onPress: () => {
        for (const id of archived) restoreTab(id);

        // Closing every tab left a blank one behind.
        for (const tab of useBrowserStore.getState().data.tabs) if (!tab.url) closeTab(tab.id);
      },
    });
  }

  const host = hostOf(active.url);
  const pausedEntry = blockingPausedHosts.find((entry) => host === entry || host.endsWith(`.${entry}`));
  const blocking = !blockContent ? "off" : pausedEntry ? "paused" : "on";

  function toggleBlocking(): void {
    if (!host) return;
    dispatch({ type: "pause-blocking", host: pausedEntry ?? host, paused: !pausedEntry });
    // The change applies to new loads; reload so this page shows it.
    run((tab) => tab.reload());
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

  return (
    <View className="flex-1 bg-background">
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
                tweaks={{ textSize: data.preferences.textSize, skipAmp: data.preferences.skipAmp }}
                pullToRefresh={data.preferences.pullToRefresh}
                pageColor={pageColors[id] ?? null}
                onPageColor={(color) => setPageColors((previous) => (String(previous[id]) === String(color) ? previous : { ...previous, [id]: color }))}
                onPageMessage={(message) => {
                  if (!media.pageMessage(id, message) && id === active.id) reading.pageMessage(message);
                }}
                register={(view) => (view ? views.set(id, view) : views.delete(id))}
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
          {page.isLoading ? (
            <View
              testID="page-progress"
              className="absolute bottom-0 left-0 h-0.5"
              style={{ width: `${Math.max(8, page.progress * 100)}%`, backgroundColor: accent }}
            />
          ) : null}
        </View>
      ) : null}

      {ready && !hasPage && overlay === "none" ? (
        <Pressable testID="start-screen" accessibilityLabel="Tap to search" style={StyleSheet.absoluteFill} onPress={() => search(false)}>
          <View className="flex-1 items-center justify-end" style={{ paddingBottom: insets.bottom + BAR_HEIGHT + 40 }}>
            <View className="mb-8 w-full">
              <StartPage
                pins={data.pinnedSites}
                history={data.history}
                onOpen={(url) => open({ kind: "url", url }, false)}
                onUnpin={(site) => {
                  const index = data.pinnedSites.indexOf(site);
                  dispatch({ type: "remove-pin", id: site.id });
                  toast.show("Unpinned", { label: "Undo", onPress: () => dispatch({ type: "add-pin", site, index }) });
                }}
              />
            </View>
            <Text style={{ color: muted, fontSize: 14 }}>Tap to search</Text>
            <Text style={{ color: muted, fontSize: 14, marginTop: 2 }}>↓</Text>
          </View>
        </Pressable>
      ) : null}

      {overlay === "tabs" ? (
        <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom + BAR_HEIGHT + 16 }]}>
          <TabSwitcher tabs={data.tabs} activeTabId={active.id} onSelect={activate} onClose={archiveTab} onCloseAll={archiveAll} privateLocked={locked} />
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

      {overlay !== "search" && !find.open && !fullscreen ? (
        <Animated.View className="absolute inset-x-0 gap-3 px-4" style={[{ bottom: Math.max(insets.bottom, 12) + 4 }, barStyle]} pointerEvents="box-none">
          {hasPage && showPages && !(locked && active.private) ? reading.controls : null}
          {player ? (
            <MiniPlayer
              title={player.title}
              site={hostOf(player.tab.url)}
              playing={player.playing}
              onOpen={() => {
                setOverlay("none");
                activate(player.tab.id);
              }}
              onToggle={() => media.toggle(player.tab.id)}
              onClose={() => media.stop(player.tab.id)}
            />
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
          {hasPage && showPages ? (
            <TabSwipe onSwipe={swipeTabs} hasPrevious={activeIndex > 0} hasNext={activeIndex < data.tabs.length - 1} contentKey={`${active.id} ${host ?? ""}`}>
              {(capsuleStyle) => (
                <BrowserBar
                  capsuleStyle={capsuleStyle}
                  mode="page"
                  site={locked && active.private ? undefined : host}
                  insecure={active.url.startsWith("http:")}
                  privately={Boolean(active.private)}
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
          toast.show(pinned ? "Unpinned" : "Pinned");
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
        tabCount={data.tabs.length}
        privateAvailable={privateBrowsingSupported}
        onNewTab={() => search(true)}
        onNewPrivateTab={() => search(true, true)}
        onArchiveTab={() => archiveTab(active.id)}
        onArchiveAll={archiveAll}
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
        blockerDetail={blockerDetail(blockerStatus)}
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
        onOpenTab={() => link && openTab(link.url)}
        onOpenBackground={() => link && openTab(link.url, true)}
        onCopy={() => link && copy(link.url)}
        onShare={() => link && void share(link.url)}
        onResolveDestination={() => resolveDestination(link?.url ?? "")}
      />
      <PageRequestPanel request={pageRequest?.request ?? null} onAnswer={answerPageRequest} />
    </View>
  );
}

function blockerDetail(status: BlockerStatus): string {
  switch (status.state) {
    case "ready":
      return `uBlock Origin's lists · ${status.lists} lists active, updated daily`;
    case "loading":
      return "Downloading filter lists…";
    case "failed":
      return "Filter lists couldn't load. Bay will try again.";
    case "off":
      return "uBlock Origin's lists, updated daily";
  }
}

/** The page through Google Translate, into the phone's language. */
function translateUrl(url: string): string {
  if (/^https:\/\/[^/]+\.translate\.goog\//.test(url)) return url;
  const language = Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0] || "en";

  return `https://translate.google.com/translate?sl=auto&tl=${language}&u=${encodeURIComponent(url)}`;
}

/** Follow a link's redirects without opening it, to show where it really goes. */
async function resolveDestination(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    let response = await fetch(url, { method: "HEAD", signal: controller.signal });

    if (response.status === 405 || response.status === 501) response = await fetch(url, { signal: controller.signal });

    return response.url || url;
  } catch {
    throw new Error("Couldn't reach this link. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
}
