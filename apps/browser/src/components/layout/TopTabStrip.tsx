import { ContextMenuArea, FadeLabel, raiseView, setTrafficLightsCenter, Surface, Symbol, WindowDragRegion } from "@bay/shell";
import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import { findNodeHandle, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { closeTab, toggleMute } from "../../lib/actions";
import { hex, ThemeScope, useTheme } from "../../lib/theme";
import { layout } from "../../lib/constants";
import { useEffectEvent } from "../../lib/useEffectEvent";
import { useBrowser, type BrowserState } from "../../store/browser";
import { PageSpaceContext, useIsActiveTab, usePageSpaceId, useSettings, useTab, useTabLive, useWindowId, useWindowSpaceId } from "../../store/hooks";
import { SpaceIndicator, useSpaceIndicatorWidth } from "../SpaceIndicator";
import { HoverSlot } from "../HoverSlot";
import { IconButton, useHover } from "../primitives";
import { clickTab } from "../sidebar/actions";
import { openGroupMenu, openTabMenu } from "../sidebar/menus";
import { TabIcon } from "../sidebar/TabIcon";
import { TabBadges } from "../media/TabBadges";
import { GROUP_COLORS, useSidebarTokens, withAlpha } from "../sidebar/tokens";
import { modifiersOf } from "./controls";
import { usePageStyle, usePagerPages } from "./spacePager";
import { SpaceSwipeArea } from "./SpaceSwipe";
import { openNewTabInSplit } from "./splitActions";
import { setMeasuredWidth, useMeasuredWidths } from "./measuredWidths";
import { usePeek } from "./usePeek";
import Animated, { cancelAnimation, Easing, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import {
  dragGeometry,
  dragRange,
  dropIndex,
  GROUP_SPRING,
  groupLayout,
  memberInteractive,
  moveIndex,
  stripEntries,
  stripTabWidth,
  tuckTarget,
  type DragGeometry,
  type DragSlot,
} from "./stripGroups";
import {
  STRIP_CONTROLS_GAP,
  STRIP_DOCK_GAP,
  STRIP_DOWNLOADS_BOX,
  STRIP_FLARE,
  STRIP_GAP,
  STRIP_GROUP_MARGIN_LEFT,
  STRIP_GROUP_MARGIN_RIGHT,
  STRIP_ITEM_HEIGHT,
  STRIP_ITEM_TOP,
  STRIP_LIFT_MS,
  STRIP_LIFT_SLOP,
  STRIP_LIGHTS_CENTER,
  STRIP_LIGHTS_GAP,
  STRIP_MAX_CHIP,
  STRIP_MEMBERS_INSET,
  STRIP_MID,
  STRIP_MIN_CHIP,
  STRIP_PEEK_BORDER,
  STRIP_PEEK_HEIGHT,
  STRIP_PEEK_PAD,
  STRIP_PINNED_CELL,
  STRIP_PINNED_SPACING,
  STRIP_PROFILE_ROOM,
  STRIP_RIM_HEIGHT,
  STRIP_SLIDE,
  STRIP_TAB_RADIUS,
  STRIP_TAB_TOP,
  STRIP_TAIL_EXPANDED,
  STRIP_TUCK_FADE_MS,
  TOP_STRIP_HEIGHT,
} from "./constants";
import { makeRoom, registerSlot, reorderOffsets, settleRoom } from "./stripReorder";
import { beginTabDrag, cancelTabDrag, endTabDrag, setDragPicture, setInsert, setInsertResolver, updateTabDrag, useTabDrag } from "./tabDrag";
import { toolbarPalette, useEasedColor, useEasedColorStyle, type EasedColor, type ToolbarPalette } from "./toolbarColors";
import { listOfTab } from "../../store/model";

// The drop-down strip (full screen, auto-hidden tabs) has no card to attach the selected tab to.
const FloatingStrip = createContext(false);

type Member = { kind: "tab"; id: string; group: string | null } | { kind: "split"; id: string; tabIds: string[]; group: string | null };
type GroupEntry = { kind: "group"; id: string; collapsed: boolean; members: Member[] };
type Entry = { kind: "dock"; ids: string[] } | GroupEntry | Member;

// `width`: the window's (the peek's, floating), from its parent, so a strip mounting again lays its tabs out right on its
// first frame. `hidden`: page full screen keeps the strip mounted out of view, and gives the traffic lights back.
// `swipe`: the strip pages profiles; a hidden peek's doesn't, or switching profiles would wait on its pager.
export function TopTabStrip({ width, floating = false, hidden = false, swipe = true }: { width: number; floating?: boolean; hidden?: boolean; swipe?: boolean }) {
  const windowId = useWindowId();
  const current = useWindowSpaceId();
  const { pages } = usePagerPages(windowId);
  const spaceChip = useSpaceIndicatorWidth(STRIP_PROFILE_ROOM);
  const controls = (spaceChip ? spaceChip + STRIP_CONTROLS_GAP : 0) + STRIP_DOWNLOADS_BOX;
  const left = floating ? 8 : layout.trafficLightsWidth + STRIP_LIGHTS_GAP;
  const right = Math.max(84, controls + 8 + 6);
  const pageWidth = Math.max(0, width - left - right);
  const flare = floating ? 0 : STRIP_FLARE;

  useEffect(() => {
    if (floating || hidden) return;
    void setTrafficLightsCenter(windowId, STRIP_LIGHTS_CENTER);
    return () => void setTrafficLightsCenter(windowId, null);
  }, [floating, hidden, windowId]);

  return (
    <FloatingStrip.Provider value={floating}>
      <View style={{ height: TOP_STRIP_HEIGHT }}>
        <WindowDragRegion style={StyleSheet.absoluteFill} />
        {/* The clip starts a flare's width early so the first tab's flare isn't cut, and ends at the profile chip and
            download button, so tabs scrolled past the end never show under them. */}
        <View style={{ position: "absolute", left: left - flare, right: Math.max(right - flare, controls + 8), top: 0, bottom: 0, overflow: "hidden" }}>
          {pages.map((page) => (
            <StripPage key={page.id} spaceId={page.id} slot={page.slot} pageWidth={pageWidth} current={page.id === current} resting={!!page.resting} />
          ))}
        </View>
        <View mouseDownCanMoveWindow={false} style={{ position: "absolute", right: 8, top: STRIP_MID - 17, flexDirection: "row", alignItems: "center", gap: STRIP_CONTROLS_GAP }}>
          <SpaceIndicator room={STRIP_PROFILE_ROOM} />
          <IconButton
            icon="arrow.down.circle"
            size={16}
            box={STRIP_DOWNLOADS_BOX}
            radius={10}
            tooltip="Downloads (⇧⌘J)"
            onPress={() => {
              const s = useBrowser.getState();
              s.setDownloadsOpen(windowId, !s.windowUi[windowId]?.downloadsOpen);
            }}
          />
        </View>
        {swipe && <SpaceSwipeArea surface="strip" style={StyleSheet.absoluteFill} pageWidth={pageWidth + flare * 2} />}
        {!floating && <StripDropHighlight left={left} right={right} />}
      </View>
    </FloatingStrip.Provider>
  );
}

// A tab dragged from another window over this one lands at the end of its strip: the strip lights up meanwhile.
function StripDropHighlight({ left, right }: { left: number; right: number }) {
  const windowId = useWindowId();
  const theme = useTheme();
  const over = useTabDrag((d) => d.overWindow === windowId);
  const glow = useSharedValue(0);
  useEffect(() => {
    glow.set(withTiming(over ? 1 : 0, { duration: 140, easing: Easing.out(Easing.quad) }));
  }, [over]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.get() }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{
        position: "absolute",
        left: left - 4,
        right: right - 4,
        top: STRIP_ITEM_TOP - 1,
        height: STRIP_ITEM_HEIGHT + 2,
        borderRadius: STRIP_TAB_RADIUS + 1,
        borderWidth: 1.5,
        borderColor: theme.accent,
        backgroundColor: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
      }, glowStyle]}
    />
  );
}

