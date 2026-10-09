import { useRef } from "react";
import { FadeLabel } from "@bay/shell";
import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { useActiveTab, useTabLive, useWindowId } from "../../store/hooks";
import { splitOf } from "../../store/splits";
import type { Tab } from "../../store/types";
import { useHistoryAvailability } from "../layout/history";
import { toolbarPalette, type ToolbarPalette } from "../layout/toolbarColors";
import { ToolbarButton } from "../layout/controls";
import { addressBarInSidebar, setUrlAnchor, useSidebarOnRight, useSidebarSymbol } from "../layout/windowLayout";
import { SIDEBAR_FIELD } from "../layout/constants";
import { GlassFill, liquidGlass } from "../glass";
import { useHover } from "../primitives";
import { HistoryButton, ReloadButton, UrlField } from "../Toolbar";
import { ADDRESS_BUTTON, ADDRESS_EDGE, ADDRESS_LIGHTS_Y, ADDRESS_NAV_GAP, ADDRESS_NAV_WIDTH, ADDRESS_TOGGLE_X, ADDRESS_TOGGLE_X_RIGHT } from "./constants";

const toggleMinWidth = (x: number) => x + ADDRESS_BUTTON / 2 + ADDRESS_NAV_GAP + ADDRESS_NAV_WIDTH + ADDRESS_EDGE;

export function SidebarHeaderTools({ width }: { width: number }) {
  const windowId = useWindowId();
  const tab = useActiveTab();
  const palette = toolbarPalette(useTheme(), null);
  const top = ADDRESS_LIGHTS_Y - ADDRESS_BUTTON / 2;
  const right = useSidebarOnRight();
  const toggleX = right ? ADDRESS_TOGGLE_X_RIGHT : ADDRESS_TOGGLE_X;
  const sidebarSymbol = useSidebarSymbol();
  return (
    <>
      {width >= toggleMinWidth(toggleX) ? (
        <ToolbarButton
          style={{ position: "absolute", top, left: toggleX - ADDRESS_BUTTON / 2 }}
          palette={palette}
          icon={sidebarSymbol}
          onPress={() => useBrowser.getState().toggleSidebar(windowId)}
          tooltip="Auto-Hide Tabs (⌘S)"
        />
      ) : null}
      <View style={{ position: "absolute", top, right: ADDRESS_EDGE, flexDirection: "row", gap: ADDRESS_NAV_GAP }}>
        {tab ? <NavigationButtons tab={tab} palette={palette} /> : null}
      </View>
    </>
  );
}

const alreadyFocused = () => {};

function NavigationButtons({ tab, palette }: { tab: Tab; palette: ToolbarPalette }) {
  const loading = useTabLive(tab.id, (l) => l.isLoading);
  const history = useHistoryAvailability(tab.id);
  return (
    <>
      <HistoryButton tab={tab} direction={-1} disabled={!history.back} palette={palette} onFocus={alreadyFocused} />
      <HistoryButton tab={tab} direction={1} disabled={!history.forward} palette={palette} onFocus={alreadyFocused} />
      <ReloadButton tab={tab} loading={loading} palette={palette} onFocus={alreadyFocused} />
    </>
  );
}

export function SidebarAddressRow() {
  const windowId = useWindowId();
  const tab = useActiveTab();
  const field = useRef<View>(null);
  const anchor = () =>
    field.current?.measureInWindow((x, y, width, height) => {
      if (width && addressBarInSidebar(useBrowser.getState(), windowId)) setUrlAnchor(windowId, { left: x, top: y, width, sidebar: { height } });
    });

  return (
    <View
      ref={field}
      onLayout={anchor}
      style={{ position: "absolute", left: layout.sidebarInset, right: layout.sidebarInset, top: SIDEBAR_FIELD.top, height: SIDEBAR_FIELD.height }}
    >
      {tab?.url ? <PageField tab={tab} windowId={windowId} /> : <EmptyField windowId={windowId} />}
    </View>
  );
}

function PageField({ tab, windowId }: { tab: Tab; windowId: string }) {
  const palette = toolbarPalette(useTheme(), null);
  const inSplit = useBrowser((s) => !!splitOf(s, tab.id));
  return (
    <UrlField
      tab={tab}
      palette={palette}
      windowId={windowId}
      inSplit={inSplit}
      onFocus={alreadyFocused}
      sidebar={{ height: SIDEBAR_FIELD.height }}
    />
  );
}

function EmptyField({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const open = () => {
    useBrowser.getState().openPanel(windowId, "");
  };
  return (
    <View {...hoverProps}>
      <Pressable onPress={open}>
        <View
          style={{
            height: SIDEBAR_FIELD.height,
            borderRadius: SIDEBAR_FIELD.radius,
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderColor: liquidGlass ? "transparent" : theme.pinnedRestingStroke,
            backgroundColor: liquidGlass ? undefined : hovered ? theme.tabHover : theme.pinnedResting,
            justifyContent: "center",
            paddingLeft: 10,
          }}
        >
          {liquidGlass ? <GlassFill radius={SIDEBAR_FIELD.radius} border={StyleSheet.hairlineWidth * 2} fill={hovered ? theme.tabHover : theme.pinnedResting} /> : null}
          <FadeLabel text="Search or enter address" fontSize={13} color={theme.placeholder} fadeWidth={14} style={{ height: 18, marginLeft: -2 }} />
        </View>
      </Pressable>
    </View>
  );
}
