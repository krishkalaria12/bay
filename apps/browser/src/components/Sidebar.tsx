import { LibraryButton } from "./library/LibraryButton";
import { ContextMenuArea, FadeLabel, MouseArea, Symbol, WindowDragRegion } from "@bay/shell";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { cycleSpace } from "../lib/actions";
import { ThemeScope, useTheme } from "../lib/theme";
import { layout } from "../lib/constants";
import { everySlowly } from "../lib/slowTimers";
import { useEffectEvent } from "../lib/useEffectEvent";
import { useBrowser } from "../store/browser";
import { PageSpaceContext, useIsIncognito, useSettings, useWindowId, useWindowSpaceId } from "../store/hooks";
import { activeTabId, listIds, spaceFolded, spaceHeaderHidden, windowListKey } from "../store/model";
import { cleanUpCandidates } from "../store/organize";
import { openNewTabInSplit } from "./layout/splitActions";
import { listTopGap, useAddressBarInSidebar, useSidebarFieldShown, useSidebarOnRight } from "./layout/windowLayout";
import { SIDEBAR_FIELD, SIDEBAR_FOOTER_DOWNLOADS } from "./layout/constants";
import { SidebarPlayer, useSidebarPlayerTab } from "./media/SidebarPlayer";
import { SIDEBAR_PLAYER_HEIGHT } from "./media/constants";
import { IconButton, useHover } from "./primitives";
import { PROFILE_DOTS_HEIGHT, PROFILE_INDICATOR_X } from "./spaces/constants";
import { usePageStyle, usePagerPages } from "./layout/spacePager";
import { SpaceSwitcher } from "./spaces/SpaceSwitcher";
import { SpaceTitle } from "./sidebar/SpaceTitle";
import { clearableTabs, clearTabs } from "./sidebar/clear";
import { UPDATE_ROW_HEIGHT, UpdateRow, useUpdateRowShown } from "./sidebar/UpdateRow";
import { SidebarAddressRow, SidebarHeaderTools } from "./sidebar/AddressBar";
import { DragGhost } from "./sidebar/DragGhost";
import { FinderDropZone, DragProvider, DragScope, useDragController, useDragItem, type Ghost } from "./sidebar/dnd";
import { sidebarEntries, useSidebarEntries } from "./sidebar/entries";
import { FolderBlock } from "./sidebar/FolderBlock";
import { FoldAway, useFold } from "./sidebar/Fold";
import { GroupBlock } from "./sidebar/GroupBlock";
import { dismissHover } from "./sidebar/hover";
import { LocalFiles } from "./sidebar/LocalFiles";
import { LiveFolders } from "./sidebar/LiveFolderBlock";
import { openOverflowMenu, openSidebarMenu } from "./sidebar/menus";
import { PinDropZone, PinnedGrid } from "./sidebar/PinnedGrid";
import { ResizeHandle } from "./sidebar/ResizeHandle";
import { entriesHeight, offscreenSide, rowSpan, type Section } from "./sidebar/geometry";
import { OffscreenTabMarker } from "./sidebar/OffscreenTabMarker";
import { SidebarKeyboardScope, useSidebarKeyboard } from "./sidebar/keyboardFocus";
import { measureRow } from "./sidebar/state";
import { SplitRowItem, TabRowItem } from "./sidebar/TabRow";
import { ClosingTabRow, OpeningRow, useRowMotion } from "./sidebar/RowMotion";
import { useSidebarMetrics, useSidebarTokens, useSidebarWidth } from "./sidebar/tokens";
import {
  CLEAN_UP_UPSELL_MIN,
  DOCKED_BOTTOM,
  FIRST_PAINT_ROWS,
  GLOW_ROOM,
  NEW_TAB_GAP,
  PIN_BAND,
  PINNED_DIVIDER_PAD,
  CLEAR_WIDTH,
  CLEAR_GAP,
  SPACE_TITLE_GAP,
  ROWS_PER_FRAME,
} from "./sidebar/constants";

// The list's room and its height: with new tabs at the bottom, the New Tab row docks below the list once the list
// leaves no room for it (at the top it stays the list's first row).
type Room = { available: number; list: number };
const dockedIn = ({ available, list }: Room, pitch: number) => available > 0 && list + pitch + 12 > available;

