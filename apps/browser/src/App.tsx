import { WindowBackdrop } from "@bay/shaders";
import { Surface } from "@bay/shell";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { CommandPanel } from "./components/CommandPanel";
import { ContentCard } from "./components/ContentCard";
import { BookmarkDialog } from "./components/bookmarks/BookmarkDialog";
import { EditBookmarkDialog } from "./components/bookmarks/EditBookmarkDialog";
import { ExtensionOverlays } from "./components/extensions/ExtensionOverlays";
import { ExtensionSidePanel } from "./components/extensions/SidePanel";
import { DownloadMagnet } from "./components/Downloads";
import { DownloadsPanel } from "./components/DownloadsPanel";
import { UtilityWindow } from "./components/settings/UtilityWindow";
import { isUtilityWindowId } from "./components/settings/windows";
import { OnboardingOverlay } from "./components/onboarding";
import { CreateProfileHost } from "./components/profiles/CreateProfile";
import { ThemeEditorHost } from "./components/profiles/ThemeEditor";
import { useFullscreenTab } from "./components/layout/pageState";
import { ProfileSwipe, ProfileTint } from "./components/layout/ProfileSwipe";
import { TOP_CARD_INSET, TOP_STRIP_HEIGHT, TopStripPeek, TopTabStrip } from "./components/layout/TopTabStrip";
import { usePeek } from "./components/layout/usePeek";
import { useSidebarDock } from "./components/layout/useSidebarDock";
import { useTabLayout } from "./components/layout/windowLayout";
import { WindowProfile } from "./components/layout/WindowProfile";
import { Sidebar } from "./components/Sidebar";
import { SmallYahuWindow } from "./components/smallYahu/SmallYahuWindow";
import { SidebarOverlays } from "./components/sidebar/Overlays";
import { SidebarSiteControls } from "./components/sidebar/SidebarSiteControls";
import { useSidebarWidth } from "./components/sidebar/tokens";
import { hex, layout, ThemeScope, useTheme } from "./lib/theme";
import { useBrowser } from "./store/browser";
import { useSidebarOpen, useWindowId, WindowContext } from "./store/hooks";

export function WindowRoot({ windowId }: { windowId?: string }) {
  if (isUtilityWindowId(windowId))
    return (
      <ThemeScope>
        <UtilityWindow id={windowId!} />
      </ThemeScope>
    );
  return <BrowserWindowRoot windowId={windowId} />;
}

function BrowserWindowRoot({ windowId }: { windowId?: string }) {
  const id = useBrowser((s) => windowId ?? s.ui.focusedWindowId ?? s.windowOrder[0] ?? null);
  const exists = useBrowser((s) => !!id && !!s.windows[id]);
  const small = useBrowser((s) => !!id && s.windows[id]?.kind === "small");
  if (!id || !exists) return null;
  return (
    <WindowContext.Provider value={id}>
      <ThemeScope>{small ? <SmallYahuWindow /> : <BrowserWindow />}</ThemeScope>
    </WindowContext.Provider>
  );
}

