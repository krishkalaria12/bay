import { hapticTick } from "@bay/shell";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { PanResponder, type ScrollView, type View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { create, useStore } from "zustand";
import { useTheme } from "../../lib/theme";
import { sidebarMetrics } from "../../lib/sidebarDensity";
import { layout } from "../../lib/constants";
import { useBrowser } from "../../store/browser";
import { useWindowId } from "../../store/hooks";
import { useEffectEvent } from "../../lib/useEffectEvent";
import type { TabPlacement } from "../../store/organize";
import { STRIP_SLIDE } from "../layout/constants";
import { beginTabDrag, cancelTabDrag, endTabDrag, setDragPicture, updateTabDrag, useTabDrag } from "../layout/tabDrag";
import { suppressHover } from "./hover";
import { DRAG_SCROLL_EDGE, PINNED_TILE_GAP } from "./constants";

type Frame = { x: number; y: number; w: number; h: number };
type Section = "tiles" | "pinned" | "pinnedGroups" | "list";

export type ItemSpec = {
  kind: "tile" | "row" | "group" | "folder" | "split" | "tail";
  tabIds: string[];
  section: Section;
  groupId?: string;
  folderId?: string;
  // The group or pinned folder a row is in.
  parentGroup?: string;
  collapsed?: boolean;
};

type Item = ItemSpec & {
  key: string;
  view: View | null;
  header: View | null;
  gap: SharedValue<number>;
  size: SharedValue<number>;
  frame: Frame | null;
  headerFrame: Frame | null;
};

type Drop =
  | { type: "tabs"; placement: TabPlacement }
  | { type: "group"; placement: { pinned: boolean; beforeId?: string | null } }
  | { type: "folder"; folderId: string; beforeId: string | null }
  | { type: "none" };

// `landing`: let go, it settles into the item's place while the item stays hidden.
export type Ghost = {
  item: Item;
  count: number;
  width: number;
  height: number;
  position: { x: SharedValue<number>; y: SharedValue<number> };
  landing?: boolean;
};

// The list stacks rows with `gap`; a zero-height tail cancels its gap with this negative margin.
const ROW_GAP = layout.rowGap;
// Rows make room and close up with Dia's slide (stripReorder.ts): gaps and sizes are margins, widths and heights.
const spring = (value: SharedValue<number>, toValue: number) => value.set(withSpring(toValue, STRIP_SLIDE));

const inside = (f: Frame, x: number, y: number, slop = 0) => x >= f.x - slop && x <= f.x + f.w + slop && y >= f.y - slop && y <= f.y + f.h + slop;
const measure = (view: View | null): Promise<Frame | null> =>
  view ? new Promise((resolve) => view.measureInWindow((x, y, w, h) => resolve(w || h ? { x, y, w, h } : null))) : Promise.resolve(null);

type Marks = { sources: Set<string>; dropInto: string | null; landing: string | null; pins: boolean };
const NO_MARKS: Marks = { sources: new Set(), dropInto: null, landing: null, pins: false };
const noMarks = create<Marks>()(() => NO_MARKS);

class DragController {
  items = new Map<string, Item>();
  regions = new Map<string, View | null>();
  root: View | null = null;
  scroll: ScrollView | null = null;
  scrollY = 0;
  // What the items show while a drag goes on, each item reading only its own part: a drag's start or end
  // re-renders the items it hides or shows, not the whole list.
  marks = create<Marks>()(() => NO_MARKS);
  setSources = (sources: Set<string>) => this.marks.setState({ sources });
  setDropInto = (dropInto: string | null) => this.marks.setState({ dropInto });
  setLanding = (landing: string | null) => this.marks.setState({ landing });

  private sources: Item[] = [];
  private startScrollY = 0;
  private rootFrame: Frame = { x: 0, y: 0, w: 0, h: 0 };
  private regionFrames = new Map<string, Frame | null>();
  private viewport: Frame | null = null;
  private grab = { x: 0, y: 0 };
  private pointer = { x: 0, y: 0 };
  private ghost: Ghost | null = null;
  private gapKey: string | null = null;
  // The collapsed group the drop goes into.
  private into: string | null = null;
  private dropKey = "";
  private drop: Drop = { type: "none" };
  private scrollTimer: ReturnType<typeof setInterval> | undefined;
  private measured = false;
  private token: object | null = null;
  landed: { key: string; x: number; y: number } | null = null;

  constructor(private setGhost: (ghost: Ghost | null) => void) {}

  create(key: string): Item {
    return {
      key,
      kind: "row",
      tabIds: [],
      section: "list",
      view: null,
      header: null,
      gap: makeMutable(0),
      size: makeMutable(0),
      frame: null,
      headerFrame: null,
    };
  }

  /** The views an item's frames are measured from. */
  attach(item: Item, part: "view" | "header", view: View | null) {
    item[part] = view;
  }

  get active() {
    return this.sources.length > 0;
  }

  async begin(key: string, x: number, y: number, selection: string[]) {
    const item = this.items.get(key);
    if (!item || item.kind === "tail") return;
    const selected = item.kind === "row" || item.kind === "tile" ? selection : [];
    const multi = selected.length > 1 && item.tabIds.some((id) => selected.includes(id));
    this.sources = multi
      ? [...this.items.values()].filter((i) => (i.kind === "row" || i.kind === "tile") && i.tabIds.some((id) => selected.includes(id)))
      : [item];
    const token = (this.token = {});
    suppressHover(true);
    let seq = 0;
    if (item.kind === "row" || item.kind === "tile") {
      const single = this.sources.length === 1 ? (item.tabIds[0] ?? null) : null;
      seq = beginTabDrag(single, [...new Set(this.sources.flatMap((i) => i.tabIds))]);
    }
    this.pointer = { x, y };
    this.measured = false;
    this.startScrollY = this.scrollY;
    await this.measureAll();
    if (this.token !== token || !this.sources.length) return;
    const frame = item.frame ?? { x, y, w: 176, h: 33 };
    this.grab = { x: x - frame.x, y: y - frame.y };
    const count = new Set(this.sources.flatMap((s) => s.tabIds)).size;
    const height = item.kind === "group" || item.kind === "folder" ? Math.min(frame.h, item.headerFrame?.h ?? 33) : frame.h;
    // Its picture, taken if it leaves the sidebar: the ghost, where it is by then.
    if (seq) setDragPicture(seq, () => [this.pointer.x - this.grab.x, this.pointer.y - this.grab.y, frame.w, height], [x, y]);
    this.ghost = {
      item,
      count,
      width: frame.w,
      height,
      position: { x: makeMutable(frame.x - this.rootFrame.x), y: makeMutable(frame.y - this.rootFrame.y) },
    };
    for (const s of this.sources) s.size.set(s.kind === "tile" ? (s.frame?.w ?? 0) : (s.frame?.h ?? 0));
    this.setLanding(null);
    this.setSources(new Set(this.sources.map((s) => s.key)));
    this.setGhost(this.ghost);
    for (const s of this.sources) spring(s.size, 0);
    this.measured = true;
    this.move(this.pointer.x, this.pointer.y);
  }

  /** The pin target overlay (PinDropZone) came in with the ghost, after the drag measured everything: its place. */
  async tilesLaidOut() {
    const token = this.token;
    const frame = await measure(this.regions.get("tiles") ?? null);
    if (this.token !== token || !this.sources.length) return;
    this.regionFrames.set("tiles", frame);
    this.retarget();
  }

  private async measureAll() {
    const [rootFrame, viewport] = await Promise.all([measure(this.root), measure(this.scroll as unknown as View)]);
    this.rootFrame = rootFrame ?? this.rootFrame;
    this.viewport = viewport;
    this.startScrollY = this.scrollY;
    await Promise.all(
      [...this.items.values()].map(async (i) => {
        [i.frame, i.headerFrame] = await Promise.all([measure(i.view), measure(i.header)]);
      }),
    );
    for (const [name, view] of this.regions) this.regionFrames.set(name, await measure(view));
  }

  move(x: number, y: number) {
    this.pointer = { x, y };
    updateTabDrag(x, y);
    if (!this.measured || !this.ghost) return;
    this.ghost.position.x.set(x - this.grab.x - this.rootFrame.x);
    this.ghost.position.y.set(y - this.grab.y - this.rootFrame.y);
    this.autoScroll(y);
    this.retarget();
  }

  end(commit: boolean) {
    clearInterval(this.scrollTimer);
    this.scrollTimer = undefined;
    const sources = this.sources;
    const drop = this.drop;
    const ghost = this.ghost;
    // Page split drop takes precedence over sidebar drop.
    const splitDrop = commit ? endTabDrag() : (cancelTabDrag(), false);
    // Where it lands, measured before the store moves anything (a measure in the same batch as a commit sees the
    // layout before it): the room the list made for it, or its own place. A selection, a tile, or a drop into a
    // collapsed group or the pinned grid just shows in its place.
    const spot =
      !splitDrop && this.measured && ghost && sources.length === 1 && sources[0]!.kind !== "tile" && !this.into
        ? this.landingSpot(commit ? drop : { type: "none" })
        : null;
    if (commit && !splitDrop && this.measured && sources.length) {
      const s = useBrowser.getState();
      const ids = sources.flatMap((i) => i.tabIds);
      if (drop.type === "tabs") s.placeTabs(ids, drop.placement);
      else if (drop.type === "group" && sources[0]!.groupId) s.moveGroup(sources[0]!.groupId, drop.placement);
      else if (drop.type === "folder") s.movePinnedFolder(drop.folderId, drop.beforeId);
    }
    // The gaps close as the store moves the items into them, in the same commit: nothing moves on screen.
    for (const i of this.items.values()) {
      cancelAnimation(i.gap);
      i.gap.set(0);
    }
    for (const i of sources) cancelAnimation(i.size);
    this.sources = [];
    this.gapKey = null;
    this.dropKey = "";
    this.drop = { type: "none" };
    this.into = null;
    this.ghost = null;
    this.measured = false;
    suppressHover(false);
    this.setSources(new Set());
    this.setDropInto(null);
    this.marks.setState({ pins: false });
    if (!spot || !ghost) {
      this.token = null;
      this.setLanding(null);
      this.setGhost(null);
      return;
    }
    // The ghost settles into its place while the item, laid out there, stays hidden; then the item shows.
    const token = (this.token = {});
    this.setLanding(ghost.item.key);
    this.setGhost({ ...ghost, landing: true });
    const done = () => {
      if (this.token !== token) return;
      this.token = null;
      this.setLanding(null);
      this.setGhost(null);
    };
    void spot.then((at) => {
      if (this.token !== token) return;
      // DEV: where it landed, for the drag test to compare with the item's place.
      if (__DEV__) this.landed = at && { key: ghost.item.key, x: at.x, y: at.y };
      if (!at) return done();
      ghost.position.x.set(withSpring(at.x - this.rootFrame.x, STRIP_SLIDE));
      ghost.position.y.set(
        withSpring(at.y - this.rootFrame.y, STRIP_SLIDE, () => {
          runOnJS(done)();
        }),
      );
    });
  }

  // The landing item's top-left in the window once the store has moved it: the gap opened before `gapKey` (which
  // it fills), or, dropped nowhere, its own place. Measured now, less what closes above it as it lands: the gaps and
  // the collapsing source (their springs may be midway).
  private landingSpot(drop: Drop): Promise<{ x: number; y: number } | null> | null {
    const source = this.sources[0]!;
    // Pinned, its place is in the grid.
    if (drop.type === "tabs" && drop.placement.pinned) return null;
    const target = drop.type !== "none" && this.gapKey ? this.items.get(this.gapKey) : undefined;
    const ref = target ?? source;
    const top = ref.frame?.y;
    if (top === undefined) return null;
    const now = (v: SharedValue<number>) => {
      cancelAnimation(v);
      return v.get();
    };
    let closing = 0;
    for (const i of this.items.values()) if (i.frame && (i === ref || i.frame.y < top)) closing += now(i.gap);
    // A group's member sits in its fold's own wrapper, which can't shrink below nothing: the gap after it stays until
    // the member goes (Fold.tsx). A top-level row's negative margin cancels its gap.
    // Its group's last member, the group goes with it: all of the group's room closes.
    const group = source.parentGroup ? this.items.get(`g:${source.parentGroup}`) : undefined;
    const emptied = !!group && group.tabIds.every((id) => source.tabIds.includes(id)) && !!group.frame && group.frame.y < top && group !== ref;
    if (!emptied && source !== ref && source.frame && source.frame.y < top)
      closing += source.parentGroup ? Math.max(0, now(source.size) - ROW_GAP) + ROW_GAP : now(source.size);
    // A tail is a zero-height mark after its section's or group's last item: its x is the container's.
    const container =
      ref.kind === "tail"
        ? [...this.items.values()].find((i) => i !== source && i.kind !== "tail" && i.frame && i.section === ref.section && i.parentGroup === ref.parentGroup)
        : ref;
    // Dropped nowhere, the list goes back to how it was when the drag began: its place then.
    const home = target ? null : this.at(source.frame);
    if (home) return Promise.resolve({ x: home.x, y: home.y });
    return Promise.all([measure(ref.view), emptied ? measure(group!.view) : null]).then(([f, gone]) => {
      if (!f) return null;
      return { x: container?.frame?.x ?? f.x, y: f.y - closing - (gone ? gone.h + ROW_GAP : 0) + (ref.kind === "tail" ? ROW_GAP : 0) };
    });
  }

  private autoScroll(y: number) {
    const v = this.viewport;
    const speed = !v
      ? 0
      : y < v.y + DRAG_SCROLL_EDGE
        ? -Math.ceil((v.y + DRAG_SCROLL_EDGE - y) / 4)
        : y > v.y + v.h - DRAG_SCROLL_EDGE
          ? Math.ceil((y - (v.y + v.h - DRAG_SCROLL_EDGE)) / 4)
          : 0;
    clearInterval(this.scrollTimer);
    this.scrollTimer = undefined;
    if (!speed || !this.scroll) return;
    this.scrollTimer = setInterval(() => {
      const next = Math.max(0, this.scrollY + speed);
      if (next === this.scrollY) return;
      this.scroll?.scrollTo({ y: next, animated: false });
      this.scrollY = next;
      this.retarget();
    }, 16);
  }

  private at(f: Frame | null): Frame | null {
    return f && { ...f, y: f.y - (this.scrollY - this.startScrollY) };
  }

  private retarget() {
    const { x, y } = this.pointer;
    const source = this.sources[0]!;
    const sourceKeys = new Set(this.sources.map((s) => s.key));
    const live = [...this.items.values()].filter((i) => !sourceKeys.has(i.key) && i.frame);
    const cy = (i: Item) => {
      const f = this.at(i.frame)!;
      return f.y + Math.min(f.h, i.headerFrame?.h ?? f.h) / 2;
    };
    const byY = (a: Item, b: Item) => this.at(a.frame)!.y - this.at(b.frame)!.y || a.frame!.x - b.frame!.x;
    // Before an item's first tab that isn't being dragged (a group's member dragged out above its own group).
    const dragged = new Set(this.sources.flatMap((s) => s.tabIds));
    const firstTab = (i: Item | undefined) => i?.tabIds.find((id) => !dragged.has(id)) ?? null;
    const tabsDrag = source.kind === "row" || source.kind === "tile";
    const rowPitch =
      (source.kind === "group" || source.kind === "folder"
        ? (source.frame?.h ?? sidebarMetrics(useBrowser.getState().settings.density).rowHeight)
        : sidebarMetrics(useBrowser.getState().settings.density).rowHeight * Math.max(1, this.ghost?.count ?? 1)) + ROW_GAP;
    let drop: Drop = { type: "none" };
    let gapKey: string | null = null;
    let pitch = rowPitch;
    let into: string | null = null;

    const sidebar = this.viewport ?? this.rootFrame;
    const tiles = this.at(this.regionFrames.get("tiles") ?? null);
    if (x > sidebar.x + sidebar.w + 40 || x < sidebar.x - 40 || useTabDrag.getState().outside) {
      drop = { type: "none" };
    } else if (tabsDrag && tiles && inside(tiles, x, y, 6)) {
      const cells = live.filter((i) => i.kind === "tile").sort(byY);
      const before = cells.find((t) => {
        const f = this.at(t.frame)!;
        const mid = f.y + f.h / 2;
        return mid > y + f.h / 2 || (Math.abs(mid - y) <= f.h / 2 && f.x + f.w / 2 > x);
      });
      drop = { type: "tabs", placement: { pinned: true, beforeId: firstTab(before) } };
      gapKey = before?.key ?? "tail:tiles";
      pitch = (cells[0]?.frame?.w ?? source.frame?.w ?? 50) + PINNED_TILE_GAP;
    } else {
      // Above the line under the Pinned section, a tab is pinned there.
      const divider = this.at(this.regionFrames.get("divider") ?? null);
      const pinning = tabsDrag && !!divider && y < divider.y + divider.h / 2;
      // Onto a pinned folder's header (its middle third), or among its open rows.
      const folder = tabsDrag
        ? live
            .filter((i) => i.kind === "folder")
            .find((f) => {
              const header = this.at(f.headerFrame);
              if (header && inside(header, x, y)) return Math.abs(y - (header.y + header.h / 2)) < header.h / 3;
              return !f.collapsed && inside(this.at(f.frame)!, x, y);
            })
        : undefined;
      const groups = live.filter((i) => i.kind === "group");
      const box = tabsDrag
        ? groups.find((g) => {
            const f = this.at(g.frame)!;
            const header = this.at(g.headerFrame);
            if (g.collapsed) return !!header && inside(header, x, y) && Math.abs(y - (header.y + header.h / 2)) < header.h / 3;
            return inside(f, x, y) && (!header || y > header.y + header.h * 0.75);
          })
        : undefined;
      if (folder) {
        const header = this.at(folder.headerFrame);
        if (header && y <= header.y + header.h) {
          drop = { type: "tabs", placement: { pinned: false, row: true, folderId: folder.folderId!, beforeId: null } };
          into = folder.folderId!;
        } else {
          const members = live.filter((i) => i.kind === "row" && i.parentGroup === folder.folderId).sort(byY);
          const before = members.find((m) => cy(m) > y);
          drop = { type: "tabs", placement: { pinned: false, row: true, folderId: folder.folderId!, beforeId: firstTab(before) } };
          gapKey = before?.key ?? `tail:folder:${folder.folderId}`;
        }
      } else if (box?.collapsed) {
        drop = { type: "tabs", placement: { pinned: false, groupId: box.groupId!, beforeId: null } };
        into = box.groupId!;
      } else if (box) {
        const members = live.filter((i) => i.kind === "row" && i.parentGroup === box.groupId).sort(byY);
        const before = members.find((m) => cy(m) > y);
        drop = { type: "tabs", placement: { pinned: false, groupId: box.groupId!, beforeId: firstTab(before) } };
        gapKey = before?.key ?? `tail:group:${box.groupId}`;
      } else {
        const list = this.at(this.regionFrames.get("list") ?? null);
        // A folder stays in the Pinned section; a group goes among the pinned groups or the list.
        const pinned = source.kind === "group" && !!list && y < list.y;
        let section: Section = "list";
        if (source.kind === "folder" || pinning) section = "pinned";
        else if (pinned) section = "pinnedGroups";
        const blocks = live.filter((i) => i.section === section && !i.parentGroup && i.kind !== "tail" && i.kind !== "tile").sort(byY);
        // A block holding nothing but what's dragged (a group's last member) isn't a place to land before; an empty
        // folder is (its rows would land before the folders that follow, as it shows after them).
        const before = blocks.find((b) => cy(b) > y && (firstTab(b) !== null || (b.kind === "folder" && !b.tabIds.length)));
        gapKey = before?.key ?? `tail:${section}`;
        drop =
          source.kind === "group"
            ? { type: "group", placement: { pinned, beforeId: firstTab(before) } }
            : source.kind === "folder"
              ? { type: "folder", folderId: source.folderId!, beforeId: firstTab(before) }
              : { type: "tabs", placement: { pinned: false, row: section === "pinned", folderId: null, beforeId: firstTab(before) } };
      }
    }
    if (source.kind === "split" && drop.type === "tabs" && (drop.placement.pinned || drop.placement.groupId || drop.placement.row)) {
      drop = { type: "none" };
      gapKey = null;
      into = null;
    }

    const key = JSON.stringify(drop);
    if (key === this.dropKey && gapKey === this.gapKey) return;
    if (this.dropKey && drop.type !== "none" && useBrowser.getState().settings.tabReorderHaptics) hapticTick();
    this.dropKey = key;
    this.drop = drop;
    this.into = into;
    this.setDropInto(into);
    this.marks.setState({ pins: drop.type === "tabs" && drop.placement.pinned });
    if (gapKey !== this.gapKey) {
      const prev = this.gapKey && this.items.get(this.gapKey);
      if (prev) spring(prev.gap, 0);
      const next = gapKey && this.items.get(gapKey);
      if (next) spring(next.gap, pitch);
      this.gapKey = gapKey;
    }
  }
}

const DragContext = createContext<DragController | null>(null);

export function DragProvider({ children }: { children: (ghost: Ghost | null, controller: DragController) => ReactNode }) {
  const windowId = useWindowId();
  const density = useBrowser((s) => s.settings.density);
  const folded = useBrowser((s) => !!s.spaces[s.windows[windowId]?.spaceId ?? ""]?.folded);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [controller] = useState(() => new DragController(setGhost));
  useEffect(() => {
    // Changing density or folding the space invalidates the frames captured at drag start.
    if (controller.active) controller.end(false);
  }, [controller, density, folded]);
  useEffect(() => {
    if (__DEV__) (globalThis as { sidebarDrag?: DragController }).sidebarDrag = controller;
    // The sidebar going away mid-drag (its window closing, the layout switching) ends the drag and its picture.
    return () => void (controller.active && controller.end(false));
  }, [controller]);
  return (
    <DragContext.Provider value={controller}>
      {children(ghost, controller)}
      <WindowDropHighlight />
    </DragContext.Provider>
  );
}

function WindowDropHighlight() {
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
      style={[
        {
          position: "absolute",
          left: 5,
          right: 5,
          top: 44,
          bottom: 6,
          borderRadius: 10,
          borderWidth: 1.5,
          borderColor: theme.accent,
          backgroundColor: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
        },
        glowStyle,
      ]}
    />
  );
}

