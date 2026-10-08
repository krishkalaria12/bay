import { WebView } from "@bay/nncore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { layout, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { openFromPage, pageProfileId } from "../layout/openFromPage";
import { IconButton } from "../primitives";
import { closeSidePanel, findExtension, showExtensionMenu, useExtensions, type SidePanel } from "./state";

const MIN_WIDTH = 320;
const MAX_WIDTH = 600;
const HEADER = 40;

function rubberBand(width: number): number {
  const band = (over: number) => 36 * (1 - Math.exp(-over / 90));
  if (width > MAX_WIDTH) return MAX_WIDTH + band(width - MAX_WIDTH);
  if (width < MIN_WIDTH) return MIN_WIDTH - band(MIN_WIDTH - width);
  return width;
}
const clamp = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

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
  // Let go past its range, the edge springs back on the UI thread, each frame setting the width.
  const springWidth = useSharedValue(0);
  const springing = useSharedValue(false);
  useAnimatedReaction(
    () => (springing.get() ? springWidth.get() : null),
    (w) => {
      if (w !== null) runOnJS(setDragWidth)(w);
    },
  );
  useEffect(() => {
    if (panel) setShown(panel);
  }, [panel?.url, panel?.extensionId]);

  const width = dragWidth ?? savedWidth;
  const start = useRef(width);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          start.current = useBrowser.getState().settings.extensionSidePanelWidth ?? 360;
          setDragWidth(start.current);
        },
        onPanResponderMove: (_, g) => setDragWidth(rubberBand(start.current - g.dx)),
        onPanResponderRelease: (_, g) => {
          const raw = rubberBand(start.current - g.dx);
          const target = clamp(raw);
          const finish = () => {
            useBrowser.getState().updateSettings({ extensionSidePanelWidth: target });
            setDragWidth(null);
          };
          if (raw === target) return finish();
          springWidth.set(raw);
          springing.set(true);
          springWidth.set(
            withTiming(target, { duration: 260, easing: Easing.out(Easing.back(1.2)) }, () => {
              springing.set(false);
              runOnJS(finish)();
            }),
          );
        },
        onPanResponderTerminate: () => setDragWidth(null),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  const room = width + layout.cardInset - 1;
  const roomStyle = useAnimatedStyle(() => ({ width: appear.get() * room }), [room]);
  const fade = useAnimatedStyle(() => ({ opacity: appear.get() }));
  if (!shown) return null;
  return (
    <Animated.View style={[{ overflow: "hidden" }, roomStyle]}>
      <Animated.View style={[{ position: "absolute", top: 0, bottom: 0, right: 0, width: width }, fade]}>
        <PanelCard key={`${shown.extensionId}|${shown.pageProfile}|${shown.url}`} windowId={windowId} panel={shown} />
        <View
          {...responder.panHandlers}
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