export function Sidebar() {
  const metrics = useSidebarMetrics();
  const newTabPitch = metrics.rowHeight + NEW_TAB_GAP;
  const newTabDock = DOCKED_BOTTOM + newTabPitch;
  const windowId = useWindowId();
  const width = useSidebarWidth(windowId);
  const current = useWindowSpaceId();
  const { pages, paging } = usePagerPages(windowId);
  // The list's height matters only through `docked`: the latest is kept in a ref, and the state takes it only when the
  // New Tab row docks or undocks (or the room changes), so a tab opening or closing doesn't re-render the sidebar.
  const listHeight = useRef(0);
  const [room, setRoom] = useState<Room>({ available: 0, list: 0 });
  const { available } = room;
  const newTabsAtBottom = useSettings((s) => s.newTabPosition === "bottom");
  const docked = newTabsAtBottom && dockedIn(room, newTabPitch);
  const onListHeight = (height: number) => {
    listHeight.current = height;
    setRoom((r) => (dockedIn({ ...r, list: height }, newTabPitch) === dockedIn(r, newTabPitch) ? r : { ...r, list: height }));
  };
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const geometry = useRef<SidebarGeometry>({ viewport: 0, regions: { pinned: 0, pinnedGroups: 0, list: 0 }, newTabAtTop: false });
  const playerTab = useSidebarPlayerTab(windowId);
  const playerHeight = playerTab ? SIDEBAR_PLAYER_HEIGHT : 0;
  const addressBar = useAddressBarInSidebar();
  // A tab in Developer Mode has its address over its page: the sidebar keeps its buttons, not its field.
  const field = useSidebarFieldShown();
  const header = field ? SIDEBAR_FIELD.top + metrics.addressHeight : layout.sidebarHeader;
  const glowRoom = field ? 0 : GLOW_ROOM;
  // On the window's right the header has no window buttons to clear: the profile starts at the inset.
  const profileX = useSidebarOnRight() ? layout.sidebarInset + 4 : PROFILE_INDICATOR_X;
  // The footer: downloads at its left, then the space switcher with its + for a new space (every window but a
  // private one).
  const spaces = !useIsIncognito();
  // An update waiting: its row over the footer.
  const update = useUpdateRowShown();
  const footer = PROFILE_DOTS_HEIGHT + (update ? UPDATE_ROW_HEIGHT : 0);
  const nothingPinned = useBrowser((s) => sidebarEntries(s, windowId, current).tiles.length === 0);

  useSidebarKeyboard(windowId, scroll, scrollY, glowRoom);
  useRevealTabs(windowId, scroll, scrollY, geometry, glowRoom);
  const offscreen = useOffscreenTab(windowId, scroll, scrollY, geometry, glowRoom);
  useEffect(() => {
    if (!__DEV__) return;
    devSidebars.set(windowId, { side: offscreen.side, scrollTo: (y: number) => scroll.current?.scrollTo({ y, animated: false }), reveal: offscreen.reveal });
  }, [windowId, offscreen.side, offscreen.reveal]);
  // A card anchored to a row of the page paging away would stay where the row was.
  useEffect(() => dismissHover(), [current]);

  return (
    <DragProvider>
      {(ghost: Ghost | null, controller) => (
        // A mouse's side buttons page between spaces here, as Arc's did for mice without a trackpad (over the page
        // they stay Back and Forward).
        <MouseArea onSideButton={(button) => cycleSpace(windowId, button === "back" ? -1 : 1)} style={{ width, height: "100%" }}>
          <View
            ref={(v) => {
              controller.root = v;
            }}
            style={{ width, height: "100%" }}
          >
            <View
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: header - glowRoom,
                bottom: (docked ? newTabDock : 0) + playerHeight + footer,
                overflow: paging ? "hidden" : "visible",
              }}
              onLayout={(e) => setRoom({ available: e.nativeEvent.layout.height + (docked ? newTabDock : 0), list: listHeight.current })}
            >
              {pages.map((page) => (
                <SidebarPage
                  key={page.id}
                  spaceId={page.id}
                  slot={page.slot}
                  width={width}
                  current={page.id === current}
                  resting={!!page.resting}
                  docked={docked}
                  glowRoom={glowRoom}
                  ghost={ghost}
                  rows={page.id === current ? undefined : Math.ceil(available / (metrics.rowHeight + layout.rowGap)) + 1}
                  geometryRef={page.id === current ? geometry : undefined}
                  onListHeight={onListHeight}
                  onScrollView={(v) => {
                    scroll.current = v;
                    controller.scroll = v;
                  }}
                  onScrollY={(y) => {
                    scrollY.current = y;
                    controller.scrollY = y;
                    dismissHover();
                    offscreen.check();
                  }}
                />
              ))}
              {offscreen.side ? <OffscreenTabMarker windowId={windowId} side={offscreen.side} top={glowRoom} onPress={offscreen.reveal} /> : null}
            </View>

            {playerTab ? (
              <View style={{ position: "absolute", left: layout.sidebarInset, right: layout.sidebarInset, bottom: (docked ? newTabDock : 8) + footer }}>
                <SidebarPlayer tabId={playerTab} />
              </View>
            ) : null}

            {docked ? (
              <View style={{ position: "absolute", left: layout.sidebarInset, right: layout.sidebarInset, bottom: DOCKED_BOTTOM + footer }}>
                <NewTabRow windowId={windowId} />
              </View>
            ) : null}

            <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: footer }}>
              {update ? (
                <View style={{ height: UPDATE_ROW_HEIGHT, paddingHorizontal: layout.sidebarInset, justifyContent: "flex-end" }}>
                  <UpdateRow />
                </View>
              ) : null}
              {spaces ? <SpaceSwitcher windowId={windowId} /> : null}
              <View style={{ position: "absolute", left: layout.sidebarInset, bottom: SIDEBAR_FOOTER_DOWNLOADS.bottom }}>
                <LibraryButton windowId={windowId} />
              </View>
            </View>

            <View style={{ height: header }}>
              <WindowDragRegion style={StyleSheet.absoluteFill} />
              {addressBar ? (
                <>
                  <SidebarHeaderTools width={width} />
                  {field ? <SidebarAddressRow /> : null}
                </>
              ) : (
                // Box-none: the header's empty space is the drag region's (it moves the window), not the row's.
                <View
                  pointerEvents="box-none"
                  style={{
                    height: layout.sidebarHeader,
                    flexDirection: "row",
                    alignItems: "flex-start",
                    paddingLeft: profileX,
                    paddingRight: 7,
                    paddingTop: 27 - 17,
                  }}
                >
                  <View pointerEvents="none" style={{ flex: 1 }} />
                </View>
              )}
            </View>

            <ResizeHandle windowId={windowId} />
            {/* Nothing pinned: the drag's pin target, over room the sidebar already has, so no row moves. */}
            {ghost && !ghost.landing && nothingPinned ? (
              field ? (
                <PinDropZone top={SIDEBAR_FIELD.top} height={metrics.addressHeight} cover />
              ) : (
                <PinDropZone top={layout.pinnedTop - PIN_BAND - 3} height={PIN_BAND} cover={false} />
              )
            ) : null}
            {ghost ? <DragGhost ghost={ghost} /> : null}
          </View>
        </MouseArea>
      )}
    </DragProvider>
  );
}