// A tab dragged from another window over this one's tabs: the strip makes room for it where the pointer is, as
// Dia's does, and the tab lands there (tabDrag.ts › insert). `origin`: the first gap, where the tabs start.
function useIncomingTab(windowId: string, current: boolean, top: DragGeometry) {
  const active = useTabDrag((d) => current && d.tabIds.length > 0 && d.windowId !== windowId);
  const point = useTabDrag((d) => (current && d.overWindow === windowId ? d.overPoint : null));
  const origin = useRef<View>(null);
  const [start, setStart] = useState<number | null>(null);
  // Where the tabs start, measured again as the pointer moves (the strip may scroll).
  useEffect(() => {
    if (!point) return setStart(null);
    origin.current?.measureInWindow((x) => setStart((old) => (old === x ? old : x)));
  }, [point?.[0], point?.[1]]);
  const groups = useBrowser((s) => s.groups);
  const index = incomingIndex(top, point, start, groups);
  const beforeId = index === null ? undefined : (top.slots[index]?.tabIds[0] ?? null);
  useEffect(() => setInsert(windowId, beforeId), [beforeId, windowId]);
  // The drop asks again at the pointer where it ended.
  const resolve = useEffectEvent((p: [number, number]) => {
    const i = incomingIndex(top, p, start, useBrowser.getState().groups);
    return i === null ? undefined : (top.slots[i]?.tabIds[0] ?? null);
  });
  useEffect(() => {
    if (!current) return;
    setInsertResolver(windowId, resolve);
    return () => {
      setInsertResolver(windowId, null);
      setInsert(windowId, undefined);
    };
  }, [windowId, current, resolve]);
  return { active, at: index, origin };
}

// Over the strip (with a little slack below it), at the slot whose centre the pointer passed; never among a
// pinned group's tabs or before them (a dropped tab isn't pinned).
function incomingIndex(top: DragGeometry, point: [number, number] | null, start: number | null, groups: BrowserState["groups"]): number | null {
  if (!point || start === null || point[1] > TOP_STRIP_HEIGHT + 24) return null;
  const x = point[0] - start;
  let index = top.slots.filter((slot, i) => top.lefts[i]! + slot.width / 2 < x).length;
  const pinnedGroup = (id: string | undefined) => !!id && Object.values(groups).some((g) => g.pinned && g.tabIds.includes(id));
  while (index < top.slots.length && pinnedGroup(top.slots[index]!.tabIds[0])) index++;
  return index;
}

// The room an incoming tab gets: none (and no row gap) until the pointer is there, then a tab's width.
function IncomingGap({ open, width, origin }: { open: boolean; width: number; origin?: React.RefObject<View | null> }) {
  const room = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    // Width and margin: layout. Dia: ~0.05 s.
    room.set(withTiming(open ? 1 : 0, { duration: 120, easing: Easing.out(Easing.cubic) }));
  }, [open]);
  const roomStyle = useAnimatedStyle(() => ({ width: room.get() * width, marginRight: interpolate(room.get(), [0, 1], [-STRIP_GAP, 0]) }), [width]);
  return <Animated.View ref={origin} pointerEvents="none" style={[{ height: TOP_STRIP_HEIGHT }, roomStyle]} />;
}

function StripPage({ spaceId, slot, pageWidth, current, resting }: { spaceId: string; slot: number; pageWidth: number; current: boolean; resting: boolean }) {
  const windowId = useWindowId();
  const flare = useContext(FloatingStrip) ? 0 : STRIP_FLARE;
  // Pages sit their whole width apart, flares included: only a page's width apart, the next profile's selected tab
  // and its flare showed at the clip's end, under the profile chip.
  const pageStyle = usePageStyle(windowId, slot, pageWidth + flare * 2);
  const entries = useBrowser((s) => stripEntries(s, windowId, spaceId));
  const activeId = useBrowser((s) => s.windows[windowId]?.activeTabIds[spaceId] ?? "");
  const parsed = parseEntries(entries);
  // Each group's chip as measured (its name's width), so the tabs' width leaves it room. Kept for the session: a strip
  // mounting again (the peek, a layout or sidebar switch) lays out right at once. A new group shows once it's measured.
  const groupIds = parsed.flatMap((e) => (e.kind === "group" ? [e.id] : []));
  const chipWidths = useMeasuredWidths(groupIds.map(chipKey));
  const chipOf = (groupId: string) => chipWidths[groupIds.indexOf(groupId)];
  // What's out in the strip: collapsed groups show only their active member.
  const visible = parsed.flatMap((e): Member[] => (e.kind === "group" ? (e.collapsed ? e.members.filter((m) => holds(m, activeId)) : e.members) : e.kind === "dock" ? [] : [e]));
  const pinnedCount = parsed.reduce((n, e) => n + (e.kind === "dock" ? e.ids.length : 0), 0);
  const chip = stripTabWidth({
    pageWidth,
    dockWidth: pinnedCount ? pinnedCount * (STRIP_PINNED_CELL + STRIP_PINNED_SPACING) - STRIP_PINNED_SPACING + STRIP_DOCK_GAP : 0,
    groups: parsed.flatMap((e) => (e.kind === "group" ? [{ chip: chipOf(e.id) ?? 0, expanded: !e.collapsed, shown: e.members.some((m) => holds(m, activeId)) }] : [])),
    tabUnits: visible.reduce((n, m) => n + units(m), 0),
    gap: STRIP_GAP,
    plus: STRIP_ITEM_HEIGHT,
    min: STRIP_MIN_CHIP,
    max: STRIP_MAX_CHIP,
  });
  // A tab dragged along the strip trades places with whole tabs, splits and groups.
  const top = dragGeometry(
    parsed.flatMap((e): DragSlot[] => {
      if (e.kind === "dock") return [];
      if (e.kind !== "group") return [{ tabIds: tabsOf(e), width: chip * units(e) }];
      const widths = e.members.map((m) => chip * units(m));
      const shown = e.members.findIndex((m) => holds(m, activeId));
      const width = groupLayout(chipOf(e.id) ?? 0, widths, STRIP_GAP, !e.collapsed, shown).width;
      return [{ tabIds: e.members.flatMap(tabsOf), width, marginLeft: STRIP_GROUP_MARGIN_LEFT, marginRight: STRIP_GROUP_MARGIN_RIGHT }];
    }),
    STRIP_GAP,
  );
  const slotOf = (id: string) => top.slots.findIndex((slot) => slot.tabIds[0] === id);
  const dockIds = parsed.flatMap((e) => (e.kind === "dock" ? e.ids : []));
  const strip = { top, dock: dockIds.length ? { ids: dockIds, left: -(dockWidth(dockIds.length) + STRIP_DOCK_GAP) } : null };
  const incoming = useIncomingTab(windowId, current, top);
  // Each entry's slot: its place among the entries that take one (the dock takes none).
  const slotIndexes: number[] = [];
  let slots = 0;
  for (const e of parsed) {
    slotIndexes.push(slots);
    if (e.kind !== "dock") slots += 1;
  }
  const gap = (i: number) => (incoming.active ? <IncomingGap key={`gap${i}`} open={incoming.at === i} width={chip} origin={i === 0 ? incoming.origin : undefined} /> : null);

  return (
    <Animated.View
      pointerEvents={current ? "auto" : "none"}
      style={[{ position: "absolute", left: 0, top: 0, bottom: 0, width: pageWidth + flare * 2, display: resting ? "none" : "flex" }, pageStyle]}
    >
      <PageSpaceContext.Provider value={spaceId}>
        <ThemeScope>
          <DockContext.Provider value={strip}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flex: 1 }}
              contentContainerStyle={{ alignItems: "flex-start", gap: STRIP_GAP, paddingLeft: flare, paddingRight: flare }}
            >
              {/* One flat keyed list: a reordered item moves rather than mounting afresh (nested arrays are keyed by
                  position, so a tab dropped into another place was a new view, and its settle and its neighbours'
                  slide had nothing to run on). */}
              {parsed.flatMap((e, i) => {
                if (e.kind === "dock") return <PinnedDock key="dock" tabIds={e.ids} />;
                const before = gap(slotIndexes[i]!);
                if (e.kind === "group")
                  return [
                    before,
                    <StripGroup
                      key={e.id}
                      entry={e}
                      geometry={top}
                      from={slotOf(e.members[0] ? tabsOf(e.members[0])[0]! : "")}
                      chip={chip}
                      activeId={activeId}
                      chipWidth={chipOf(e.id)}
                      onChipWidth={(width) => setMeasuredWidth(chipKey(e.id), width)}
                    />,
                  ];
                if (e.kind === "split")
                  return [before, <SplitChip key={e.id} tabIds={e.tabIds} width={chip * Math.min(e.tabIds.length, 2)} geometry={top} from={slotOf(e.tabIds[0]!)} group={null} />];
                return [before, <DraggableChip key={e.id} tabId={e.id} width={chip} geometry={top} from={slotOf(e.id)} group={null} />];
              })}
              {gap(top.slots.length)}
              <NewTabButton windowId={windowId} />
            </ScrollView>
          </DockContext.Provider>
        </ThemeScope>
      </PageSpaceContext.Provider>
    </Animated.View>
  );
}

