import { Pressable, TextInput, View } from "@bay/platform";
import { ActivitySpinner, ContextMenuArea, FadeLabel, MouseArea, Surface, Symbol } from "@bay/shell";
import { memo, useEffect, useRef, useState } from "react";
import { type GestureResponderEvent } from "react-native";
import Animated from "@bay/platform/motion";
import { closeTab, toggleMute } from "../../lib/actions";
import { hex, useTheme } from "../../lib/theme";
import { useBrowser, type BrowserState } from "../../store/browser";
import { activeTabId, pinnedPage } from "../../store/model";
import type { Tab } from "../../store/types";
import { useIsActiveTab, usePageSpaceId, useTab, useWindowId } from "../../store/hooks";
import { HoverSlot } from "../HoverSlot";
import { ActiveHighlight } from "./ActiveHighlight";
import { IconButton } from "../primitives";
import { clickTab, commitRename, endRename, startRename, tabTitle } from "./actions";
import { useDragItem } from "./dnd";
import { dismissHover, useRowHover } from "./hover";
import { openTabMenu } from "./menus";
import { registerRow, useSidebarUi } from "./state";
import { TabIcon } from "./TabIcon";
import { TabBadges } from "../media/TabBadges";
import { useSidebarMetrics, useSidebarTokens } from "./tokens";
import { isEscapeKey } from "../../lib/escapeKey";
import { isDeveloperTab } from "../developer/sites";
import { DEVELOPER_YELLOW } from "../developer/constants";

export const clickMods = (e: GestureResponderEvent) => {
  const n = e.nativeEvent as unknown as { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean };
  return { metaKey: !!n.metaKey, ctrlKey: !!n.ctrlKey, shiftKey: !!n.shiftKey, altKey: !!n.altKey };
};

const selectionOf = (windowId: string) => () => useBrowser.getState().selection[windowId] ?? [];

export const TabRowItem = memo(function TabRowItem({
  tabId,
  section,
  parentGroup,
}: {
  tabId: string;
  section: "list" | "pinned" | "pinnedGroups";
  parentGroup?: string;
}) {
  const windowId = useWindowId();
  const { ref, style, handle } = useDragItem(`t:${tabId}`, { kind: "row", tabIds: [tabId], section, parentGroup }, selectionOf(windowId));
  return (
    <Animated.View ref={ref} style={style} {...handle}>
      <TabRow tabId={tabId} />
    </Animated.View>
  );
});

const ACTIVE = 1;
const SELECTED = 2;
const PLAYING = 4;
const LOADING = 8;

function rowFlags(s: BrowserState, windowId: string, tabId: string): number {
  const tab = s.tabs[tabId];
  const live = s.live[tabId];
  let flags = 0;
  // The row's window's: another window on the space shows its own tab.
  if (tab && activeTabId(s, windowId, tab.spaceId) === tabId) flags |= ACTIVE;
  if (s.selection[windowId]?.includes(tabId)) flags |= SELECTED;
  if (live?.playingAudio) flags |= PLAYING;
  if (live?.isLoading) flags |= LOADING;
  return flags;
}

// A pinned row isn't closed, only unloaded (Arc's −): it stays, back at its pinned page. Once closed, its × removes
// it, as Arc's does.
function closeButton(tab: Pick<Tab, "id" | "pinnedRow" | "unloaded">) {
  if (!tab.pinnedRow) return { icon: "xmark", tooltip: "Close Tab (⌘W)", onPress: () => void closeTab(tab.id) };
  if (tab.unloaded) return { icon: "xmark", tooltip: "Remove Pinned Tab", onPress: () => useBrowser.getState().removeTab(tab.id) };
  return { icon: "minus", tooltip: "Unload Tab (⌘W)", onPress: () => void closeTab(tab.id) };
}