type PageProps = {
  spaceId: string;
  slot: number;
  width: number;
  current: boolean;
  resting: boolean;
  docked: boolean;
  glowRoom: number;
  ghost: Ghost | null;
  rows: number | undefined;
  /** The current page's: where its regions and viewport are, for revealing tabs. */
  geometryRef: RefObject<SidebarGeometry> | undefined;
  onListHeight: (height: number) => void;
  onScrollView: (view: ScrollView | null) => void;
  onScrollY: (y: number) => void;
};

function SidebarPage({ spaceId, slot, width, current, resting, docked, glowRoom, rows, geometryRef, onListHeight, onScrollView, onScrollY }: PageProps) {
  const windowId = useWindowId();
  const metrics = useSidebarMetrics();
  const folded = useBrowser((s) => spaceFolded(s, spaceId));
  const headerHidden = useBrowser(spaceHeaderHidden);
  const hasLocalFiles = useBrowser((s) => Object.values(s.localFiles).some((pin) => pin.spaceId === spaceId));
  const { tiles, pinned, pinnedGroups, list: all } = useSidebarEntries(windowId, spaceId);
  // A page's first render mounts only the rows a screen can show; the rest follow in chunks, one per frame, so a
  // long sidebar neither holds up the window's first frame nor mounts in one long task after it.
  const [mountedRows, setMountedRows] = useState(FIRST_PAINT_ROWS);
  // A page beside the current one draws only the rows that fit until it has been current; after that it keeps every
  // row, so paging mounts nothing (dropping back to a screenful unmounted every row past it on the page leaving and
  // mounted them again on the page arriving, on every switch).
  const [visited, setVisited] = useState(current);
  if (current && !visited) setVisited(true);
  const cap = visited ? undefined : rows;
  const growing = cap === undefined && mountedRows < all.length;
  useEffect(() => {
    if (!growing) return;
    // Once caught up, every row mounts with the list (a tab opened later never waits for a chunk).
    const frame = requestAnimationFrame(() => setMountedRows((n) => (n + ROWS_PER_FRAME >= all.length ? Infinity : n + ROWS_PER_FRAME)));
    return () => cancelAnimationFrame(frame);
  }, [growing, mountedRows, all.length]);
  const limit = cap ?? (growing ? mountedRows : undefined);
  const list = limit === undefined ? all : all.slice(0, limit);
  // Rows of tabs just opened grow in, and those of tabs just closed stay while they go (sidebar/RowMotion.tsx), once
  // every row is mounted.
  const motion = useRowMotion(all, current && limit === undefined);
  const listed = limit === undefined ? motion.rows : list;
  // Rows still to mount hold their room (rows are fixed-height): the list is as tall as it will be, so a tab revealed
  // early scrolls to its place, and the New Tab row docks once.
  const pending = useBrowser((s) => (growing ? entriesHeight(s, windowId, spaceId, all.slice(mountedRows)) : 0));
  const topGap = listTopGap(useSidebarFieldShown());
  const preferNewTabsAtTop = useSettings((s) => s.newTabPosition === "top");
  const singleTab = all.length === 1 && all[0]!.startsWith("t:");
  const newTabsAtTop = singleTab || preferNewTabsAtTop;
  const innerWidth = width - layout.sidebarInset * 2;
  const pageStyle = usePageStyle(windowId, slot, width);
  const inlineNewTab = !current || !docked;
  useLayoutEffect(() => {
    if (geometryRef) geometryRef.current.newTabAtTop = newTabsAtTop && inlineNewTab;
  });
  const measured = useRef(0);
  useEffect(() => {
    if (current && measured.current) onListHeight(measured.current);
  }, [current]);
  // The viewport starts glowRoom above the header's foot so the first row's glow isn't cut, but scrolled rows
  // must never show there, under the traffic lights and the profile name. The viewport's top edge follows the
  // first row down to the header's foot as the list scrolls (outer view moves the clip, inner one cancels it).
  const scrollY = useSharedValue(0);
  const tellScroll = useEffectEvent(onScrollY);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.set(e.contentOffset.y);
    runOnJS(tellScroll)(e.contentOffset.y);
  });
  const edgeAt = (y: number) => {
    "worklet";
    return interpolate(y, [0, Math.max(1, topGap)], [0, glowRoom], Extrapolation.CLAMP);
  };
  const clip = useAnimatedStyle(() => ({ transform: [{ translateY: edgeAt(scrollY.get()) }] }), [topGap, glowRoom]);
  const unclip = useAnimatedStyle(() => ({ transform: [{ translateY: -edgeAt(scrollY.get()) }] }), [topGap, glowRoom]);

  return (
    <Animated.View
      pointerEvents={current ? "auto" : "none"}
      style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width, display: resting ? "none" : "flex" }, pageStyle]}
    >
      <PageSpaceContext.Provider value={spaceId}>
        <ThemeScope>
          <DragScope enabled={current}>
            <SidebarKeyboardScope>
              <PageContent>
                {(controller) => (
                  <Animated.View style={[{ flex: 1, overflow: "hidden" }, clip]}>
                    <Animated.View style={[{ flex: 1 }, unclip]}>
                      <Animated.ScrollView
                        ref={current ? onScrollView : undefined}
                        onLayout={
                          geometryRef
                            ? (e) => {
                                geometryRef.current.viewport = e.nativeEvent.layout.height;
                                geometryRef.current.laidOut?.();
                              }
                            : undefined
                        }
                        style={{ flex: 1 }}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={current ? onScroll : undefined}
                        contentContainerStyle={{ flexGrow: 1, width, paddingHorizontal: layout.sidebarInset, paddingTop: glowRoom }}
                      >
                        <View
                          onLayout={(e) => {
                            measured.current = e.nativeEvent.layout.height + glowRoom - (inlineNewTab ? metrics.rowHeight + NEW_TAB_GAP : 0);
                            if (current) onListHeight(measured.current);
                          }}
                        >
                          <PinnedGrid tabs={tiles} innerWidth={innerWidth} />
                          <View style={{ marginTop: tiles.length ? 6 : topGap }}>
                            {headerHidden ? null : <SpaceTitle windowId={windowId} spaceId={spaceId} />}
                          </View>
                          {/* The Pinned section (Arc's, Zen's): pinned rows and folders, above a line. */}
                          <FoldAway
                            collapsed={folded}
                            onLayout={geometryRef ? (e) => void (geometryRef.current.regions.pinned = e.nativeEvent.layout.y + SPACE_TITLE_GAP) : undefined}
                          >
                            <FinderDropZone windowId={windowId} spaceId={spaceId} enabled={current && !folded}>
                              <View style={{ marginTop: SPACE_TITLE_GAP, gap: layout.rowGap }}>
                                {pinned.map((entry) => (
                                  <PinnedEntry key={entry} entry={entry} />
                                ))}
                                <LocalFiles windowId={windowId} spaceId={spaceId} />
                                <Tail id="tail:pinned" section="pinned" />
                              </View>
                            </FinderDropZone>
                          </FoldAway>
                          <PinnedDivider
                            pinned={!folded && (pinned.length > 0 || hasLocalFiles)}
                            listed={all.length > 0 || (!folded && pinnedGroups.length > 0)}
                            windowId={windowId}
                            spaceId={spaceId}
                          />
                          {/* The gap under the groups folds with them. */}
                          <FoldAway
                            collapsed={folded}
                            onLayout={geometryRef ? (e) => void (geometryRef.current.regions.pinnedGroups = e.nativeEvent.layout.y) : undefined}
                          >
                            <View
                              ref={(v) => {
                                controller?.regions.set("pinnedGroups", v);
                              }}
                              style={{ gap: layout.rowGap, marginBottom: pinnedGroups.length ? 7 : 0 }}
                            >
                              {pinnedGroups.map((id) => (
                                <GroupBlock key={id} groupId={id} section="pinnedGroups" />
                              ))}
                              <Tail id="tail:pinnedGroups" section="pinnedGroups" />
                            </View>
                          </FoldAway>
                          <LiveFolders windowId={windowId} spaced={!folded && pinnedGroups.length > 0} />
                          <View
                            ref={(v) => {
                              controller?.regions.set("list", v);
                            }}
                            onLayout={geometryRef ? (e) => void (geometryRef.current.regions.list = e.nativeEvent.layout.y) : undefined}
                            style={{ gap: layout.rowGap }}
                          >
                            {newTabsAtTop && inlineNewTab ? (
                              <View style={{ marginBottom: NEW_TAB_GAP - layout.rowGap }}>
                                <NewTabRow windowId={windowId} />
                              </View>
                            ) : null}
                            {listed.map((row) =>
                              typeof row === "string" ? (
                                <OpeningRow key={row} entry={row} opening={motion.opening.has(row)} onOpened={motion.opened}>
                                  <ListEntry entry={row} />
                                </OpeningRow>
                              ) : (
                                <ClosingTabRow key={`closing:${row.tab.id}`} row={row} onGone={motion.gone} />
                              ),
                            )}
                            {pending ? <View style={{ height: pending }} /> : null}
                            <Tail id="tail:list" section="list" />
                            {!newTabsAtTop && inlineNewTab ? (
                              <View style={{ marginTop: NEW_TAB_GAP - layout.rowGap }}>
                                <NewTabRow windowId={windowId} />
                              </View>
                            ) : null}
                          </View>
                          {current ? <CleanUpUpsell windowId={windowId} /> : null}
                        </View>
                        <ContextMenuArea style={{ flexGrow: 1, minHeight: inlineNewTab ? 24 : 0 }} onContextMenu={() => void openSidebarMenu(windowId)}>
                          <View style={{ flex: 1 }} onDoubleClick={() => useBrowser.getState().openNewTabPanel(windowId)} />
                        </ContextMenuArea>
                      </Animated.ScrollView>
                    </Animated.View>
                  </Animated.View>
                )}
              </PageContent>
            </SidebarKeyboardScope>
          </DragScope>
        </ThemeScope>
      </PageSpaceContext.Provider>
    </Animated.View>
  );
}