function parseEntries(keys: string[]): Entry[] {
  const out: Entry[] = [];
  const groups = new Map<string, GroupEntry>();
  for (const key of keys) {
    const [kind, id, a, b] = key.split(":");
    if (kind === "pinned") {
      const last = out[out.length - 1];
      if (last?.kind === "dock") last.ids.push(id!);
      else out.push({ kind: "dock", ids: [id!] });
      continue;
    }
    if (kind === "group") {
      const group: GroupEntry = { kind, id: id!, collapsed: a === "1", members: [] };
      groups.set(group.id, group);
      out.push(group);
      continue;
    }
    const member: Member = kind === "split" ? { kind, id: id!, tabIds: a!.split(","), group: b || null } : { kind: "tab", id: id!, group: a || null };
    const group = member.group ? groups.get(member.group) : undefined;
    if (group) group.members.push(member);
    else out.push(member);
  }
  return out;
}

const chipKey = (groupId: string) => `strip-group-chip|${groupId}`;
const holds = (m: Member, tabId: string) => (m.kind === "split" ? m.tabIds.includes(tabId) : m.id === tabId);
const tabsOf = (m: Member) => (m.kind === "split" ? m.tabIds : [m.id]);
// A split shows at most two panes' width.
const units = (m: Member) => (m.kind === "split" ? Math.min(m.tabIds.length, 2) : 1);

// What a strip item drags: `tabId` is the tab the page can split with (none for a whole split); `ids` move along
// the strip and out of the window (a tab with the rest of a multi-selection, or a split's panes).
// `axis`: "y" for a split's pane, which leaves the strip on its own, while its split moves along the strip as one.
// `range`: how far it may travel when it can leave its own row (a tab into the pinned dock, a pinned tab out of it);
// `drop`: handles the release first (true: done). `local`: a group, which only moves along the strip.
type StripDrag = {
  tabId: string | null;
  ids: () => string[];
  pinned: boolean;
  groupId: string | null;
  geometry: DragGeometry;
  from: number;
  width: number;
  gap: number;
  axis?: "x" | "y";
  range?: [number, number];
  drop?: (dx: number, ids: string[]) => boolean;
  local?: boolean;
};

// Where the pinned dock sits, from the left of the strip's first tab (or group): pinned tabs and tabs cross it.
type Dock = { ids: string[]; left: number };
const dockWidth = (cells: number) => cells * (STRIP_PINNED_CELL + STRIP_PINNED_SPACING) - STRIP_PINNED_SPACING;
const DockContext = createContext<{ dock: Dock | null; top: DragGeometry } | null>(null);

// An item follows the pointer along the strip, trading places with whole tabs, splits and groups. Pulled down
// past the strip a tab leaves it for the page (whose split targets show, SplitChrome.tsx); let go outside the
// window, it moves to the window under the pointer or a new one (tabDrag.ts). Items are
// `mouseDownCanMoveWindow={false}`: no view consumes the press, so it climbed the responder chain to the strip's
// WindowDragRegion, which moved the window under the pointer instead of the tab (it leaves such presses alone).
function useStripDrag(item: StripDrag) {
  const dx = useSharedValue(0);
  // How far it slides aside while another item of its row is dragged over its place (stripReorder.ts).
  const shift = useSharedValue(0);
  const lift = useSharedValue(0);
  const [dragging, setDragging] = useState(false);
  const current = useEffectEvent(() => item);
  // One machine for the item's life: a new responder mid-gesture would drop the gesture.
  const [machine] = useState(() => stripDrag(current, { dx, lift }, setDragging));
  useEffect(() => registerSlot(() => current().geometry, () => current().from, shift), [current, shift]);
  useEffect(() => machine.unmount, [machine]);
  const room = item.width + item.gap;
  // Lifted off the strip it fades, and its row closes the gap it leaves.
  const fadeStyle = useAnimatedStyle(() => ({ opacity: 1 - lift.get() }));
  const moveStyle = useAnimatedStyle(() => ({ opacity: 1 - lift.get(), marginRight: -room * lift.get(), transform: [{ translateX: dx.get() + shift.get() }] }), [room]);
  // Flat, for callers to destructure: the compiler treats `x.ref` (and the rest of `x`) as a ref read.
  return { ref: machine.ref, panHandlers: machine.panHandlers, style: [moveStyle, { zIndex: dragging ? 10 : 0 }], fadeStyle, dragging };
}