export function TabRow({ tabId }: { tabId: string }) {
  const metrics = useSidebarMetrics();
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  // The row's flags in one number: a sidebar has hundreds of rows, and each selector runs on every store update.
  const flags = useBrowser((s) => rowFlags(s, windowId, tabId));
  const active = !!(flags & ACTIVE);
  const selected = !!(flags & SELECTED);
  const playingAudio = !!(flags & PLAYING);
  const loading = !!(flags & LOADING);
  // The shown tab of a site in Developer Mode: outlined, as its bar is hatched.
  const developer = useBrowser((s) => active && isDeveloperTab(s, tabId));
  const renaming = useSidebarUi((u) => u.renaming?.kind === "tab" && u.renaming.id === tabId);
  const { hovered, hoverProps } = useRowHover(windowId, renaming ? null : { kind: "tab", id: tabId });
  if (!tab) return null;
  const title = tabTitle(tab);
  // The active row's fill is its ActiveHighlight's, under it.
  const fill = active ? "rgba(0,0,0,0)" : selected ? tokens.multiSelected : hovered ? theme.tabHover : "rgba(0,0,0,0)";
  const border = selected && !active ? 0.5 : 0;

  return (
    <View ref={(v) => registerRow(windowId, tabId, v)} {...hoverProps} onDoubleClick={() => void startRename(windowId, { kind: "tab", id: tabId })}>
      <MouseArea onMiddleClick={() => void closeTab(tabId)}>
        <ContextMenuArea
          onContextMenu={() => {
            dismissHover();
            void openTabMenu(windowId, tab);
          }}
        >
          <Pressable
            onPress={(e) => {
              dismissHover();
              clickTab(windowId, tabId, clickMods(e));
            }}
          >
            {({ pressed }) => (
              <View>
                <ActiveHighlight active={active} tabIds={[tabId]} borderWidth={0.5} />
                <Surface
                  fill={hex(!active && pressed ? theme.tabPressed : fill)}
                  cornerRadius={10}
                  borderWidth={border}
                  borderColor={border ? hex(tokens.multiSelectedStroke) : undefined}
                  style={{ height: metrics.rowHeight, flexDirection: "row", alignItems: "center", paddingLeft: 9 - border, paddingRight: 6 - border }}
                >
                  <View>
                    <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} spaceId={tab.spaceId} />
                    <TabBadges tabId={tab.id} />
                  </View>
                  {(playingAudio || tab.muted) && (
                    <Pressable onPress={() => toggleMute(tab.id)} style={{ marginLeft: 6 }} tooltip={tab.muted ? "Unmute Site" : "Mute Site"}>
                      <Symbol name={tab.muted ? "speaker.slash" : "speaker.wave.2"} size={12} color={theme.textTab} style={{ width: 18, height: 16 }} />
                    </Pressable>
                  )}
                  {renaming ? (
                    <RenameField
                      initial={tab.customTitle ?? tab.title}
                      placeholder={tab.title || "Tab name"}
                      color={active ? theme.tabSelectedText : theme.textPrimary}
                      onDone={(text) => (text === null ? endRename({ kind: "tab", id: tabId }) : commitRename({ kind: "tab", id: tabId }, text))}
                    />
                  ) : (
                    <FadeLabel
                      text={title}
                      fontSize={13}
                      color={active ? theme.tabSelectedText : theme.textTab}
                      style={{ flex: 1, height: 18, marginLeft: 5 }}
                    />
                  )}
                  <HoverSlot
                    hovered={hovered && !renaming}
                    width={22}
                    hover={<IconButton {...closeButton(tab)} size={10} weight="semibold" box={22} radius={6} />}
                  >
                    {loading && <ActivitySpinner style={{ width: 12, height: 12, marginRight: 2 }} />}
                  </HoverSlot>
                </Surface>
                {developer ? (
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: 0,
                      bottom: 0,
                      borderRadius: 10,
                      borderWidth: 1.5,
                      borderStyle: "dashed",
                      borderColor: DEVELOPER_YELLOW,
                    }}
                  />
                ) : null}
              </View>
            )}
          </Pressable>
        </ContextMenuArea>
      </MouseArea>
    </View>
  );
}