function PageContent({ children }: { children: (controller: ReturnType<typeof useDragController>) => ReactNode }) {
  return <>{children(useDragController())}</>;
}

// Rows are memoized by id: the sidebar re-renders on layout and profile changes, and each row
// subscribes to its own tab.
const ListEntry = memo(function ListEntry({ entry }: { entry: string }) {
  const id = entry.slice(2);
  if (entry.startsWith("g:")) return <GroupBlock groupId={id} section="list" />;
  if (entry.startsWith("s:")) return <SplitRowItem splitId={id} section="list" />;
  return <TabRowItem tabId={id} section="list" />;
});

const PinnedEntry = memo(function PinnedEntry({ entry }: { entry: string }) {
  const id = entry.slice(2);
  if (entry.startsWith("f:")) return <FolderBlock folderId={id} />;
  if (entry.startsWith("s:")) return <SplitRowItem splitId={id} section="pinned" />;
  return <TabRowItem tabId={id} section="pinned" />;
});

// The line separates pinned content from the tab list, including a lone tab. Dropping above its middle pins a tab.
// With tabs that aren't the one on screen, yab's Clear sits at its end and puts them away.
function PinnedDivider({ pinned, listed, windowId, spaceId }: { pinned: boolean; listed: boolean; windowId: string; spaceId: string }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const controller = useDragController();
  const clearable = useBrowser((s) => clearableTabs(s, windowId, spaceId).length > 0);
  const { hovered, hoverProps } = useHover();
  const shown = pinned || listed || clearable;
  // The line and its room come and go with the pinned section folding.
  const { open } = useFold(!shown);
  const room = useAnimatedStyle(
    () => ({
      paddingTop: open.get() * PINNED_DIVIDER_PAD,
      paddingBottom: open.get() * PINNED_DIVIDER_PAD + (clearable ? CLEAR_GAP : 0),
    }),
    [clearable],
  );
  const line = useAnimatedStyle(() => ({ height: open.get(), opacity: open.get() }));
  return (
    <View
      ref={(v) => {
        controller?.regions.set("divider", v);
      }}
    >
      {/* Clear stands on the line: room under it so it, and the line, aren't on the first tab. */}
      <Animated.View style={[{ paddingHorizontal: 9 }, room]}>
        <Animated.View style={[{ borderRadius: 0.5, marginRight: clearable ? CLEAR_WIDTH : 0, backgroundColor: tokens.separator }, line]} />
      </Animated.View>
      {clearable ? (
        <View {...hoverProps} style={{ position: "absolute", right: 2, top: PINNED_DIVIDER_PAD - 8, height: 17, justifyContent: "center" }}>
          <Pressable onPress={() => void clearTabs(windowId)} accessibilityRole="button" tooltip="Put away every tab but this one">
            <Text style={{ fontSize: 12, fontWeight: "500", color: hovered ? theme.textPrimary : theme.textSecondary }}>Clear</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const Tail = memo(function Tail({ id, section }: { id: string; section: "list" | "pinned" | "pinnedGroups" }) {
  const { ref, style } = useDragItem(id, { kind: "tail", tabIds: [], section });
  return <Animated.View ref={ref} style={style} />;
});

type SidebarGeometry = { viewport: number; regions: Record<Section, number>; newTabAtTop: boolean; laidOut?: () => void };

// Keeps the tab just switched to, or else the last tab opened from another in the background, in view: one scroll a
// frame, to the row's place worked out from the store (rows are fixed-height), mounted or not.
function useRevealTabs(
  windowId: string,
  scroll: RefObject<ScrollView | null>,
  scrollY: RefObject<number>,
  geometryRef: RefObject<SidebarGeometry>,
  glowRoom: number,
) {
  useEffect(() => {
    let switched: string | null = null;
    let opened: string | null = null;
    let frame = 0;
    let reveals = 0;
    const show = (y: number, height: number) => {
      const top = scrollY.current ?? 0;
      const viewport = geometryRef.current.viewport;
      if (y - top < glowRoom) scroll.current?.scrollTo({ y: Math.max(0, y - glowRoom), animated: true });
      else if (y + height - top > viewport - 8) scroll.current?.scrollTo({ y: y + height - viewport + 8, animated: true });
    };
    const reveal = () => {
      frame = 0;
      // A page that hasn't laid out yet (the sidebar just mounted) reveals once it has.
      if (!geometryRef.current.viewport || !scroll.current) return;
      reveals += 1;
      const mine = reveals;
      const tabId = switched ?? opened;
      switched = opened = null;
      const s = useBrowser.getState();
      const spaceId = s.windows[windowId]?.spaceId;
      if (!tabId || !spaceId) return;
      const { regions, newTabAtTop } = geometryRef.current;
      const span = rowSpan(s, windowId, spaceId, tabId, newTabAtTop);
      if (span) return show(glowRoom + regions[span.section] + span.top, span.height);
      // A pinned tile or a live folder's row: always mounted, so measured once.
      const view = scroll.current as unknown as View;
      void measureRow(windowId, tabId).then((row) =>
        view.measureInWindow((_x, y) => row && mine === reveals && show(row.y - y + (scrollY.current ?? 0), row.height)),
      );
    };
    // After the frame's layout: the rows it adds are in the list.
    const schedule = () => {
      if ((switched || opened) && !frame) frame = requestAnimationFrame(reveal);
    };
    const unsubscribe = useBrowser.subscribe((s, prev) => {
      if (s.windows === prev.windows && s.tabs === prev.tabs && s.tabLists === prev.tabLists) return;
      const active = activeTabId(s, windowId);
      if (active && active !== activeTabId(prev, windowId)) switched = active;
      const w = s.windows[windowId];
      const list = w ? listIds(s, windowListKey(s, w)) : undefined;
      const before = w ? listIds(prev, windowListKey(prev, w)) : undefined;
      if (list && before && list !== before) {
        const had = new Set(before);
        for (const id of list) if (!had.has(id) && s.tabs[id]?.openerId && id !== active) opened = id;
      }
      schedule();
    });
    geometryRef.current.laidOut = schedule;
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      geometryRef.current.laidOut = undefined;
    };
  }, [windowId, glowRoom]);
}

// DEV: a window's sidebar list, for tests: where the tab marker is, and a scroll (nnSidebar(windowId)).
const devSidebars = new Map<string, { side: "above" | "below" | null; scrollTo: (y: number) => void; reveal: () => void }>();
if (__DEV__) (globalThis as { nnSidebar?: unknown }).nnSidebar = (windowId: string) => devSidebars.get(windowId);

// The window's tab, when it's a list row scrolled out of view: which edge it's beyond, kept up as the list scrolls and
// changes, and a scroll that brings it back.
function useOffscreenTab(
  windowId: string,
  scroll: RefObject<ScrollView | null>,
  scrollY: RefObject<number>,
  geometryRef: RefObject<SidebarGeometry>,
  glowRoom: number,
) {
  const [side, setSide] = useState<"above" | "below" | null>(null);
  const activeRow = () => {
    const s = useBrowser.getState();
    const spaceId = s.windows[windowId]?.spaceId;
    const tabId = activeTabId(s, windowId);
    if (!spaceId || !tabId) return null;
    const { regions, newTabAtTop } = geometryRef.current;
    const span = rowSpan(s, windowId, spaceId, tabId, newTabAtTop);
    return span ? { y: glowRoom + regions[span.section] + span.top, height: span.height } : null;
  };
  const check = useEffectEvent(() => {
    const row = activeRow();
    setSide(row ? offscreenSide(row, scrollY.current ?? 0, geometryRef.current.viewport, glowRoom) : null);
  });
  const reveal = useEffectEvent(() => {
    const row = activeRow();
    if (!row) return;
    const viewport = geometryRef.current.viewport;
    const y = row.y < (scrollY.current ?? 0) + glowRoom ? row.y - glowRoom : row.y + row.height - viewport + 8;
    scroll.current?.scrollTo({ y: Math.max(0, y), animated: true });
  });
  useEffect(() => {
    let frame = 0;
    // After the frame's layout: rows opened or closed have moved the tab.
    const later = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), check()));
    };
    const unsubscribe = useBrowser.subscribe((s, prev) => {
      if (s.windows !== prev.windows || s.tabs !== prev.tabs || s.tabLists !== prev.tabLists || s.spaces !== prev.spaces) later();
    });
    later();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [windowId, glowRoom]);
  return { side, check, reveal };
}