function stripDrag(current: () => StripDrag, { dx, lift }: { dx: SharedValue<number>; lift: SharedValue<number> }, setDragging: (dragging: boolean) => void) {
  let view: View | null = null;
  let drag = { stripBottom: TOP_STRIP_HEIGHT, lifted: false, ids: [] as string[], dx: 0, to: -1 };
  const setLifted = (lifted: boolean) => {
    if (drag.lifted === lifted) return;
    drag.lifted = lifted;
    // Its margin: the strip closes the gap the tab leaves.
    lift.set(withTiming(lifted ? 1 : 0, { duration: STRIP_LIFT_MS, easing: Easing.out(Easing.cubic) }));
  };
  // The place its row makes for it (`to`), as its leading edge passes a neighbour's centre; none once it's lifted
  // off the strip, whose gap closes instead.
  const makeRoomAt = (to: number) => {
    const { geometry, from } = current();
    if (from < 0 || to === drag.to) return;
    drag.to = to;
    makeRoom(geometry, from, to < 0 ? from : to);
  };
  let owns = false;
  // Drawn over the row while dragged and settling (a group's member over the group's other members).
  let raised: number | null = null;
  const raise = (on: boolean) => {
    const tag = on ? findNodeHandle(view) : raised;
    raiseView(tag, current().groupId ? 1 : 0, on);
    raised = on ? tag : null;
  };
  const reset = () => {
    owns = false;
    makeRoomAt(-1);
    dx.set(0);
    setLifted(false);
    setDragging(false);
    raise(false);
  };
  // Let go: it settles into its new place (`to`; none: back home) with the row already laid out around it, and
  // only then does the store move it: until that one update, nothing reorders the views, so it stays drawn on top.
  let settle: { land: () => void } | null = null;
  const settleInto = (to: number | null, commit: () => boolean) => {
    const { geometry, from } = current();
    if (to === null) makeRoomAt(-1);
    const landing = {
      land: () => {
        if (settle !== landing) return;
        settle = null;
        // The row stands where it is about to be laid out, then one store update (React renders it at once here,
        // outside an event, so the row's items are this geometry's only until then), the item at rest: one batch.
        if (to !== null) {
          settleRoom(geometry);
          commit();
        }
        dx.set(0);
        setDragging(false);
        raise(false);
      },
    };
    settle = landing;
    const land = () => landing.land();
    dx.set(
      withSpring(to === null ? 0 : (reorderOffsets(geometry, from, to)[from] ?? 0), STRIP_SLIDE, () => {
        runOnJS(land)();
      }),
    );
  };
  // Closed mid-drag (⌘W): RN drops the responder without telling it, so the drag would stay open and block the next;
  // the row it was passing stands where it is laid out.
  const unmount = () => {
    settle?.land();
    if (!owns) return;
    settleRoom(current().geometry);
    if (!current().local) cancelTabDrag();
  };
  const { panHandlers } = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => {
      // RN grants a parent that asks for a drag before the child holding it can refuse: a split doesn't ask
      // while its pane is dragging.
      if (useTabDrag.getState().tabIds.length) return false;
      const axis = current().axis;
      if (axis === "y") return Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx);
      if (axis === "x") return Math.abs(g.dx) > 4;
      return Math.abs(g.dx) > 4 || Math.abs(g.dy) > 6;
    },
    onPanResponderGrant: (e) => {
      const ids = current().ids();
      const grab: [number, number] = [e.nativeEvent.pageX, e.nativeEvent.pageY];
      // Pressed again while settling from the last drop: it lands first.
      settle?.land();
      cancelAnimation(dx);
      dx.set(0);
      const mine = { stripBottom: TOP_STRIP_HEIGHT, lifted: false, ids, dx: 0, to: -1 };
      drag = mine;
      owns = true;
      setDragging(true);
      if (current().from >= 0) raise(true);
      if (current().local) return;
      const seq = beginTabDrag(ids.length === 1 ? current().tabId : null, ids);
      view?.measureInWindow((x, y, width, height) => {
        // This drag's measure: a later drag has its own.
        if (drag !== mine) return;
        mine.stripBottom = y + TOP_STRIP_HEIGHT;
        // Its picture, taken if it leaves the strip: where it is along the strip by then.
        setDragPicture(seq, () => [x + mine.dx, y, width, height], [grab[0] + mine.dx, grab[1]]);
      });
    },
    onPanResponderMove: (_, g) => {
      const { geometry, from, tabId, range, local } = current();
      // Only a tab leaves the strip for the page; a split or a selection stays on it until it leaves the window.
      const lifted = !local && !!tabId && drag.ids.length === 1 && g.moveY > drag.stripBottom + STRIP_LIFT_SLOP;
      setLifted(lifted);
      const [min, max] = range ?? (from < 0 ? [0, 0] : dragRange(geometry, from));
      if (!lifted) {
        drag.dx = Math.max(min, Math.min(max, g.dx));
        dx.set(drag.dx);
      }
      makeRoomAt(lifted || from < 0 ? -1 : dropIndex(geometry, from, g.dx));
      if (!local) updateTabDrag(g.moveX, g.moveY, lifted);
    },
    onPanResponderRelease: (_, g) => {
      const lifted = drag.lifted;
      const { local, drop, from, range, geometry } = current();
      owns = false;
      // Over the page or out of the window: tabDrag.ts (a split, another window or a new one).
      if ((!local && (endTabDrag() || lifted)) || from < 0) return reset();
      const travelled = range ? Math.max(range[0], Math.min(range[1], g.dx)) : g.dx;
      const ids = drag.ids;
      // Into or out of the pinned dock (its own drop), or a selection whose other tabs move too: its place isn't
      // along this row, so the store moves it now and it's simply there.
      if (!local) {
        const store = useBrowser.getState();
        const moved = drop?.(travelled, ids) || (ids.length > 1 && reorder(ids, current(), g.dx));
        if (moved && useBrowser.getState() !== store) settleRoom(geometry);
        if (moved) return reset();
      }
      // PanResponder resets its gesture state after this handler: the drop's travel, kept for the landing.
      const at = g.dx;
      const to = dropIndex(geometry, from, at);
      settleInto(to === from ? null : to, () => {
        const store = useBrowser.getState();
        if (local) drop?.(travelled, ids);
        else reorder(ids, current(), at);
        return useBrowser.getState() !== store;
      });
    },
    onPanResponderTerminate: () => {
      const local = current().local;
      reset();
      if (!local) cancelTabDrag();
    },
  });
  const ref = (v: View | null) => {
    view = v;
  };
  return { ref, panHandlers, unmount };
}

// True when the store moved it.
function reorder(ids: string[], { geometry, from, pinned, groupId }: StripDrag, dx: number): boolean {
  const s = useBrowser.getState();
  const tab = s.tabs[ids[0] ?? ""];
  const w = tab && listOfTab(s, tab.id);
  if (!tab || !w) return false;
  const to = dropIndex(geometry, from, dx);
  if (ids.length === 1) {
    // One tab: its place among the section's tabs (which keeps it in or out of its group as it was).
    const section = w.tabIds.filter((id) => s.tabs[id]?.spaceId === tab.spaceId && !!s.tabs[id]?.pinned === pinned);
    const index = moveIndex(section, tab.id, geometry.slots, from, to);
    if (index === null) return false;
    s.moveTab(tab.id, index);
    return true;
  }
  if (to === from) return false;
  // Before the first tab of the slot it lands on that isn't moving along (a multi-selection's other tabs), else
  // before whatever follows the strip's last slot.
  const others = geometry.slots.filter((_, i) => i !== from);
  let beforeId = others.slice(to).flatMap((slot) => slot.tabIds).find((id) => !ids.includes(id)) ?? null;
  if (!beforeId) {
    const last = w.tabIds.indexOf(others.at(-1)?.tabIds.at(-1) ?? "");
    beforeId = last < 0 ? null : (w.tabIds.slice(last + 1).find((id) => !ids.includes(id)) ?? null);
  }
  s.placeTabs(ids, { pinned, beforeId, groupId });
  return true;
}