export function RenameField({
  initial,
  placeholder,
  color,
  fontSize = 13,
  weight,
  onDone,
}: {
  initial: string;
  placeholder: string;
  color: string;
  fontSize?: number;
  weight?: "500" | "600";
  onDone(text: string | null): void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const input = useRef<TextInput>(null);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <TextInput
      ref={input}
      value={text}
      onChangeText={setText}
      placeholder={placeholder}
      placeholderTextColor={theme.placeholder}
      selectionColor={theme.selection}
      selectTextOnFocus
      enableFocusRing={false}
      onSubmitEditing={() => finish(text)}
      onBlur={() => finish(text)}
      keyDownEvents={[{ key: "Escape" }]}
      onKeyPress={(e) => isEscapeKey(e) && finish(null)}
      style={{ flex: 1, height: 18, marginLeft: 5, fontSize, fontWeight: weight, color, paddingVertical: 0, paddingHorizontal: 0 }}
    />
  );
}

export const SplitRowItem = memo(function SplitRowItem({
  splitId,
  section,
  parentGroup,
}: {
  splitId: string;
  section: "list" | "pinned" | "pinnedGroups";
  parentGroup?: string;
}) {
  const metrics = useSidebarMetrics();
  const windowId = useWindowId();
  const tabIds = useBrowser((s) => s.splits[splitId]?.tabIds.filter((id) => s.tabs[id] && !pinnedPage(s.tabs[id]!)).join(",") ?? "")
    .split(",")
    .filter(Boolean);
  const { ref, style, handle } = useDragItem(`s:${splitId}`, { kind: "split", tabIds, section, parentGroup });
  const theme = useTheme();
  const spaceId = usePageSpaceId();
  const active = useBrowser((s) => tabIds.includes(s.windows[windowId]?.activeTabIds[spaceId] ?? ""));
  const { hovered, hoverProps } = useRowHover(windowId, null);
  if (tabIds.length < 2) return null;
  return (
    <Animated.View ref={ref} style={style} {...handle}>
      <View ref={(v) => registerRow(windowId, `s:${splitId}`, v)} {...hoverProps}>
        <ActiveHighlight active={active} tabIds={tabIds} borderWidth={1} />
        <Surface
          fill={hex(!active && hovered ? theme.tabHover : "rgba(0,0,0,0)")}
          cornerRadius={10}
          style={{ height: metrics.rowHeight, flexDirection: "row", alignItems: "center", paddingHorizontal: 3 }}
        >
          {tabIds.map((id, i) => (
            <View key={id} style={{ flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 }}>
              {i > 0 && <View style={{ width: 1, height: 16, backgroundColor: theme.divider, marginRight: 2 }} />}
              <SplitPane tabId={id} windowId={windowId} />
            </View>
          ))}
        </Surface>
      </View>
    </Animated.View>
  );
});

function SplitPane({ tabId, windowId }: { tabId: string; windowId: string }) {
  const metrics = useSidebarMetrics();
  const theme = useTheme();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const { hovered, hoverProps } = useRowHover(windowId, { kind: "tab", id: tabId });
  if (!tab) return null;
  return (
    <View {...hoverProps} style={{ flex: 1, minWidth: 0 }}>
      <ContextMenuArea onContextMenu={() => void openTabMenu(windowId, tab)}>
        <Pressable onPress={(e) => clickTab(windowId, tabId, clickMods(e))}>
          <View
            style={{
              height: metrics.rowHeight - 6,
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: 6,
              backgroundColor: hovered && !active ? theme.rowHover : undefined,
            }}
          >
            <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
            <FadeLabel
              text={tabTitle(tab)}
              fontSize={12}
              color={active ? theme.tabSelectedText : theme.textTab}
              style={{ flex: 1, height: 16, marginLeft: 5 }}
            />
          </View>
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}