function NewTabRow({ windowId }: { windowId: string }) {
  const metrics = useSidebarMetrics();
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} style={{ flexDirection: "row", alignItems: "center" }}>
      <Pressable
        style={{ flex: 1 }}
        onPress={(e) => {
          if ((e.nativeEvent as unknown as { altKey?: boolean }).altKey) openNewTabInSplit(windowId);
          else useBrowser.getState().openNewTabPanel(windowId);
        }}
      >
        {({ pressed }) => (
          <View
            style={{
              height: metrics.rowHeight,
              borderRadius: 10,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: 9,
              paddingRight: 34,
              backgroundColor: pressed ? tokens.newTabPressed : hovered ? tokens.newTabHover : undefined,
            }}
          >
            <Symbol name="plus" size={13} weight="medium" color={hovered ? tokens.newTabIconHover : tokens.newTabIcon} style={{ width: 16, height: 16 }} />
            <FadeLabel
              text="New Tab"
              fontSize={13}
              color={hovered ? tokens.newTabLabelHover : tokens.newTabLabel}
              style={{ flex: 1, height: 18, marginLeft: 5 }}
            />
          </View>
        )}
      </Pressable>
      <View style={{ position: "absolute", right: 6, flexDirection: "row", alignItems: "center" }}>
        <IconButton
          icon="chevron.down"
          size={10}
          weight="semibold"
          box={22}
          radius={6}
          color={hovered ? theme.textSecondary : theme.textTertiary}
          tooltip="Open and recently closed tabs"
          onPress={() => void openOverflowMenu(windowId)}
        />
      </View>
    </View>
  );
}