// The tab and, when it's part of the window's multi-selection, the rest of the selection, in strip order.
function withSelection(tabId: string): string[] {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  const selection = tab ? (s.selection[tab.windowId] ?? []) : [];
  if (selection.length < 2 || !selection.includes(tabId)) return [tabId];
  return (listOfTab(s, tabId)?.tabIds ?? []).filter((id) => selection.includes(id) && !!s.tabs[id]?.pinned === tab!.pinned);
}

function DraggableChip({ tabId, width, geometry, from, group, tuck }: { tabId: string; width: number; geometry: DragGeometry; from: number; group: string | null; tuck?: () => void }) {
  const active = useIsActiveTab(tabId);
  const strip = useContext(DockContext);
  // A tab outside groups may go on into the pinned dock, and is pinned there.
  const dock = !group && from >= 0 ? (strip?.dock ?? null) : null;
  const range: [number, number] | undefined = dock ? [dock.left - geometry.lefts[from]!, dragRange(geometry, from)[1]] : undefined;
  const { ref: dragRef, panHandlers: dragHandlers, style: dragStyle, dragging } = useStripDrag({
    tabId,
    ids: () => withSelection(tabId),
    pinned: false,
    groupId: group,
    geometry,
    from,
    width,
    gap: STRIP_GAP,
    range,
    drop: (dx, ids) => {
      if (!dock) return false;
      // Its leading edge decides, as along the strip (a tab is wider than the dock): past the last pinned tab's middle.
      const left = geometry.lefts[from]! + dx;
      if (left > dock.left + (dock.ids.length - 1) * (STRIP_PINNED_CELL + STRIP_PINNED_SPACING) + STRIP_PINNED_CELL / 2) return false;
      const index = dock.ids.filter((_, i) => dock.left + i * (STRIP_PINNED_CELL + STRIP_PINNED_SPACING) + STRIP_PINNED_CELL / 2 < left + STRIP_PINNED_CELL / 2).length;
      useBrowser.getState().placeTabs(ids, { pinned: true, beforeId: dock.ids[index] ?? null });
      return true;
    },
  });
  return (
    <Animated.View ref={dragRef} {...dragHandlers} mouseDownCanMoveWindow={false} style={[dragStyle, { zIndex: dragging ? 10 : active ? 1 : 0 }]}>
      <TabChip tabId={tabId} width={width} tuck={tuck} dragged={dragging} />
    </Animated.View>
  );
}

// The toolbar's website colour, eased the same way, so the selected tab and the toolbar read as one surface.
function useWebsiteBand(tabId: string) {
  const theme = useTheme();
  const extend = useSettings((s) => s.extendWebsiteColor);
  const url = useTab(tabId)?.url;
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const palette = toolbarPalette(theme, extend && url ? themeColor : null);
  return { palette, band: useEasedColor(palette.background) };
}

// `tuck`: the active tab of a collapsed group shows Dia's "–" instead of ✕, tucking it back into the group.
function TabChip({ tabId, width, tuck, dragged }: { tabId: string; width: number; tuck?: () => void; dragged: boolean }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const floating = useContext(FloatingStrip);
  const playing = useTabLive(tabId, (l) => l.playingAudio);
  const { palette, band } = useWebsiteBand(tabId);
  const { hovered, hoverProps } = useHover();
  if (!tab) return null;
  const title = tab.customTitle || tab.title || tab.url || "New Tab";
  const onBand = active && !floating && !!palette.background;
  return (
    <View {...hoverProps} tooltip={tab.url ? `${title}\n${tab.url}` : title} style={{ width, height: TOP_STRIP_HEIGHT }}>
      {active && <SelectedTab width={width} band={band} opaque={dragged} />}
      <ContextMenuArea onContextMenu={() => void openTabMenu(windowId, tab)} style={StyleSheet.absoluteFill}>
        <Pressable onPress={(e) => clickTab(windowId, tab.id, modifiersOf(e))} style={{ flex: 1 }}>
          {({ pressed }) => (
            <ItemRow hovered={hovered && !active} pressed={pressed && !active}>
              {/* Not hit: an image view under a press in an inactive window moves the window (AppKit's first mouse). */}
              <View pointerEvents="none">
                <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
                <TabBadges tabId={tab.id} pip={false} />
              </View>
              {(playing || tab.muted) && (
                <Pressable onPress={() => toggleMute(tab.id)} style={{ marginLeft: 5 }} tooltip={tab.muted ? "Unmute" : "Mute"}>
                  <Symbol name={tab.muted ? "speaker.slash" : "speaker.wave.2"} size={11} color={onBand ? palette.icon : theme.textTab} style={{ width: 16, height: 16 }} />
                </Pressable>
              )}
              <FadeLabel
                text={title}
                fontSize={12}
                color={onBand ? palette.text : active ? theme.tabSelectedText : theme.textTab}
                // The label draws 2 pt in, so the text starts 7 after the favicon.
                style={{ flex: 1, height: 16, marginLeft: 5 }}
              />
              <HoverSlot
                hovered={hovered}
                width={20}
                hover={
                  <IconButton
                    icon={tuck ? "minus" : "xmark"}
                    size={9}
                    weight="semibold"
                    box={20}
                    radius={5}
                    color={onBand ? palette.icon : undefined}
                    onPress={tuck ?? (() => void closeTab(tab.id))}
                    tooltip={tuck ? "Hide in Group" : "Close Tab"}
                  />
                }
              />
            </ItemRow>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

// A tab's content row, 5…37, with Dia's hover and pressed fills for a tab that isn't selected.
function ItemRow({ hovered, pressed, children }: { hovered: boolean; pressed: boolean; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: STRIP_ITEM_TOP,
        height: STRIP_ITEM_HEIGHT,
        borderRadius: STRIP_TAB_RADIUS,
        backgroundColor: pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 9.5,
        paddingRight: 6,
      }}
    >
      {children}
    </View>
  );
}

type Fill = string | EasedColor;

// The selected tab: the card's own fill (and the toolbar's website colour over it) rising out of the card. `opaque`:
// dragged or settling, as Dia's: the card (half clear in dark) goes over the window's own opaque tint, so it looks as it
// does at rest and the tab it passes doesn't show through.
function SelectedTab({ width, band, opaque = false }: { width: number; band: Fill | null; opaque?: boolean }) {
  const theme = useTheme();
  const floating = useContext(FloatingStrip);
  if (floating) {
    const card = {
      position: "absolute" as const,
      left: 0,
      top: STRIP_ITEM_TOP,
      width,
      height: STRIP_ITEM_HEIGHT,
      borderRadius: STRIP_TAB_RADIUS,
    };
    return (
      <>
        {opaque && <View pointerEvents="none" style={{ ...card, backgroundColor: theme.windowTint[0] }} />}
        <View
          pointerEvents="none"
          style={{
            ...card,
            borderWidth: 0.5,
            borderColor: theme.dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)",
            backgroundColor: theme.card,
          }}
        />
      </>
    );
  }
  const body = width - 1;
  const fills: Fill[] = [...(opaque ? [theme.windowTint[0]] : []), theme.card, ...(band ? [band] : [])];
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width, height: TOP_STRIP_HEIGHT }}>
      {fills.map((fill, i) => (
        <Fragment key={i}>
          <TabBody width={body} fill={fill} />
          <Flare x={0.5 - STRIP_FLARE} side="left" color={fill} />
          <Flare x={0.5 + body} side="right" color={fill} />
        </Fragment>
      ))}
      <Surface
        cornerRadius={STRIP_TAB_RADIUS + 0.5}
        borderWidth={0.5}
        borderColors={[theme.dark ? "#FFFFFF3B" : "#FFFFFFFA", "#FFFFFF00"]}
        style={{ position: "absolute", left: 0, top: STRIP_TAB_TOP - 0.5, width, height: STRIP_RIM_HEIGHT }}
      />
    </View>
  );
}

