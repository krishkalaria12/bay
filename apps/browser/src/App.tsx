import { View } from "@bay/platform";
import { WindowBackdrop } from "@bay/shaders";
import { onAppEvent, setTrafficLightsMode, Surface, WindowDragRegion, type TrafficLightsMode } from "@bay/shell";
import { useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "@bay/platform/motion";
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
import { CreateSpaceHost } from "./components/spaces/CreateSpace";
import { RenameDialogHost } from "./components/RenameDialog";
import { AppDialogHost } from "./components/AppDialog";
import { ThemeEditorHost } from "./components/spaces/ThemeEditor";
import { useFullscreenTab } from "./components/layout/pageState";
import { SpaceSwipe, SpaceTint } from "./components/layout/SpaceSwipe";
import { CaptionButtons } from "./components/layout/CaptionButtons";
import { TopStripPeek, TopTabStrip } from "./components/layout/TopTabStrip";
import { TOP_CARD_INSET } from "./components/layout/constants";
import { TOP_STRIP_HEIGHT } from "./components/layout/constants";
import { usePeek } from "./components/layout/usePeek";
import { useSidebarDock } from "./components/layout/useSidebarDock";
import { useAddressBarInSidebar, useSidebarOnRight, useTabLayout } from "./components/layout/windowLayout";
import { WindowProfile } from "./components/layout/WindowProfile";
import { Sidebar } from "./components/Sidebar";
import { LittleBayWindow } from "./components/littleBay/LittleBayWindow";
import { SidebarOverlays } from "./components/sidebar/Overlays";
import { SidebarSiteControls } from "./components/sidebar/SidebarSiteControls";
import { useSidebarWidth } from "./components/sidebar/tokens";
import { hex, ThemeScope, useTheme } from "./lib/theme";
import { layout } from "./lib/constants";
import { useEffectEvent } from "./lib/useEffectEvent";
import { useBrowserRead as useBrowser } from "./store/read";
import { useSidebarOpen, useWindowId, WindowContext } from "./store/hooks";

export function WindowRoot({ windowId }: { windowId?: string }) {
  if (isUtilityWindowId(windowId))
    return (
      <ThemeScope>
        <UtilityWindow id={windowId!} />
        <AppDialogHost windowId={windowId!} />
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
      <ThemeScope>
        {small ? <LittleBayWindow /> : <BrowserWindow />}
        <AppDialogHost windowId={id} />
      </ThemeScope>
    </WindowContext.Provider>
  );
}

function BrowserWindow() {
  const theme = useTheme();
  const sidebarOpen = useSidebarOpen();
  const topTabs = useTabLayout() === "top";
  const windowId = useWindowId();
  const fullscreen = !!useFullscreenTab(windowId);
  // Page full screen hides the sidebar and the strip without unmounting them: they keep their scroll, rows, measured
  // sizes and swipe surface. Moved out of the window rather than made transparent, so nothing in them takes the pointer.
  const showSidebar = sidebarOpen && !topTabs;
  const showStrip = sidebarOpen && topTabs;
  // The sidebar on the window's right (Appearance › Sidebar): the page on its left, the window buttons where they are.
  const right = useSidebarOnRight();
  const addressInSidebar = useAddressBarInSidebar();
  // Windows' caption buttons sit at the other corner: over the page there when it has no toolbar to hold them.
  const captionOnHover = !topTabs && addressInSidebar && (!right || !showSidebar);
  const captionHeight = showStrip ? TOP_STRIP_HEIGHT : layout.cardTop + layout.toolbarHeight;
  const captionCenter = showStrip ? TOP_STRIP_HEIGHT / 2 : layout.cardTop + layout.toolbarHeight / 2;
  const [peekOut, setPeekOut] = useState(false);
  const lights = trafficLightsMode({ addressInSidebar, fullscreen, sidebarOpen, right, topTabs, peekOut });
  const lightsColor = theme.windowTint[0];
  useEffect(() => {
    void setTrafficLightsMode(windowId, lights, lightsColor);
  }, [windowId, lights, lightsColor]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const width = size.width;
  const sidebarWidth = useSidebarWidth(windowId);
  const dock = useSidebarDock(showSidebar);
  // The sidebar's slot narrows to the card's inset as it closes; the sidebar slides out by as much, so its edge stays
  // on the card's (no clipping: the resize handle reaches past it). On the right it's already held at the slot's
  // start, so it goes out past the window's edge as the slot narrows.
  const hiddenBy = right ? 0 : sidebarWidth - layout.cardInset;
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
    <View style={{ flex: 1, flexDirection: right ? "row-reverse" : "row" }} onLayout={(e) => setSize(e.nativeEvent.layout)}>
      <WindowBackdrop vibrancy={theme.glass} {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
      <WindowProfile />
      <SpaceTint />
      {!topTabs && (
        <Animated.View
          pointerEvents={fullscreen || !showSidebar ? "none" : "auto"}
          style={[fullscreen ? { position: "absolute", top: 0, bottom: 0, ...(right ? { left: "100%" } : { right: "100%" }) } : { height: "100%" }, slotStyle]}
        >
          {dock.mounted ? (
            <Animated.View style={[{ width: sidebarWidth, height: "100%" }, dockedStyle]}>
              <SpaceSwipe>
                <Sidebar />
              </SpaceSwipe>
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
                paddingBottom: showStrip ? TOP_CARD_INSET : layout.cardInset,
                // The sidebar's slot (topTabs aside) holds the inset on its side, even closed.
                paddingLeft: showStrip ? TOP_CARD_INSET : !topTabs && !right ? 0 : layout.cardInset,
                paddingRight: showStrip ? TOP_CARD_INSET : right ? 0 : layout.cardInset,
              }
        }
      >
        <ContentCard />
        {!fullscreen && <ExtensionSidePanel />}
      </View>
      {/* No toolbar or sidebar to move the window by: the gap over the page does. */}
      {addressInSidebar && !sidebarOpen && !fullscreen ? (
        <WindowDragRegion style={{ position: "absolute", top: 0, left: 0, right: 0, height: layout.cardTop }} />
      ) : null}
      {showStrip && (
        <View pointerEvents={fullscreen ? "none" : "auto"} style={[{ position: "absolute", left: 0, right: 0 }, fullscreen ? { bottom: "100%" } : { top: 0 }]}>
          <TopTabStrip width={width} hidden={fullscreen} />
        </View>
      )}
      {!sidebarOpen &&
        (topTabs ? <TopStripPeek windowWidth={width} enabled={!fullscreen} /> : <SidebarPeek enabled={!fullscreen} right={right} onOut={setPeekOut} />)}
      {!fullscreen && <CaptionButtons windowId={windowId} height={captionHeight} glyphCenter={captionCenter} onHover={captionOnHover} />}
      <ExtensionOverlays />
      <DownloadMagnet />
      <BookmarkDialog />
      <EditBookmarkDialog />
      <CreateSpaceHost />
      <RenameDialogHost pageLeft={showSidebar && !right ? sidebarWidth : 0} pageRight={showSidebar && right ? sidebarWidth : 0} />
      <SidebarOverlays windowWidth={width} />
      {!fullscreen && <SidebarSiteControls windowWidth={width} windowHeight={size.height} />}
      <DownloadsPanel windowWidth={width} windowHeight={size.height} />
      <CommandPanel
        windowWidth={width}
        windowHeight={size.height}
        navigationInsets={{
          left: showSidebar && !right && !fullscreen ? sidebarWidth : 0,
          right: showSidebar && right && !fullscreen ? sidebarWidth : 0,
          top: showStrip && !fullscreen ? TOP_STRIP_HEIGHT : 0,
        }}
      />
      <ThemeEditorHost />
      <OnboardingOverlay />
    </View>
  );
}

// The page has no toolbar to hold the window buttons with the address bar in the sidebar: it runs up under them. With
// the sidebar on the right they show only while the pointer is over the window's top, as Zen has it; with it closed on
// the left, only with its peek, as Arc has it, so they never sit over the page's corner.
function trafficLightsMode(o: {
  addressInSidebar: boolean;
  fullscreen: boolean;
  sidebarOpen: boolean;
  right: boolean;
  topTabs: boolean;
  peekOut: boolean;
}): TrafficLightsMode {
  if (!o.addressInSidebar || o.fullscreen) return "shown";
  if (!o.sidebarOpen && !o.right && !o.topTabs) return o.peekOut ? "shown" : "hidden";
  return o.right || !o.sidebarOpen ? "hover" : "shown";
}

// DEV: the peek's show, by window, as the pointer reaching the window's edge does (nnPeek(windowId)), and whether
// it's out (nnPeekOut(windowId)).
const devPeeks = new Map<string, () => void>();
const devPeeksOut = new Map<string, boolean>();
if (__DEV__) {
  (globalThis as { nnPeek?: unknown }).nnPeek = (windowId: string) => devPeeks.get(windowId)?.();
  (globalThis as { nnPeekOut?: unknown }).nnPeekOut = (windowId: string) => devPeeksOut.get(windowId) ?? false;
}

function SidebarPeek({ enabled, right, onOut }: { enabled: boolean; right: boolean; onOut: (out: boolean) => void }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const sidebarWidth = useSidebarWidth(windowId);
  const { slide, live, show, hide } = usePeek(enabled);
  useEffect(() => {
    if (!__DEV__) return;
    devPeeks.set(windowId, show);
    return () => void devPeeks.delete(windowId);
  }, [windowId, show]);
  // Holding Option shows it, as Arc's did, and letting go hides it unless the pointer has gone into it meanwhile.
  const pointerIn = useRef(false);
  const heldOut = useRef(false);
  const optionOn = useBrowser((s) => s.settings.showSidebarOnOption);
  const optionEvent = useEffectEvent((type: string, from?: string) => {
    if (type === "optionHeld" && from === windowId && optionOn && enabled) {
      heldOut.current = true;
      show();
    } else if (type === "optionReleased" && heldOut.current) {
      heldOut.current = false;
      if (!pointerIn.current) hide();
    }
  });
  useEffect(() => {
    const sub = onAppEvent((e) => optionEvent(e.type, "windowId" in e ? e.windowId : undefined));
    return () => sub.remove();
  }, []);
  const enter = () => {
    pointerIn.current = true;
    show();
  };
  const leave = () => {
    pointerIn.current = false;
    hide();
  };
  useEffect(() => {
    onOut(live);
    if (__DEV__) devPeeksOut.set(windowId, live);
    return () => onOut(false);
  }, [live, onOut]);
  const slideStyle = useAnimatedStyle(() => {
    "worklet";
    const p = slide.get();
    return { opacity: p, transform: [{ translateX: interpolate(p, [0, 1], [(right ? 1 : -1) * (sidebarWidth + 12), 0]) }] };
  });
  const side = right ? "right" : "left";

  return (
    <>
      {enabled ? <View onMouseEnter={show} style={{ position: "absolute", [side]: 0, top: layout.sidebarHeader, bottom: 0, width: 8 }} /> : null}
      {/* The rest of the window while it's out: the pointer reaching it hides the peek, as leaving the peek does. Its own
          leave alone missed some exits (onto the page, say), leaving it out. */}
      {live ? (
        <View
          pointerEvents="none"
          onMouseEnter={hide}
          style={{ position: "absolute", top: 0, bottom: 0, [side]: 6 + sidebarWidth, [right ? "left" : "right"]: 0 }}
        />
      ) : null}
      <Animated.View
        pointerEvents={live ? "auto" : "none"}
        onMouseEnter={live ? enter : undefined}
        onMouseLeave={live ? leave : undefined}
        style={[
          {
            position: "absolute",
            // Out of the window while hidden (a transform doesn't move hover tracking): its rows mustn't hover under the page.
            [side]: live ? 6 : -10_000,
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
          {/* Swipes between spaces as the docked sidebar does, while it's out. */}
          <SpaceSwipe swipes={live}>
            <Sidebar />
          </SpaceSwipe>
        </Surface>
      </Animated.View>
    </>
  );
}
