import { WebView } from "@bay/nncore";
import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { layout, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { openFromPage, pageProfileId } from "../layout/openFromPage";
import { useResizeDrag } from "../layout/useResizeDrag";
import { IconButton } from "../primitives";
import { closeSidePanel, findExtension, showExtensionMenu, useExtensions, type SidePanel } from "./state";

const MIN_WIDTH = 320;
const MAX_WIDTH = 600;
const HEADER = 40;


export function ExtensionSidePanel() {
  const windowId = useWindowId();
  const panel = useExtensions((e) => e.sidePanels[windowId]);
  const savedWidth = useBrowser((s) => s.settings.extensionSidePanelWidth ?? 360);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const appear = useSharedValue(0);
  const [shown, setShown] = useState(panel);

  useEffect(() => {
    if (panel) setShown(panel);
    const gone = () => setShown(undefined);
    // A width: the page beside it narrows.
    appear.set(
      withTiming(panel ? 1 : 0, { duration: 200, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished && !panel) runOnJS(gone)();
      }),
    );
  }, [!!panel]);
  useEffect(() => {
    if (panel) setShown(panel);
  }, [panel?.url, panel?.extensionId]);

  const width = dragWidth ?? savedWidth;
  const resize = useResizeDrag({
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    direction: -1,
    saved: () => useBrowser.getState().settings.extensionSidePanelWidth ?? 360,
    onLive: setDragWidth,
    onCommit: (w) => useBrowser.getState().updateSettings({ extensionSidePanelWidth: w }),
  });

  const room = width + layout.cardInset - 1;
  const roomStyle = useAnimatedStyle(() => ({ width: appear.get() * room }), [room]);
  const fade = useAnimatedStyle(() => ({ opacity: appear.get() }));
  if (!shown) return null;
  return (
    <Animated.View style={[{ overflow: "hidden" }, roomStyle]}>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, right: 0, width: width }, fade]}>
        <PanelCard key={`${shown.extensionId}|${shown.pageProfile}|${shown.url}`} windowId={windowId} panel={shown} />
        <View
          {...resize}
          onDoubleClick={() => useBrowser.getState().updateSettings({ extensionSidePanelWidth: 360 })}
          style={{ position: "absolute", top: 0, bottom: 0, left: -3, width: 7, cursor: "col-resize" }}
        />
      </Animated.View>
    </Animated.View>
  );
}

function PanelCard({ windowId, panel }: { windowId: string; panel: SidePanel }) {
  const { extensionId, profile, pageProfile, url } = panel;
  const theme = useTheme();
  const ext = useExtensions((e) => e.lists[profile]?.find((x) => x.id === extensionId));
  const title = ext?.actionTitle || ext?.name || "Extension";
  const icon = ext?.actionIcon || ext?.icon;
  return (
    <View style={{ flex: 1, borderRadius: layout.cardRadius, overflow: "hidden", backgroundColor: theme.card }}>
      <View style={{ height: HEADER, flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 5, gap: 8 }}>
        {icon ? <Image source={{ uri: icon }} style={{ width: 16, height: 16 }} /> : null}
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontWeight: "500", color: theme.textPrimary }}>
          {title}
        </Text>
        <IconButton
          icon="ellipsis"
          size={13}
          tooltip="More"
          onPress={() => {
            const found = findExtension(profile, extensionId);
            if (found) void showExtensionMenu(windowId, found);
          }}
        />
        <IconButton icon="xmark" size={12} weight="medium" tooltip="Close Side Panel" onPress={() => closeSidePanel(windowId)} />
      </View>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" }} />
      <View style={{ flex: 1, backgroundColor: "#FFFFFF" }}>
        <WebView
          style={StyleSheet.absoluteFill}
          url={url}
          profile={pageProfile}
          standalone
          extensionHost="sidePanel"
          pageBackgroundColor="#FFFFFF"
          onWindowClose={() => closeSidePanel(windowId, extensionId)}
          onOpenWindow={(request) => openFromPage(request, { windowId, profileId: pageProfileId(windowId, pageProfile) })}
        />
      </View>
    </View>
  );
}