// The tab's body over the strip, in one of its fills.
function TabBody({ width, fill }: { width: number; fill: Fill }) {
  const color = useEasedColorStyle(fill, "backgroundColor");
  return (
    <Animated.View
      style={[
        { position: "absolute", left: 0.5, top: STRIP_TAB_TOP, width, height: TOP_STRIP_HEIGHT - STRIP_TAB_TOP, borderTopLeftRadius: STRIP_TAB_RADIUS, borderTopRightRadius: STRIP_TAB_RADIUS },
        color,
      ]}
    />
  );
}

// The tab's concave foot: an r×r square filled outside a circle of radius r centred on its outer top corner.
function Flare({ x, side, color: fill }: { x: number; side: "left" | "right"; color: Fill }) {
  const outer = STRIP_FLARE * 2;
  const color = useEasedColorStyle(fill, "borderColor");
  return (
    <View style={{ position: "absolute", left: x, top: TOP_STRIP_HEIGHT - STRIP_FLARE, width: STRIP_FLARE, height: STRIP_FLARE, overflow: "hidden" }}>
      <Animated.View
        style={[
          { position: "absolute", left: side === "left" ? -outer : STRIP_FLARE - outer, top: -outer, width: outer * 2, height: outer * 2, borderRadius: outer, borderWidth: STRIP_FLARE },
          color,
        ]}
      />
    </View>
  );
}

// Dia keeps pinned tabs in one shared container (the TabDockItemResting fill and stroke), not a tile each.
function PinnedDock({ tabIds }: { tabIds: string[] }) {
  const theme = useTheme();
  // Pinned tabs trade places among themselves, or go out among the tabs (unpinned).
  const geometry = dragGeometry(tabIds.map((id) => ({ tabIds: [id], width: STRIP_PINNED_CELL })), STRIP_PINNED_SPACING);
  return (
    <View
      style={{
        marginTop: STRIP_ITEM_TOP,
        marginRight: STRIP_DOCK_GAP - STRIP_GAP,
        // Over the tabs while one of its tabs is dragged out among them.
        zIndex: 2,
        width: tabIds.length * (STRIP_PINNED_CELL + STRIP_PINNED_SPACING) - STRIP_PINNED_SPACING,
        height: STRIP_ITEM_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        borderRadius: STRIP_TAB_RADIUS,
        borderWidth: 0.5,
        borderColor: theme.pinnedRestingStroke,
        backgroundColor: theme.pinnedResting,
      }}
    >
      {/* The stroke sits inside the container, over the cells' outer edges. */}
      <View style={{ flexDirection: "row", gap: STRIP_PINNED_SPACING, marginHorizontal: -0.5 }}>
        {tabIds.map((id, i) => (
          <PinnedCell key={id} tabId={id} geometry={geometry} from={i} />
        ))}
      </View>
    </View>
  );
}

