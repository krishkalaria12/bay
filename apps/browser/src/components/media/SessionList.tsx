import { Pressable, ScrollView, View } from "@bay/platform";
import { useEffect, useRef } from "react";
import { Text } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { switchToTab } from "../../lib/actions";
import { useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useTab } from "../../store/hooks";
import { Popover, PromptButton } from "../layout/controls";
import { useSidebarOnRight } from "../layout/windowLayout";
import { Favicon, IconButton, useHover } from "../primitives";
import { hostOf, isPlaying, mediaCommand, pauseAllMedia, toggleMediaTabMute, useMedia, useSession } from "./state";

export function useWindowMediaTabs(windowId: string): string[] {
  // Session updates include the playback clock. Only changing membership re-renders the list's parent.
  const candidates = useMedia(useShallow((m) => Object.keys(m.sessions).filter((id) => ["playing", "paused"].includes(m.sessions[id]!.playbackState))));
  return useBrowser(useShallow((s) => candidates.filter((id) => s.tabs[id]?.windowId === windowId)));
}

export function MediaSessionButton({ windowId, count }: { windowId: string; count: number }) {
  const theme = useTheme();
  const anchor = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  const open = () => {
    if (useMedia.getState().sessionList?.windowId === windowId) {
      closeSessionList();
      return;
    }
    anchor.current?.measureInWindow((x, y, width, height) => {
      if (width) useMedia.setState({ sessionList: { windowId, anchor: { x, y, width, height } } });
    });
  };
  return (
    <View ref={anchor} {...hoverProps} tooltip={`Show all ${count} media tabs`}>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`Show all ${count} media tabs`}>
        <View
          style={{
            height: 24,
            minWidth: 28,
            paddingHorizontal: 5,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: hovered ? theme.toolbarHover : undefined,
          }}
        >
          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.textSecondary }}>+{count - 1}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function closeSessionList() {
  useMedia.setState({ sessionList: null });
}

export function MediaSessionsOverlay({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const list = useMedia((m) => (m.sessionList?.windowId === windowId ? m.sessionList : null));
  return list && windowWidth && windowHeight ? (
    <SessionPanel key={windowId} windowId={windowId} anchor={list.anchor} windowWidth={windowWidth} windowHeight={windowHeight} />
  ) : null;
}

function SessionPanel({
  windowId,
  anchor,
  windowWidth,
  windowHeight,
}: {
  windowId: string;
  anchor: { x: number; y: number; width: number; height: number };
  windowWidth: number;
  windowHeight: number;
}) {
  const theme = useTheme();
  const ids = useWindowMediaTabs(windowId);
  const right = useSidebarOnRight();
  const scroll = useRef<ScrollView>(null);
  const playing = useMedia((m) => ids.some((id) => isPlaying(m.sessions[id])));
  const windowExists = useBrowser((s) => !!s.windows[windowId]);
  useEffect(() => {
    if (!ids.length || !windowExists) closeSessionList();
  }, [ids.length, windowExists]);
  useEffect(() => {
    const timer = setTimeout(() => (scroll.current as unknown as { focus?: () => void } | null)?.focus?.(), 50);
    return () => clearTimeout(timer);
  }, []);
  if (!ids.length || !windowExists) return null;
  const width = Math.min(400, windowWidth - 16);
  const height = Math.min(56 + ids.length * 48, 344, windowHeight - 16);
  const x = right ? anchor.x + anchor.width - width : anchor.x;
  const left = Math.max(8, Math.min(windowWidth - width - 8, x));
  const top = Math.max(8, Math.min(windowHeight - height - 8, anchor.y - height - 8));
  return (
    <Popover width={width} top={top} left={left} onDismiss={closeSessionList}>
      <View style={{ height, padding: 8 }}>
        <View style={{ height: 32, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: theme.textPrimary }}>Media Tabs</Text>
          <Pressable onPress={() => pauseAllMedia(windowId)} disabled={!playing} accessibilityRole="button" accessibilityLabel="Pause All">
            <Text style={{ fontSize: 12, fontWeight: "500", color: playing ? theme.accent : theme.textTertiary }}>Pause All</Text>
          </Pressable>
          <IconButton icon="xmark" size={10} box={24} tooltip="Close Media Tabs" onPress={closeSessionList} />
        </View>
        <ScrollView
          ref={scroll}
          focusable
          enableFocusRing={false}
          keyDownEvents={[{ key: "Escape" }]}
          onKeyDown={(e) => {
            if (e.nativeEvent.key === "Escape") closeSessionList();
          }}
          style={{ flex: 1, marginTop: 8 }}
        >
          {ids.map((tabId) => (
            <SessionRow key={tabId} tabId={tabId} />
          ))}
        </ScrollView>
      </View>
    </Popover>
  );
}

function SessionRow({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const session = useSession(tabId);
  const { hovered, hoverProps } = useHover();
  if (!tab || !session) return null;
  const playing = isPlaying(session);
  const go = () => {
    closeSessionList();
    switchToTab(tabId);
  };
  return (
    <View
      {...hoverProps}
      style={{
        height: 48,
        borderRadius: 7,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 4,
        gap: 6,
        backgroundColor: hovered ? theme.rowHover : undefined,
      }}
    >
      <Favicon url={tab.url} favicon={tab.favicon} spaceId={tab.spaceId} size={18} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "500", color: theme.textPrimary }}>
          {session.title || tab.title || hostOf(tab.url)}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 10.5, color: theme.textSecondary }}>
          {hostOf(tab.url)} · {playing ? "Playing" : "Paused"}
        </Text>
      </View>
      <IconButton
        icon={playing ? "pause.fill" : "play.fill"}
        size={12}
        box={26}
        tooltip={playing ? "Pause Tab" : "Play Tab"}
        onPress={() => mediaCommand(tabId, "toggle")}
      />
      <IconButton
        icon={tab.muted ? "speaker.slash.fill" : "speaker.wave.2.fill"}
        size={12}
        box={26}
        tooltip={tab.muted ? "Unmute Tab" : "Mute Tab"}
        onPress={() => toggleMediaTabMute(tabId)}
      />
      <PromptButton title="Go to Tab" onPress={go} />
    </View>
  );
}