function BrowserWindow() {
  const theme = useTheme();
  const sidebarOpen = useSidebarOpen();
  const topTabs = useTabLayout() === "top";
  const fullscreen = !!useFullscreenTab(useWindowId());
  // Page full screen hides the sidebar and the strip without unmounting them: they keep their scroll, rows, measured
  // sizes and swipe surface. Moved out of the window rather than made transparent, so nothing in them takes the pointer.
  const showSidebar = sidebarOpen && !topTabs;
  const showStrip = sidebarOpen && topTabs;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = size.width;
  const sidebarWidth = useSidebarWidth(useWindowId());
  const dock = useSidebarDock(showSidebar);
  // The sidebar's slot narrows to the card's inset as it closes; the sidebar slides left by as much, so its edge stays
  // on the card's (no clipping: the resize handle reaches past it).
  const hiddenBy = sidebarWidth - layout.cardInset;
  const slotStyle = useAnimatedStyle(() => {
    "worklet";
    // In page full screen the slot sits outside the window at the sidebar's full width.
    return { width: fullscreen ? sidebarWidth : interpolate(dock.progress.get(), [0, 1], [layout.cardInset, sidebarWidth]) };
  });
  const dockedStyle = useAnimatedStyle(() => {
    "worklet";
    const p = dock.progress.get();
    return { opacity: interpolate(p, [0, 0.6, 1], [0, 1, 1]), transform: [{ translateX: interpolate(p, [0, 1], [-hiddenBy, 0]) }] };
  });

  return (
    <View style={{ flex: 1, flexDirection: "row" }} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
      <WindowProfile />
      <ProfileTint />
      {!topTabs && (
        <Animated.View
          pointerEvents={fullscreen || !showSidebar ? "none" : "auto"}
          style={[fullscreen ? { position: "absolute", top: 0, bottom: 0, right: "100%" } : { height: "100%" }, slotStyle]}
        >
          {dock.mounted ? (
            <Animated.View style={[{ width: sidebarWidth, height: "100%" }, dockedStyle]}>
              <ProfileSwipe>
                <Sidebar />
              </ProfileSwipe>
            </Animated.View>
          ) : null}
        </Animated.View>
      )}
      <View
        style={
          fullscreen
            ? { flex: 1 }
            : {
                flex: 1,
                flexDirection: "row",
                paddingTop: showStrip ? TOP_STRIP_HEIGHT : layout.cardTop,
                paddingRight: showStrip ? TOP_CARD_INSET : layout.cardInset,
                paddingBottom: showStrip ? TOP_CARD_INSET : layout.cardInset,
                // The sidebar's slot (topTabs aside) holds the left inset, even closed.
                paddingLeft: !topTabs ? 0 : showStrip ? TOP_CARD_INSET : layout.cardInset,
              }
        }
      >
        <ContentCard />
        {!fullscreen && <ExtensionSidePanel />}
      </View>
      {showStrip && (
        <View pointerEvents={fullscreen ? "none" : "auto"} style={[{ position: "absolute", left: 0, right: 0 }, fullscreen ? { bottom: "100%" } : { top: 0 }]}>
          <TopTabStrip width={width} hidden={fullscreen} />
        </View>
      )}
      {!sidebarOpen && (topTabs ? <TopStripPeek windowWidth={width} enabled={!fullscreen} /> : <SidebarPeek enabled={!fullscreen} />)}
      <ExtensionOverlays />
      <DownloadMagnet />
      <BookmarkDialog />
      <EditBookmarkDialog />
      <CreateProfileHost />
      <SidebarOverlays windowWidth={width} />
      {!fullscreen && <SidebarSiteControls windowWidth={width} windowHeight={size.height} />}
      <DownloadsPanel windowWidth={width} windowHeight={size.height} />
      <CommandPanel windowWidth={width} windowHeight={size.height} />
      <ThemeEditorHost />
      <OnboardingOverlay />
    </View>
  );
}

function SidebarPeek({ enabled }: { enabled: boolean }) {
  const theme = useTheme();
  const sidebarWidth = useSidebarWidth(useWindowId());
  const { slide, live, show, hide } = usePeek(enabled);
  const slideStyle = useAnimatedStyle(() => {
    "worklet";
    const p = slide.get();
    return { opacity: p, transform: [{ translateX: interpolate(p, [0, 1], [-sidebarWidth - 12, 0]) }] };
  });

  return (
    <>
      {enabled ? <View onMouseEnter={show} style={{ position: "absolute", left: 0, top: layout.sidebarHeader, bottom: 0, width: 8 }} /> : null}
      <Animated.View
        pointerEvents={live ? "auto" : "none"}
        onMouseEnter={live ? show : undefined}
        onMouseLeave={live ? hide : undefined}
        style={[
          {
            position: "absolute",
            // Out of the window while hidden (a transform doesn't move hover tracking): its rows mustn't hover under the page.
            left: live ? 6 : -10_000,
            top: layout.cardTop,
            bottom: layout.cardInset,
            width: sidebarWidth,
          },
          slideStyle,
        ]}
      >
        <Surface
          fill={hex(theme.windowTint[0])}
          cornerRadius={12}
          borderColor={hex(theme.panelBorder)}
          borderWidth={0.5}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={20}
          shadowOffset={[0, 6]}
          style={{ flex: 1, overflow: "hidden" }}
        >
          <Sidebar />
        </Surface>
      </Animated.View>
    </>
  );
}