export function DragScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const controller = useContext(DragContext);
  return <DragContext.Provider value={enabled ? controller : null}>{children}</DragContext.Provider>;
}

export const useDragController = () => useContext(DragContext) ?? undefined;
export const useDropInto = () => useStore(useContext(DragContext)?.marks ?? noMarks, (m) => m.dropInto);
/** The item with `key` is being dragged (hidden, its room closing). */
export const useDragSource = (key: string) => useStore(useContext(DragContext)?.marks ?? noMarks, (m) => m.sources.has(key));
/** The drop would pin the dragged tabs. */
export const useDropPins = () => useStore(useContext(DragContext)?.marks ?? noMarks, (m) => m.pins);

export function useDragItem(key: string, spec: ItemSpec, selection: () => string[] = () => []) {
  const controller = useContext(DragContext) ?? undefined;
  const marks = controller?.marks ?? noMarks;
  const item = useMemo(() => controller?.create(key), [controller, key]);
  // What the controller reads of the item when a drag starts, as of the last commit.
  useLayoutEffect(() => {
    if (item) Object.assign(item, spec);
  });
  useEffect(() => {
    if (!controller || !item) return;
    controller.items.set(key, item);
    return () => {
      if (controller.items.get(key) === item) controller.items.delete(key);
    };
  }, [controller, item, key]);

  // One responder for the item's life: a new one mid-gesture would drop the gesture.
  const begin = useEffectEvent((x: number, y: number) => void controller?.begin(key, x, y, selection()));
  const movable = useEffectEvent(() => spec.kind !== "tail");
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => movable() && Math.hypot(g.dx, g.dy) > 4,
        onPanResponderGrant: (_, g) => begin(g.x0, g.y0),
        onPanResponderMove: (_, g) => controller?.move(g.moveX, g.moveY),
        onPanResponderRelease: () => controller?.end(true),
        onPanResponderTerminate: () => controller?.end(false),
        onPanResponderTerminationRequest: () => false,
      }),
    [controller, begin, movable],
  );
  const ref = (view: View | null) => item && controller?.attach(item, "view", view);
  const headerRef = (view: View | null) => item && controller?.attach(item, "header", view);

  const source = useStore(marks, (m) => m.sources.has(key));
  // Let go: laid out in its place, hidden until the ghost has settled there.
  const landing = useStore(marks, (m) => m.landing === key);
  const horizontal = spec.kind === "tile";
  const tail = spec.kind === "tail";
  const gap = item?.gap;
  const size = item?.size;
  // Every value it moves, every time, at rest too: a value the style stops giving keeps the last one it gave.
  const motion = useAnimatedStyle(() => {
    const room = gap ? gap.get() : 0;
    const lead = horizontal ? { marginLeft: room } : { marginTop: tail ? room - ROW_GAP : room };
    if (horizontal) return { ...lead, width: source && size ? size.get() : "auto" };
    return { ...lead, height: source && size ? size.get() : "auto" };
  }, [gap, size, horizontal, tail, source]);
  const style = item
    ? [
        motion,
        source
          ? horizontal
            ? { marginRight: -PINNED_TILE_GAP, opacity: 0, overflow: "hidden" as const }
            : { marginBottom: -ROW_GAP, opacity: 0, overflow: "hidden" as const }
          : landing
            ? { opacity: 0 }
            : null,
      ]
    : null;
  // Flat, for callers to destructure: the compiler treats `x.ref` (and the rest of `x`) as a ref read.
  return { ref, style, handle: responder.panHandlers, headerRef, dragging: source };
}
