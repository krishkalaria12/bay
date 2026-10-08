import { ContextMenuArea, Symbol, WindowDragRegion } from "@bay/shell";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { layout, useTheme } from "../../lib/theme";
import { webviews } from "../../lib/webviews";
import { useBrowser } from "../../store/browser";
import { useTabLive } from "../../store/hooks";
import { ToolbarButton } from "../layout/controls";
import type { ToolbarGeometry } from "../layout/geometry";
import { useHistoryAvailability } from "../layout/history";
import { setPopover, usePages } from "../layout/pageState";
import { closePane, showSplitMenu } from "../layout/splitActions";
import { toolbarPalette } from "../layout/toolbarColors";
import { useSidebarSymbol } from "../layout/windowLayout";
import { showUrlBarMenu } from "../omnibox/paste";
import { useHover } from "../primitives";
import { copyPageUrl } from "../site/selection";
import { HistoryButton, ReloadButton, TabProgressBar } from "../Toolbar";
import { copyScreenshot } from "./screenshot";
import { toggleInspecting, useIsInspecting } from "./devMode";
import { isLocalDevSite } from "./sites";

/** The bar over a page in Developer Mode, sidebar address or not: its own band on the page's top. */
export const DEV_BAR_HEIGHT = 36;
const MONO = "Menlo";
const STRIPE_GAP = 7;

/**
 * A page in Developer Mode's bar, as yab has it: its whole address on a hatched band, with the inspector, DevTools, its
 * link, a screenshot and its site's controls at the end. With tabs on top it stands in for the toolbar, so it carries
 * the back, forward and reload buttons there too (`navigation`).
 */
export function DevBar({
  tabId,
  windowId,
  geometry,
  navigation,
  inSplit,
  focused,
}: {
  tabId: string;
  windowId: string;
  geometry: ToolbarGeometry;
  navigation: boolean;
  inSplit: boolean;
  focused: boolean;
}) {
  const theme = useTheme();
  const palette = toolbarPalette(theme, null);
  const tab = useBrowser(useShallow((s) => (s.tabs[tabId] ? { id: tabId, url: s.tabs[tabId]!.url, windowId: s.tabs[tabId]!.windowId } : undefined)));
  const loading = useTabLive(tabId, (l) => l.isLoading);
  const history = useHistoryAvailability(tabId);
  const inspecting = useIsInspecting(tabId);
  const controlsOpen = usePages((s) => s.popover[tabId] === "siteControls");
  const [width, setWidth] = useState(0);
  const sidebarSymbol = useSidebarSymbol();
  const focus = () => {
    if (!focused) useBrowser.getState().activate(tabId);
  };
  const height = navigation ? layout.toolbarHeight : DEV_BAR_HEIGHT;
  if (!tab) return <View style={{ height }} />;
  const center = navigation ? 21.2 : DEV_BAR_HEIGHT / 2;
  const at = (x: number | null) => ({ position: "absolute" as const, top: center - layout.toolbarButton / 2, left: (x ?? 0) - layout.toolbarButton / 2 });
  const button = (icon: string, tooltip: string, onPress: () => void, active = false) => (
    <ToolbarButton
      palette={palette}
      icon={icon}
      size={13}
      box={26}
      radius={7}
      style={active ? { borderRadius: 7, backgroundColor: palette.pressed } : undefined}
      onPress={() => {
        focus();
        onPress();
      }}
      tooltip={tooltip}
    />
  );

  return (
    <View style={{ height, backgroundColor: theme.card }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Hatch width={width} height={height} color={theme.dark ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.05)"} />
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      {navigation && geometry.sidebarButton !== null ? (
        <ToolbarButton style={at(geometry.sidebarButton)} palette={palette} icon={sidebarSymbol} onPress={() => useBrowser.getState().toggleSidebar(windowId)} tooltip="Auto-Hide Tabs (⌘S)" />
      ) : null}
      {navigation ? (
        <>
          <HistoryButton style={at(geometry.back)} tab={tab} direction={-1} disabled={!history.back} palette={palette} onFocus={focus} />
          <HistoryButton style={at(geometry.forward)} tab={tab} direction={1} disabled={!history.forward} palette={palette} onFocus={focus} />
          <ReloadButton style={at(geometry.reload)} tab={tab} loading={loading} palette={palette} onFocus={focus} />
        </>
      ) : null}
      <View pointerEvents="box-none" style={{ position: "absolute", left: navigation ? geometry.urlLeft : geometry.urlLeft - 2, right: 6, top: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 2 }}>
        <Address url={tab.url} tabId={tabId} windowId={windowId} onFocus={focus} />
        {button("ruler", inspecting ? "Stop Inspecting (esc)" : "Inspect Elements", () => toggleInspecting(tabId), inspecting)}
        {button("chevron.left.forwardslash.chevron.right", "Developer Tools (⌥⌘I)", () => void webviews.get(tabId)?.showDevTools("toggle"))}
        {button("link", "Copy Link", () => void copyPageUrl(tabId))}
        {button("camera", "Copy Screenshot", () => void copyScreenshot(tabId))}
        {button("slider.horizontal.3", "Site Controls", () => setPopover(tabId, controlsOpen ? null : "siteControls"), controlsOpen)}
        {inSplit ? (
          <>
            {button("rectangle.split.2x1", "Split View", () => showSplitMenu(tabId))}
            {button("xmark", "Close Pane", () => closePane(tabId))}
          </>
        ) : null}
        {navigation && geometry.sidebarButtonEnd ? button(sidebarSymbol, "Auto-Hide Tabs (⌘S)", () => useBrowser.getState().toggleSidebar(windowId)) : null}
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.divider }} />
      {loading && <TabProgressBar tabId={tabId} color={theme.accent} />}
    </View>
  );
}

// The whole address, in a monospaced face: its scheme quieter than the rest. Opens the command bar with it, as the
// address field does.
function Address({ url, tabId, windowId, onFocus }: { url: string; tabId: string; windowId: string; onFocus: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(url)?.[0] ?? "";
  const secure = url.startsWith("https:") || isLocalDevSite(url);
  return (
    <View {...hoverProps} style={{ flex: 1, height: 28 }}>
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => {
        const tab = useBrowser.getState().tabs[tabId];
        if (tab) void showUrlBarMenu(tab);
      }}>
        <Pressable
          onPress={() => {
            onFocus();
            useBrowser.getState().openPanel(windowId, url);
          }}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: 7, backgroundColor: hovered ? theme.toolbarHover : undefined }}
        >
          <Symbol name={secure ? "lock" : "lock.open"} size={11} color={theme.textSecondary} style={{ width: 14, height: 16 }} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontFamily: MONO, color: theme.textPrimary }}>
            <Text style={{ color: theme.textSecondary }}>{scheme}</Text>
            {url.slice(scheme.length)}
          </Text>
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

// Diagonal hairlines across the band, as a workbench's tape: thin views, turned, every few points.
const Hatch = memo(function Hatch({ width, height, color }: { width: number; height: number; color: string }) {
  if (!width) return null;
  const length = height * Math.SQRT2 + 2;
  const count = Math.ceil((width + height) / STRIPE_GAP);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: i * STRIPE_GAP - height / 2,
            top: (height - length) / 2,
            width: 1,
            height: length,
            backgroundColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ))}
    </View>
  );
});