function PinnedCell({ tabId, geometry, from }: { tabId: string; geometry: DragGeometry; from: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const { hovered, hoverProps } = useHover();
  const strip = useContext(DockContext);
  const dock = strip?.dock;
  const top = strip?.top;
  // From the dock's start, past the strip's last item.
  // With no tabs yet, room for one after the dock.
  const end = top && top.slots.length ? top.lefts.at(-1)! + top.slots.at(-1)!.width : STRIP_MAX_CHIP;
  const range: [number, number] | undefined = dock ? [-geometry.lefts[from]!, end - dock.left - geometry.lefts[from]! - STRIP_PINNED_CELL] : undefined;
  const { ref: dragRef, panHandlers: dragHandlers, style: dragStyle } = useStripDrag({
    tabId,
    ids: () => withSelection(tabId),
    pinned: true,
    groupId: null,
    geometry,
    from,
    width: STRIP_PINNED_CELL,
    gap: STRIP_PINNED_SPACING,
    range,
    drop: (dx, ids) => {
      if (!dock || !top) return false;
      const left = dock.left + geometry.lefts[from]! + dx;
      if (left + STRIP_PINNED_CELL / 2 < -STRIP_DOCK_GAP / 2) return false;
      const k = top.slots.filter((slot, i) => top.lefts[i]! + slot.width / 2 < left + STRIP_PINNED_CELL).length;
      useBrowser.getState().placeTabs(ids, { pinned: false, beforeId: top.slots[k]?.tabIds[0] ?? null });
      return true;
    },
  });
  if (!tab) return null;
  return (
    <Animated.View ref={dragRef} {...dragHandlers} mouseDownCanMoveWindow={false} style={dragStyle}>
      <View {...hoverProps} tooltip={`${tab.customTitle || tab.title || tab.url}${tab.url ? `\n${tab.url}` : ""}`}>
        <ContextMenuArea onContextMenu={() => void openTabMenu(windowId, tab)}>
          <Pressable onPress={(e) => clickTab(windowId, tab.id, modifiersOf(e))}>
            {({ pressed }) => (
              <View style={{ width: STRIP_PINNED_CELL, height: STRIP_ITEM_HEIGHT - 1, alignItems: "center", justifyContent: "center" }}>
                {(active || hovered || pressed) && (
                  <View
                    style={{
                      position: "absolute",
                      left: 2,
                      right: 2,
                      top: 2,
                      bottom: 2,
                      borderRadius: 8,
                      backgroundColor: pressed ? theme.tabPressed : active ? theme.pinnedSelectedFill : theme.tabHover,
                    }}
                  />
                )}
                <View pointerEvents="none">
                  <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
                  <TabBadges tabId={tab.id} pip={false} />
                </View>
              </View>
            )}
          </Pressable>
        </ContextMenuArea>
      </View>
    </Animated.View>
  );
}

// A tab group (stripGroups.ts): one container with the chip and the members. Collapsed, the members wait under
// the first slot, faded out, except the window's active tab; expanding slides them out to their places and
// collapsing slides them back, on Dia's spring.
function StripGroup({
  entry,
  geometry,
  from,
  chip,
  activeId,
  chipWidth,
  onChipWidth,
}: {
  entry: GroupEntry;
  geometry: DragGeometry;
  from: number;
  chip: number;
  activeId: string;
  chipWidth: number | undefined;
  onChipWidth: (width: number) => void;
}) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const windowId = useWindowId();
  const spaceId = usePageSpaceId();
  const group = useBrowser((s) => s.groups[entry.id]);
  const { hovered, hoverProps } = useHover();
  const expanded = !entry.collapsed;
  const widths = entry.members.map((m) => chip * units(m));
  const shown = entry.members.findIndex((m) => holds(m, activeId));
  const chipSize = chipWidth ?? 0;
  const { offsets, width } = groupLayout(chipSize, widths, STRIP_GAP, expanded, shown);
  // Inside an open group, a member trades places with the other members only.
  const members = dragGeometry(entry.members.map((m, i) => ({ tabIds: tabsOf(m), width: widths[i]! })), STRIP_GAP);
  const tuckable = useBrowser((s) => !expanded && shown >= 0 && !!tuckTarget(s, windowId, spaceId, entry.id));
  const open = useSharedValue(expanded ? 1 : 0);
  const size = useSharedValue(width);
  const state = `${expanded}:${shown >= 0 ? entry.members[shown]!.id : ""}`;
  const settled = useRef(state);
  // While the group springs, members that are still sliding (and fading) in take no clicks.
  const [moving, setMoving] = useState(false);
  const springs = useRef(0);
  useEffect(() => {
    // Layout: `open` moves each member's `left` and `size` is the group's width, which reflows the strip.
    const run = (values: [SharedValue<number>, number][]) => {
      springs.current += 1;
      const id = springs.current;
      let running = values.length;
      const done = () => {
        running -= 1;
        if (running === 0 && id === springs.current) setMoving(false);
      };
      setMoving(true);
      for (const [value, to] of values)
        value.set(
          withSpring(to, GROUP_SPRING, () => {
            runOnJS(done)();
          }),
        );
    };
    if (settled.current !== state) {
      // Expanding, collapsing and a member coming out or going back spring.
      settled.current = state;
      run([
        [open, expanded ? 1 : 0],
        [size, width],
      ]);
    } else if (moving) {
      // The width changed mid-spring (the chip measured, a member came or went): the spring takes the new target.
      run([[size, width]]);
    } else size.set(width);
  }, [state, width]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.max(0, open.get())) }));
  const sizeStyle = useAnimatedStyle(() => ({ width: size.get() }));
  const tailStyle = useAnimatedStyle(() => ({ left: size.get() - (STRIP_TAIL_EXPANDED - 2.25), opacity: Math.min(1, Math.max(0, open.get())) }));
  // Dragged by its chip, the group moves along the strip as one.
  const { ref: dragRef, panHandlers: dragHandlers, style: dragStyle } = useStripDrag({
    tabId: null,
    ids: () => useBrowser.getState().groups[entry.id]?.tabIds ?? [],
    pinned: false,
    groupId: null,
    geometry,
    from,
    width: 0,
    gap: 0,
    axis: "x",
    local: true,
    drop: (dx) => {
      const to = dropIndex(geometry, from, dx);
      if (to === from) return true;
      const others = geometry.slots.filter((_, i) => i !== from);
      const s = useBrowser.getState();
      s.moveGroup(entry.id, { pinned: !!s.groups[entry.id]?.pinned, beforeId: others[to]?.tabIds[0] ?? null });
      return true;
    },
  });
  if (!group) return null;
  const tint = group.color ? GROUP_COLORS[group.color].hex : null;
  const divider = theme.dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)";
  const tuck = () => {
    const s = useBrowser.getState();
    const target = tuckTarget(s, windowId, spaceId, entry.id);
    if (target) s.activate(target, windowId);
  };
  return (
    <Animated.View
      ref={dragRef}
      style={[dragStyle, sizeStyle, { height: TOP_STRIP_HEIGHT, marginLeft: STRIP_GROUP_MARGIN_LEFT, marginRight: STRIP_GROUP_MARGIN_RIGHT, opacity: chipWidth === undefined ? 0 : 1 }]}
    >
      <Animated.View
        pointerEvents="none"
        style={[sizeStyle, {
          position: "absolute",
          left: 0,
          top: STRIP_ITEM_TOP,
          height: STRIP_ITEM_HEIGHT,
          borderRadius: STRIP_TAB_RADIUS,
          borderWidth: 0.5,
          borderColor: theme.pinnedRestingStroke,
          // Dia lightens the whole container while the pointer is on the chip.
          backgroundColor: tint ? withAlpha(tint, hovered ? 0.24 : 0.18) : hovered ? tokens.groupHeaderHover : tokens.groupFill,
        }]}
      />
      <Animated.View pointerEvents="none" style={[{ position: "absolute", left: chipSize + 0.75, top: STRIP_MID - 7.5, width: 0.5, height: 15, backgroundColor: divider }, fadeStyle]} />
      {entry.members.map((m, i) => (
        <GroupMember
          key={m.id}
          member={m}
          width={widths[i]!}
          start={chipSize + STRIP_MEMBERS_INSET}
          offset={offsets[i]!}
          open={open}
          interactive={memberInteractive(i === shown, expanded, moving)}
          shown={i === shown}
          geometry={members}
          // A collapsed group's shown tab has no neighbours to trade places with.
          from={expanded ? i : -1}
          tuck={tuckable && i === shown ? tuck : undefined}
        />
      ))}
      <Animated.View pointerEvents={expanded ? "box-none" : "none"} mouseDownCanMoveWindow={false} style={[{ position: "absolute", top: STRIP_ITEM_TOP, height: STRIP_ITEM_HEIGHT, flexDirection: "row", alignItems: "center" }, tailStyle]}>
        <View style={{ width: 0.5, height: 15, backgroundColor: divider }} />
        <IconButton icon="xmark" size={9} weight="semibold" box={24} radius={6} style={{ marginLeft: 1 }} onPress={() => useBrowser.getState().closeGroup(entry.id)} tooltip="Close Group" />
      </Animated.View>
      <View
        {...hoverProps}
        {...dragHandlers}
        mouseDownCanMoveWindow={false}
        tooltip={expanded ? "Collapse Group" : "Expand Group"}
        onLayout={(e) => onChipWidth(Math.ceil(e.nativeEvent.layout.width * 2) / 2)}
        style={{ position: "absolute", left: 0, top: STRIP_ITEM_TOP, height: STRIP_ITEM_HEIGHT }}
      >
        <ContextMenuArea onContextMenu={() => void openGroupMenu(windowId, entry.id)}>
          <Pressable
            onPress={() => useBrowser.getState().updateGroup(entry.id, { collapsed: expanded })}
            style={{ height: STRIP_ITEM_HEIGHT, flexDirection: "row", alignItems: "center", paddingLeft: 8.5, paddingRight: 7 }}
          >
            {group.icon ? <Text style={{ width: 13, fontSize: 12, textAlign: "center" }}>{group.icon}</Text> : <GroupGlyph color={tint ?? (theme.dark ? "#FFFFFF4D" : "#0000004D")} />}
            <Text numberOfLines={1} style={{ marginLeft: 12.5, maxWidth: 120, fontSize: 12, fontWeight: "600", color: tint ?? (shown >= 0 ? theme.tabSelectedText : theme.textTab) }}>
              {group.name || `${group.tabIds.length} Tabs`}
            </Text>
          </Pressable>
        </ContextMenuArea>
      </View>
    </Animated.View>
  );
}

function GroupMember({
  member,
  width,
  start,
  offset,
  open,
  interactive,
  shown,
  geometry,
  from,
  tuck,
}: {
  member: Member;
  width: number;
  start: number;
  offset: number;
  open: SharedValue<number>;
  interactive: boolean;
  shown: boolean;
  geometry: DragGeometry;
  from: number;
  tuck?: () => void;
}) {
  // The shown member (the window's active tab while collapsed) fades in and out on its own: Dia's "–" fades the
  // tab back into the group while the tabs after it close the gap.
  const shownValue = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    shownValue.set(withTiming(shown ? 1 : 0, { duration: STRIP_TUCK_FADE_MS, easing: Easing.out(Easing.quad) }));
  }, [shown]);
  const placeStyle = useAnimatedStyle(() => {
    const o = open.get();
    // Out with the group's opening (fully in by halfway), or as the shown member.
    const opacity = Math.min(1, Math.max(0, shownValue.get() + Math.min(1, Math.max(0, o * 2))));
    return { left: interpolate(o, [0, 1], [start, start + offset]), opacity };
  }, [start, offset]);
  return (
    <Animated.View pointerEvents={interactive ? "box-none" : "none"} style={[{ position: "absolute", top: 0, width, height: TOP_STRIP_HEIGHT, zIndex: shown ? 2 : 1 }, placeStyle]}>
      {member.kind === "split" ? (
        <SplitChip tabIds={member.tabIds} width={width} geometry={geometry} from={from} group={member.group} />
      ) : (
        <DraggableChip tabId={member.id} width={width} geometry={geometry} from={from} group={member.group} tuck={tuck} />
      )}
    </Animated.View>
  );
}