// Declined for the session: no window offers it again until the app restarts.
let upsellDeclined = false;
const declineUpsell = () => {
  upsellDeclined = true;
};

function CleanUpUpsell({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const [count, setCount] = useState(0);
  const [hidden, setHidden] = useState(upsellDeclined);
  const daily = useBrowser((s) => s.settings.cleanUpInactiveTabsAfterHours !== null);
  useEffect(() => {
    const check = () => setCount(cleanUpCandidates(useBrowser.getState(), windowId).length);
    check();
    return everySlowly({ every: 60_000, run: check });
  }, [windowId]);
  if (hidden || daily || count < CLEAN_UP_UPSELL_MIN) return null;
  const dismiss = () => {
    declineUpsell();
    setHidden(true);
  };
  return (
    <View
      style={{ marginTop: 10, borderRadius: 12, padding: 10, backgroundColor: tokens.groupFill, borderWidth: 0.5, borderColor: tokens.groupStroke, gap: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Symbol name="wand.and.stars" size={12} color={theme.icon} style={{ width: 16, height: 16 }} />
        <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: theme.textPrimary }}>{count} tabs haven’t been touched in a while</Text>
      </View>
      <Text style={{ fontSize: 12, color: theme.textSecondary }}>Bay can tidy up for you. You can always reopen closed tabs from the ⌄ menu.</Text>
      <View style={{ gap: 6 }}>
        <UpsellButton
          title="Clean Up Once"
          primary
          onPress={() => {
            useBrowser.getState().cleanUpTabs(windowId);
            dismiss();
          }}
        />
        <UpsellButton
          title="Clean Up Daily"
          onPress={() => {
            useBrowser.getState().updateSettings({ cleanUpInactiveTabsAfterHours: 24 });
            useBrowser.getState().cleanUpTabs(windowId);
          }}
        />
        <UpsellButton title="Not Now" onPress={dismiss} />
      </View>
    </View>
  );
}

function UpsellButton({ title, onPress, primary = false }: { title: string; onPress: () => void; primary?: boolean }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            height: 24,
            borderRadius: 7,
            paddingHorizontal: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? tokens.upsellButtonHover : primary ? theme.textPrimary : tokens.upsellButton,
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "500", color: primary ? (theme.dark ? "#000000" : "#FFFFFF") : theme.textPrimary }}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}
