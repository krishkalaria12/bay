import { clearData, type LinkPress, type NavigationState, type PageScroll, type Tab } from "@bay/engine";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState, type JSX } from "react";
import { BackHandler, Keyboard, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "heroui-native";

import { BrowserBar } from "@/chrome/BrowserBar";
import { Surface } from "@/chrome/Surface";
import { ArchivePanel, LinkMenu, PageMenu, SettingsPanel } from "@/panels";
import { newId, useBrowserStore } from "@/store/browser";
import { engineFor, isWebURL, SEARCH_ENGINES } from "./address";
import { SearchCard, type OpenTarget } from "./SearchCard";
import { TabPage } from "./TabPage";
import { TabSwitcher } from "./TabSwitcher";
import { Wallpaper } from "./Wallpaper";

// Live page views kept in memory; other tabs reload from their address when opened.
const MAX_LIVE = 4;
const BAR_HEIGHT = 52;
const views = new Map<string, Tab>();
const visited = new Map<string, string>();

type Overlay = "none" | "search" | "tabs";
type Panel = "archive" | "settings" | "page" | null;

const blankNavigation: NavigationState = { url: "", title: "", progress: 0, isLoading: false, canGoBack: false, canGoForward: false };

export function BrowserScreen(): JSX.Element {
  const insets = useSafeAreaInsets();
  const muted = useThemeColor("muted");
  const accent = useThemeColor("accent");
  const { ready, data, dispatch, openTab, closeTab, restoreTab, reset } = useBrowserStore();
  const [live, setLive] = useState<string[]>([]);
  const [navigation, setNavigation] = useState<Record<string, NavigationState>>({});
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [searchInNewTab, setSearchInNewTab] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [link, setLink] = useState<LinkPress | null>(null);
  const [error, setError] = useState<{ tabId: string; message: string } | null>(null);
  const barHidden = useSharedValue(0);

  useEffect(() => {
    void useBrowserStore.getState().load();
  }, []);

  const active = data.tabs.find((tab) => tab.id === data.activeTabId) ?? data.tabs[0]!;
  const page = navigation[active.id] ?? { ...blankNavigation, url: active.url, title: active.title };
  const hasPage = Boolean(active.url);
  const engine = engineFor(data.preferences.searchEngineId);
  const existing = new Set(data.tabs.map((tab) => tab.id));
  const mounted = [active.id, ...live.filter((id) => id !== active.id && existing.has(id))].slice(0, MAX_LIVE);
  const mountedKey = mounted.join(" ");

  useEffect(() => {
    setLive(mountedKey.split(" "));
    barHidden.value = withTiming(0);
  }, [mountedKey, barHidden]);

  const fail = useCallback((tabId: string, cause: unknown) => {
    setError({ tabId, message: cause instanceof Error ? cause.message : "Couldn't open this page." });
  }, []);

  function capture(tabId: string): void {
    void views
      .get(tabId)
      ?.snapshot()
      .then((uri) => uri && dispatch({ type: "update-tab", id: tabId, update: { snapshot: uri } }))
      .catch(() => {});
  }

  function onNavigation(tabId: string, state: NavigationState): void {
    setNavigation((previous) => ({ ...previous, [tabId]: state }));
    if (!isWebURL(state.url)) return;
    if (state.isLoading) setError((current) => (current?.tabId === tabId ? null : current));
    dispatch({ type: "update-tab", id: tabId, update: { url: state.url, ...(state.title ? { title: state.title } : {}) } });
    if (state.title && visited.get(tabId) === state.url) dispatch({ type: "page-title", url: state.url, title: state.title });
    if (!state.isLoading && visited.get(tabId) !== state.url) {
      visited.set(tabId, state.url);
      dispatch({ type: "visit", url: state.url, title: state.title, favicon: null, now: Date.now() });
      setTimeout(() => capture(tabId), 700);
    }
  }

  function onScroll(tabId: string, { offsetY, deltaY }: PageScroll): void {
    if (tabId !== active.id) return;
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
    dispatch({ type: "activate-tab", id, now: Date.now() });
    setOverlay("none");
  }

  function open(target: OpenTarget): void {
    Keyboard.dismiss();
    setOverlay("none");
    if (target.kind === "tab") activate(target.id);
    else if (target.kind === "archived") restoreTab(target.id);
    else if (searchInNewTab && hasPage) openTab(target.url);
    else navigate(active.id, target.url);
  }

  function search(inNewTab: boolean): void {
    setSearchInNewTab(inNewTab);
    setOverlay("search");
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

  async function share(url: string): Promise<void> {
    await Share.share(Platform.OS === "ios" ? { url } : { message: url });
  }

  async function wipe(): Promise<void> {
    reset();
    setNavigation({});
    setLive([]);
    visited.clear();
    // Let the page views unmount first so no page writes fresh data.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await clearData();
  }

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (overlay !== "none") {
          setOverlay("none");
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
      });
      return () => subscription.remove();
    }, [active.id, overlay, page.canGoBack]),
  );

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: barHidden.value * (BAR_HEIGHT + insets.bottom + 24) }],
    opacity: 1 - barHidden.value,
  }));

  // A search for a new tab opens over the wallpaper, like the switcher it came from.
  const showPages = overlay === "none" || (overlay === "search" && !searchInNewTab);
  const tabError = error?.tabId === active.id ? error.message : null;

  return (
    <View className="flex-1 bg-background">
      <Wallpaper />
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
                register={(view) => (view ? views.set(id, view) : views.delete(id))}
                onNavigation={(state) => onNavigation(id, state)}
                onError={(message) => setError({ tabId: id, message })}
                onScroll={(scroll) => onScroll(id, scroll)}
                onLinkPress={(press) => {
                  if (id === active.id) setLink(press);
                }}
              />
            );
          })}
        </View>
      ) : null}

      {hasPage && showPages ? (
        <View className="absolute inset-x-0 top-0 bg-background" style={{ height: insets.top }}>
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
            <Text style={{ color: muted, fontSize: 14 }}>Tap to search</Text>
            <Text style={{ color: muted, fontSize: 14, marginTop: 2 }}>↓</Text>
          </View>
        </Pressable>
      ) : null}

      {overlay === "tabs" ? (
        <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top, paddingBottom: insets.bottom + BAR_HEIGHT + 16 }]}>
          <TabSwitcher tabs={data.tabs} activeTabId={active.id} onSelect={activate} onClose={closeTab} />
        </View>
      ) : null}

      {overlay !== "search" ? (
        <Animated.View className="absolute inset-x-0 gap-3 px-4" style={[{ bottom: Math.max(insets.bottom, 12) + 4 }, barStyle]} pointerEvents="box-none">
          {tabError && showPages ? (
            <Surface radius={18} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
              <Text testID="navigation-error" accessibilityRole="alert" style={{ color: muted, fontSize: 14 }}>
                {tabError}
              </Text>
            </Surface>
          ) : null}
          {hasPage && showPages ? (
            <BrowserBar mode="page" onTabs={showTabs} onSearch={() => search(false)} onMore={() => setPanel("page")} />
          ) : (
            <BrowserBar
              mode="start"
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
          onOpen={open}
          onDismiss={() => {
            Keyboard.dismiss();
            setOverlay(searchInNewTab ? "tabs" : "none");
          }}
        />
      ) : null}

      <PageMenu
        visible={panel === "page"}
        onClose={() => closePanel("page")}
        url={page.url || active.url}
        title={page.title || active.title}
        canGoBack={page.canGoBack}
        canGoForward={page.canGoForward}
        isLoading={page.isLoading}
        isPinned={data.pinnedSites.some((site) => site.url === active.url)}
        onBack={() => run((tab) => tab.goBack())}
        onForward={() => run((tab) => tab.goForward())}
        onReload={() => run((tab) => tab.reload())}
        onStop={() => run((tab) => tab.stop())}
        onPin={() => dispatch({ type: "pin-site", tabId: active.id, pinId: newId() })}
        onShare={() => void share(active.url)}
        onCopy={() => void Clipboard.setStringAsync(active.url)}
        onCloseTab={() => closeTab(active.id)}
        onSettings={() => setPanel("settings")}
      />
      <ArchivePanel
        visible={panel === "archive"}
        onClose={() => closePanel("archive")}
        items={data.archive}
        onRestore={(id) => {
          restoreTab(id);
          setOverlay("none");
        }}
      />
      <SettingsPanel
        visible={panel === "settings"}
        onClose={() => closePanel("settings")}
        engines={SEARCH_ENGINES}
        searchEngineId={engine.id}
        onSearchEngineChange={(id) => dispatch({ type: "search-engine", id })}
        archiveAfterDays={data.preferences.archiveAfterDays}
        onArchiveAfterDaysChange={(days) => dispatch({ type: "archive-days", days })}
        onClearData={wipe}
      />
      <LinkMenu
        visible={link !== null}
        onClose={() => setLink(null)}
        url={link?.url ?? ""}
        title={link?.title ?? ""}
        onOpenTab={() => link && openTab(link.url)}
        onOpenBackground={() => link && openTab(link.url, true)}
        onCopy={() => link && void Clipboard.setStringAsync(link.url)}
        onShare={() => link && void share(link.url)}
        onResolveDestination={() => resolveDestination(link?.url ?? "")}
      />
    </View>
  );
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