// Dia's group glyph: a tab seen edge-on with two more behind it.
function GroupGlyph({ color }: { color: string }) {
  return (
    <View style={{ width: 13, height: 11, flexDirection: "row", alignItems: "center" }}>
      <View style={{ width: 1.25, height: 7, borderRadius: 0.625, backgroundColor: color, opacity: 0.5 }} />
      <View style={{ width: 1.25, height: 9, borderRadius: 0.625, marginLeft: 0.6, backgroundColor: color, opacity: 0.75 }} />
      <View style={{ width: 9.4, height: 10.6, borderRadius: 2.5, marginLeft: 0.5, backgroundColor: color }} />
    </View>
  );
}

// A split moves along the strip as one; each pane pulled down leaves it on its own (onto the page, or out of the
// window into one of its own), as Dia's split tab does.
function SplitChip({ tabIds, width, geometry, from, group }: { tabIds: string[]; width: number; geometry: DragGeometry; from: number; group: string | null }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const spaceId = usePageSpaceId();
  const focusedId = useBrowser((s) => s.windows[windowId]?.activeTabIds[spaceId] ?? "");
  const active = tabIds.includes(focusedId);
  // Each pane has its own card and toolbar; the tab takes the focused pane's colour.
  const { band, palette } = useWebsiteBand(active ? focusedId : tabIds[0]!);
  const floating = useContext(FloatingStrip);
  const ink = active && !floating && palette.background ? palette : null;
  const { hovered, hoverProps } = useHover();
  const { ref: dragRef, panHandlers: dragHandlers, style: dragStyle, dragging } = useStripDrag({ tabId: null, ids: () => tabIds, pinned: false, groupId: group, geometry, from, width, gap: STRIP_GAP, axis: "x" });
  return (
    <Animated.View ref={dragRef} {...dragHandlers} mouseDownCanMoveWindow={false} style={[dragStyle, { zIndex: dragging ? 10 : active ? 1 : 0 }]}>
      <View {...hoverProps} style={{ width, height: TOP_STRIP_HEIGHT }}>
        {active && <SelectedTab width={width} band={band} opaque={dragging} />}
        <ItemRow hovered={hovered && !active} pressed={false}>
          <Symbol name="rectangle.split.2x1" size={11} color={ink?.secondary ?? theme.textSecondary} style={{ width: 14, height: 16, marginRight: 4 }} />
          {tabIds.map((id, i) => (
            <SplitPart key={id} tabId={id} first={i === 0} ink={ink} />
          ))}
        </ItemRow>
      </View>
    </Animated.View>
  );
}

const NO_SLOTS = dragGeometry([], STRIP_GAP);

function SplitPart({ tabId, first, ink }: { tabId: string; first: boolean; ink: ToolbarPalette | null }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const focused = useIsActiveTab(tabId);
  const { ref: dragRef, panHandlers: dragHandlers, fadeStyle: dragFade } = useStripDrag({ tabId, ids: () => [tabId], pinned: false, groupId: null, geometry: NO_SLOTS, from: -1, width: 0, gap: 0, axis: "y" });
  if (!tab) return null;
  return (
    <Animated.View ref={dragRef} {...dragHandlers} style={[{ flex: 1, flexDirection: "row", alignItems: "center" }, dragFade]}>
      <ContextMenuArea onContextMenu={() => void openTabMenu(windowId, tab)} style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
        {!first && <View style={{ width: StyleSheet.hairlineWidth, height: 16, marginHorizontal: 6, backgroundColor: ink?.divider ?? theme.textTertiary }} />}
        <Pressable onPress={() => useBrowser.getState().activate(tab.id, windowId)} style={{ flex: 1, flexDirection: "row", alignItems: "center" }} tooltip={tab.title || tab.url}>
          <View pointerEvents="none">
            <TabIcon url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={14} spaceId={tab.spaceId} />
          </View>
          <FadeLabel text={tab.customTitle || tab.title || tab.url || "New Tab"} fontSize={12} color={ink ? (focused ? ink.text : ink.secondary) : focused ? theme.tabSelectedText : theme.textTab} style={{ flex: 1, height: 16, marginLeft: 5 }} />
        </Pressable>
      </ContextMenuArea>
    </Animated.View>
  );
}

function NewTabButton({ windowId }: { windowId: string }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps} mouseDownCanMoveWindow={false} tooltip="New Tab (⌘T) — ⌥-click to open in Split View" style={{ marginTop: STRIP_ITEM_TOP, marginLeft: 0.5 }}>
      <Pressable
        onPress={(e) => {
          if (modifiersOf(e).altKey) openNewTabInSplit(windowId);
          else useBrowser.getState().openNewTabPanel(windowId);
        }}
      >
        {({ pressed }) => (
          <View style={{ width: STRIP_ITEM_HEIGHT, height: STRIP_ITEM_HEIGHT, borderRadius: STRIP_TAB_RADIUS, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined }}>
            <Symbol name="plus" size={13} color={theme.textSecondary} style={{ width: 16, height: 16 }} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

export function TopStripPeek({ windowWidth, enabled }: { windowWidth: number; enabled: boolean }) {
  const theme = useTheme();
  const { slide, live, show, hide } = usePeek(enabled);
  const slideStyle = useAnimatedStyle(() => {
    "worklet";
    const p = slide.get();
    return { opacity: p, transform: [{ translateY: interpolate(p, [0, 1], [-STRIP_PEEK_HEIGHT - 8, 0]) }] };
  });
  return (
    <>
      {enabled ? <View onMouseEnter={show} style={{ position: "absolute", left: layout.trafficLightsWidth, right: 0, top: 0, height: 6 }} /> : null}
      <Animated.View
        pointerEvents={live ? "auto" : "none"}
        onMouseEnter={live ? show : undefined}
        onMouseLeave={live ? hide : undefined}
        style={[
          {
            position: "absolute",
            left: 6,
            width: windowWidth - 12,
            // Out of the window while hidden (a transform doesn't move hover tracking): its tabs mustn't hover under the page.
            top: live ? 4 : -10_000,
            height: STRIP_PEEK_HEIGHT,
          },
          slideStyle,
        ]}
      >
        <Surface
          fill={hex(theme.windowTint[0])}
          cornerRadius={12}
          borderColor={hex(theme.panelBorder)}
          borderWidth={STRIP_PEEK_BORDER}
          shadowColor="#000000"
          shadowOpacity={theme.panelShadowOpacity}
          shadowRadius={20}
          shadowOffset={[0, 6]}
          style={{ flex: 1 }}
        >
          <View style={{ position: "absolute", left: 0, right: 0, top: STRIP_PEEK_PAD - STRIP_ITEM_TOP, height: TOP_STRIP_HEIGHT }}>
            {/* The border insets the strip. */}
            <TopTabStrip floating swipe={live} width={windowWidth - 12 - STRIP_PEEK_BORDER * 2} />
          </View>
        </Surface>
      </Animated.View>
    </>
  );
}
