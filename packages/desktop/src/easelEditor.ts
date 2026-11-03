import type { EaselDocument, EaselItem, EaselState, EaselTool } from "./easel";

// The Easel canvas's editing, without a view: the port of EaselCanvasView (ios/Easel.swift) the desktop hosts use.
// EaselCanvas.web.tsx feeds it pointer and key events and draws what it holds.

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type EaselModifiers = { shift: boolean; option: boolean; command: boolean };
export type EaselPress = EaselModifiers & { button: number; clickCount: number };
export type EaselKey = EaselModifiers & { key: string };
export type RetainedImage = { path: string; width: number; height: number };
type EditKey = "text" | "url";
type Mode = "" | "pan" | "move" | "resize" | "marquee" | "draw";

export type EaselEditorHost = {
  size(): { width: number; height: number };
  /** The canvas needs drawing. */
  changed(): void;
  emit(state: EaselState): void;
  openLink(url: string): void;
  /** Shows the text field over `item`. */
  openEditor(item: EaselItem, key: EditKey): void;
  /** The field's text, while it's up. */
  editorText(): string | null;
  closeEditor(): void;
};

const LIMIT = 10_000_000;
const clamp = (value: number) => Math.min(LIMIT, Math.max(-LIMIT, value));
const finite = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? clamp(value) : fallback);

export const itemRect = (item: EaselItem): Rect => ({
  x: finite(item.x),
  y: finite(item.y),
  width: Math.max(1, finite(item.width, 1)),
  height: Math.max(1, finite(item.height, 1)),
});

export function itemPoints(item: EaselItem): Point[] {
  return (item.points ?? []).filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => ({ x: clamp(p[0]!), y: clamp(p[1]!) }));
}

const union = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const inset = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, width: r.width - 2 * by, height: r.height - 2 * by });
const contains = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
const corners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height },
  { x: r.x, y: r.y + r.height },
];

/** What every item covers, strokes and arrowheads included. */
export function contentBounds(items: readonly EaselItem[]): Rect | null {
  let bounds: Rect | null = null;
  for (const item of items) {
    const width = Math.max(0.5, finite(item.lineWidth, 2));
    const padding = item.kind === "arrow" ? Math.max(12, width * 4) : Math.max(2, width * 2);
    bounds = union(bounds, inset(itemRect(item), -padding));
  }
  if (!bounds) return null;
  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);
  return { x, y, width: Math.ceil(bounds.x + bounds.width) - x, height: Math.ceil(bounds.y + bounds.height) - y };
}

/** Only http(s) with a host: what a link on a canvas may open. */
export function safeUrl(text: string): string | null {
  try {
    const url = new URL(text);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

const TOOL_KEYS: Record<string, EaselTool> = { v: "select", h: "hand", p: "pen", t: "text", r: "rect", o: "ellipse", a: "arrow" };
const HISTORY_LIMIT = 100;
const EDIT_ID_LIMIT = 128;
const EMPTY: EaselDocument = { id: "", title: "", background: "#FFFFFF", items: [], createdAt: 0, updatedAt: 0, spaceId: "" };

export class EaselEditor {
  ink = "#222222";
  strokeWidth = 2;
  document: EaselDocument = EMPTY;
  selection = new Set<string>();
  draft: EaselItem | null = null;
  /** In the canvas's own points. */
  marquee: Rect | null = null;
  viewport: Point = { x: 0, y: 0 };
  zoom = 1;
  spaceHeld = false;
  tool: EaselTool = "select";

  private readonly host: EaselEditorHost;
  private history: EaselDocument[] = [];
  private future: EaselDocument[] = [];
  private emittedEditIds: string[] = [];
  private emitted = "";
  private editing: { id: string; key: EditKey } | null = null;
  private mode: Mode = "";
  private downScreen: Point = { x: 0, y: 0 };
  private downWorld: Point = { x: 0, y: 0 };
  private downViewport: Point = { x: 0, y: 0 };
  private beforeDrag: EaselDocument | null = null;
  private dragItems: EaselItem[] = [];
  private dragSelection = new Set<string>();
  private resizingCorner = -1;
  private resizeBounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private strokePoints: Point[] = [];

  constructor(host: EaselEditorHost) {
    this.host = host;
  }

  get items() {
    return this.document.items;
  }
  private set items(items: EaselItem[]) {
    this.document = { ...this.document, items };
  }
  get canUndo() {
    return this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get cursor() {
    if (this.tool === "hand" || this.spaceHeld) return this.mode === "pan" ? "grabbing" : "grab";
    return this.tool === "text" ? "text" : this.tool === "select" ? "default" : "crosshair";
  }

  /** A document from the app: an echo of this canvas's own edit leaves its selection, gesture and undo alone. */
  load(json: string) {
    let next: EaselDocument;
    try {
      next = JSON.parse(json) as EaselDocument;
    } catch {
      return;
    }
    if (typeof next?.id !== "string" || !Array.isArray(next.items)) return;
    if (JSON.stringify(next) === JSON.stringify(this.document)) return;
    const same = next.id === this.document.id;
    if (same) {
      if (JSON.stringify(next.items) === JSON.stringify(this.items)) {
        // Persistence may replace updatedAt or rename the document when echoing an edit.
        this.document = next;
        this.emitted = JSON.stringify(next);
        this.host.changed();
        return;
      }
      if (next.nativeEditId && this.emittedEditIds.includes(next.nativeEditId)) return;
    }
    this.cancelEditor();
    this.document = next;
    this.history = [];
    this.future = [];
    this.beforeDrag = null;
    this.draft = null;
    this.marquee = null;
    this.mode = "";
    this.selection = new Set();
    if (!same) {
      this.viewport = { x: 0, y: 0 };
      this.zoom = 1;
    }
    this.emit();
  }

  setTool(tool: EaselTool) {
    if (tool === this.tool) return;
    this.tool = tool;
    // Committing a text edit can emit state; report the incoming tool so the toolbar does not revert it.
    this.commitText();
    this.host.changed();
  }

  world(point: Point): Point {
    return { x: point.x / this.zoom + this.viewport.x, y: point.y / this.zoom + this.viewport.y };
  }
  screen(point: Point): Point {
    return { x: (point.x - this.viewport.x) * this.zoom, y: (point.y - this.viewport.y) * this.zoom };
  }
  private get center() {
    const { width, height } = this.host.size();
    return this.world({ x: width / 2, y: height / 2 });
  }
  get selectedBounds(): Rect | null {
    let bounds: Rect | null = null;
    for (const item of this.items) if (this.selection.has(item.id)) bounds = union(bounds, itemRect(item));
    return bounds;
  }

  emit() {
    this.host.changed();
    if (!this.document.id) return;
    this.emitted = JSON.stringify(this.document);
    this.report();
  }

  // Selection and the viewport change far more often than the document, which the app saves.
  private report() {
    this.host.changed();
    if (!this.document.id) return;
    const viewport = { x: this.viewport.x, y: this.viewport.y, zoom: this.zoom };
    this.host.emit({
      document: this.emitted,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      selection: [...this.selection].sort(),
      zoom: this.zoom,
      tool: this.tool,
      viewport,
    });
  }

  private markEdit() {
    const id = crypto.randomUUID();
    this.document = { ...this.document, nativeEditId: id };
    this.emittedEditIds.push(id);
    if (this.emittedEditIds.length > EDIT_ID_LIMIT) this.emittedEditIds.shift();
  }

  private record(previous: EaselDocument) {
    if (JSON.stringify(previous) === JSON.stringify(this.document)) return this.emit();
    this.history.push(previous);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.document = { ...this.document, updatedAt: Date.now() };
    this.markEdit();
    this.emit();
  }

  undo() {
    this.commitText();
    const previous = this.history.pop();
    if (!previous) return;
    this.future.push(this.document);
    this.document = previous;
    this.markEdit();
    this.selection = new Set();
    this.emit();
  }

  redo() {
    this.commitText();
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.document);
    this.document = next;
    this.markEdit();
    this.selection = new Set();
    this.emit();
  }

  selectAll() {
    this.selection = new Set(this.items.map((i) => i.id));
    this.report();
  }

  deleteSelection() {
    this.commitText();
    if (!this.selection.size) return;
    const previous = this.document;
    this.items = this.items.filter((i) => !this.selection.has(i.id));
    this.selection = new Set();
    this.record(previous);
  }

  duplicateSelection() {
    this.commitText();
    this.insertCopies(
      this.items.filter((i) => this.selection.has(i.id)),
      null,
    );
  }

  reorder(front: boolean) {
    this.commitText();
    if (!this.selection.size) return;
    const previous = this.document;
    const chosen = this.items.filter((i) => this.selection.has(i.id));
    const remaining = this.items.filter((i) => !this.selection.has(i.id));
    this.items = front ? [...remaining, ...chosen] : [...chosen, ...remaining];
    this.record(previous);
  }

  zoomBy(factor: number, at?: Point) {
    this.commitText();
    const { width, height } = this.host.size();
    const anchor = at ?? { x: width / 2, y: height / 2 };
    const location = this.world(anchor);
    this.zoom = Math.min(8, Math.max(0.05, this.zoom * factor));
    this.viewport = { x: location.x - anchor.x / this.zoom, y: location.y - anchor.y / this.zoom };
    this.report();
  }

  fit() {
    this.commitText();
    const box = contentBounds(this.items);
    if (!box) {
      this.viewport = { x: 0, y: 0 };
      this.zoom = 1;
      return this.report();
    }
    const { width, height } = this.host.size();
    this.zoom = Math.min(4, Math.max(0.05, Math.min(Math.max(1, width - 64) / box.width, Math.max(1, height - 64) / box.height)));
    this.viewport = { x: box.x + box.width / 2 - width / (2 * this.zoom), y: box.y + box.height / 2 - height / (2 * this.zoom) };
    this.report();
  }

  /** `delta` in points, as the page would scroll. */
  scroll(delta: Point) {
    this.commitText();
    this.viewport = { x: this.viewport.x + delta.x / this.zoom, y: this.viewport.y + delta.y / this.zoom };
    this.report();
  }

  private makeItem(kind: EaselItem["kind"], at: Point, width: number, height: number): EaselItem {
    return { id: crypto.randomUUID(), kind, x: at.x, y: at.y, width, height, color: this.ink, lineWidth: this.strokeWidth };
  }

  addText(text: string, at?: Point) {
    this.commitText();
    const previous = this.document;
    const item = { ...this.makeItem("text", at ?? this.center, 280, Math.max(40, text.split("\n").length * 30)), text, fontSize: 24 };
    this.items = [...this.items, item];
    this.selection = new Set([item.id]);
    this.record(previous);
    if (!text) this.beginEditing(item);
  }

  addLink(url: string, title: string, at?: Point) {
    this.commitText();
    const address = safeUrl(url);
    if (!address) return;
    const previous = this.document;
    const item = { ...this.makeItem("link", at ?? this.center, 320, 80), text: title || url, url: address, fontSize: 16 };
    this.items = [...this.items, item];
    this.selection = new Set([item.id]);
    this.record(previous);
  }

  insertImages(retained: readonly RetainedImage[], at?: Point) {
    this.commitText();
    if (!retained.length) return;
    const point = at ?? this.center;
    const previous = this.document;
    const added = retained.map((media, index) => {
      const scale = Math.min(1, 640 / Math.max(media.width, media.height));
      const place = { x: point.x + index * 24, y: point.y + index * 24 };
      return { ...this.makeItem("image", place, media.width * scale, media.height * scale), path: media.path };
    });
    this.items = [...this.items, ...added];
    this.selection = new Set(added.map((i) => i.id));
    this.record(previous);
  }

  /** Copies of `copies`, at `at` or a step along. */
  insertCopies(copies: readonly EaselItem[], at: Point | null) {
    if (!copies.length) return;
    const previous = this.document;
    const box = contentBounds(copies) ?? { x: 0, y: 0, width: 0, height: 0 };
    const dx = at ? at.x - box.x : 24;
    const dy = at ? at.y - box.y : 24;
    const added = copies.map((item) => ({ ...item, id: crypto.randomUUID(), x: finite(item.x) + dx, y: finite(item.y) + dy }));
    this.items = [...this.items, ...added];
    this.selection = new Set(added.map((i) => i.id));
    this.record(previous);
  }

  /** The selection for the clipboard: its items, and their links or text as plain text. */
  copySelection(): { items: string; plain: string } | null {
    this.commitText();
    const chosen = this.items.filter((i) => this.selection.has(i.id));
    if (!chosen.length) return null;
    return { items: JSON.stringify(chosen), plain: chosen.flatMap((i) => i.url ?? i.text ?? []).join("\n") };
  }

  /** The pasted text, as a link when it is one. */
  pasteText(text: string, at?: Point) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (safeUrl(trimmed)) this.addLink(trimmed, trimmed, at);
    else this.addText(text, at);
    return true;
  }

  pasteItems(json: string, at?: Point) {
    try {
      const copied: unknown = JSON.parse(json);
      if (!Array.isArray(copied) || !copied.length) return false;
      this.commitText();
      this.insertCopies(copied as EaselItem[], at ?? this.center);
      return true;
    } catch {
      return false;
    }
  }

  // MARK: Pointer

  pointerDown(p: Point, press: EaselPress) {
    this.commitText();
    this.downScreen = p;
    this.downWorld = this.world(p);
    this.downViewport = this.viewport;
    this.beforeDrag = this.document;
    this.dragSelection = new Set(this.selection);
    if (this.tool === "hand" || this.spaceHeld || press.button === 1) {
      this.mode = "pan";
      return;
    }
    if (this.tool === "text") {
      this.addText("", this.downWorld);
      this.mode = "";
      return;
    }
    if (this.tool !== "select") {
      this.mode = "draw";
      this.draft = this.makeItem(this.tool, this.downWorld, 1, 1);
      this.strokePoints = [this.downWorld];
      return;
    }
    const box = this.selectedBounds;
    if (box) {
      const corner = corners(box).findIndex((c) => {
        const s = this.screen(c);
        return Math.hypot(s.x - p.x, s.y - p.y) < 9;
      });
      if (corner !== -1) {
        this.resizingCorner = corner;
        this.resizeBounds = box;
        this.mode = "resize";
        return;
      }
    }
    const hit = this.itemAt(this.downWorld, 4 / this.zoom);
    if (!hit) {
      if (!press.shift) this.selection = new Set();
      this.dragSelection = new Set(this.selection);
      this.mode = "marquee";
      return this.report();
    }
    if (press.command && hit.url && safeUrl(hit.url)) {
      this.host.openLink(hit.url);
      this.mode = "";
      return;
    }
    if (press.clickCount === 2 && (hit.kind === "text" || hit.kind === "link")) {
      this.selection = new Set([hit.id]);
      this.beginEditing(hit, press.option && hit.kind === "link" ? "url" : "text");
      this.mode = "";
      return this.report();
    }
    if (press.shift) {
      if (this.selection.has(hit.id)) {
        this.selection.delete(hit.id);
        this.mode = "";
        return this.report();
      }
      this.selection.add(hit.id);
    } else if (!this.selection.has(hit.id)) {
      this.selection = new Set([hit.id]);
    }
    if (press.option) {
      // Option-drag duplicates in one history entry when released.
      const copies = this.items.filter((i) => this.selection.has(i.id)).map((i) => ({ ...i, id: crypto.randomUUID() }));
      this.items = [...this.items, ...copies];
      this.selection = new Set(copies.map((i) => i.id));
      this.markEdit();
    }
    // Movement starts from the post-duplicate items, but undo returns to before duplication.
    this.dragItems = this.items;
    this.mode = "move";
    this.report();
  }

  private itemAt(point: Point, slop: number) {
    return [...this.items].reverse().find((item) => contains(inset(itemRect(item), -slop), point));
  }

  pointerMove(p: Point, modifiers: Pick<EaselModifiers, "shift">) {
    const at = this.world(p);
    const dx = at.x - this.downWorld.x;
    const dy = at.y - this.downWorld.y;
    switch (this.mode) {
      case "pan":
        this.viewport = { x: this.downViewport.x - (p.x - this.downScreen.x) / this.zoom, y: this.downViewport.y - (p.y - this.downScreen.y) / this.zoom };
        break;
      case "move":
        this.items = this.dragItems.map((item) => (this.selection.has(item.id) ? { ...item, x: finite(item.x) + dx, y: finite(item.y) + dy } : item));
        break;
      case "resize":
        this.resizeTo(at, modifiers.shift);
        break;
      case "marquee": {
        this.marquee = {
          x: Math.min(p.x, this.downScreen.x),
          y: Math.min(p.y, this.downScreen.y),
          width: Math.abs(p.x - this.downScreen.x),
          height: Math.abs(p.y - this.downScreen.y),
        };
        const box = { x: Math.min(at.x, this.downWorld.x), y: Math.min(at.y, this.downWorld.y), width: Math.abs(dx), height: Math.abs(dy) };
        this.selection = new Set([...this.dragSelection, ...this.items.filter((i) => intersects(box, itemRect(i))).map((i) => i.id)]);
        break;
      }
      case "draw":
        this.drawTo(at, dx, dy, modifiers.shift);
        break;
      default:
        return;
    }
    this.report();
  }

  private resizeTo(at: Point, keepRatio: boolean) {
    const previous = this.beforeDrag?.items;
    if (!previous) return;
    const bounds = this.resizeBounds;
    const opposite = corners(bounds)[(this.resizingCorner + 2) % 4]!;
    const target: Rect = {
      x: Math.min(opposite.x, at.x),
      y: Math.min(opposite.y, at.y),
      width: Math.max(4, Math.abs(opposite.x - at.x)),
      height: Math.max(4, Math.abs(opposite.y - at.y)),
    };
    if (keepRatio) {
      target.height = target.width / Math.max(0.001, bounds.width / Math.max(1, bounds.height));
      if (this.resizingCorner < 2) target.y = opposite.y - target.height;
    }
    const sx = target.width / Math.max(1, bounds.width);
    const sy = target.height / Math.max(1, bounds.height);
    this.items = previous.map((value) => {
      if (!this.selection.has(value.id)) return value;
      const old = itemRect(value);
      const item: EaselItem = {
        ...value,
        x: target.x + (old.x - bounds.x) * sx,
        y: target.y + (old.y - bounds.y) * sy,
        width: old.width * sx,
        height: old.height * sy,
      };
      if (value.points) item.points = itemPoints(value).map((p) => [p.x * sx, p.y * sy]);
      if (value.fontSize !== undefined) item.fontSize = Math.max(1, finite(value.fontSize, 24) * Math.min(sx, sy));
      return item;
    });
  }

  private drawTo(at: Point, dx: number, dy: number, keepSquare: boolean) {
    const draft = this.draft;
    if (!draft) return;
    const start = this.downWorld;
    let end = at;
    if (keepSquare && (this.tool === "rect" || this.tool === "ellipse")) {
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      end = { x: start.x + (dx < 0 ? -size : size), y: start.y + (dy < 0 ? -size : size) };
    }
    if (this.tool === "pen") this.strokePoints.push(at);
    const points = this.tool === "pen" ? this.strokePoints : [start, end];
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const next: EaselItem = {
      ...draft,
      x: minX,
      y: minY,
      width: Math.max(1, Math.max(...points.map((p) => p.x)) - minX),
      height: Math.max(1, Math.max(...points.map((p) => p.y)) - minY),
    };
    if (this.tool === "pen" || this.tool === "arrow") next.points = points.map((p) => [p.x - minX, p.y - minY]);
    this.draft = next;
  }

  pointerUp() {
    const previous = this.beforeDrag;
    const mode = this.mode;
    this.beforeDrag = null;
    if (mode === "draw" && this.draft) {
      const item = this.tool === "pen" && !this.draft.points ? { ...this.draft, points: [[0, 0]] } : this.draft;
      const r = itemRect(item);
      // Drawn, not selected: the tool stays ready for the next mark (V selects).
      if (this.tool === "pen" || Math.max(r.width, r.height) * this.zoom > 3) {
        this.items = [...this.items, item];
        this.selection = new Set();
      }
    }
    this.draft = null;
    this.marquee = null;
    this.mode = "";
    this.dragItems = [];
    this.strokePoints = [];
    if ((mode === "draw" || mode === "move" || mode === "resize") && previous) this.record(previous);
    else this.report();
  }

  // MARK: Text

  private beginEditing(item: EaselItem, key: EditKey = "text") {
    this.commitText();
    this.editing = { id: item.id, key };
    this.host.openEditor(item, key);
  }

  cancelEditor() {
    if (!this.editing) return;
    this.editing = null;
    this.host.closeEditor();
  }

  commitText() {
    const editing = this.editing;
    if (!editing) return;
    const text = this.host.editorText();
    this.cancelEditor();
    const item = this.items.find((i) => i.id === editing.id);
    if (text === null || !item || item[editing.key] === text) return;
    const value = editing.key === "url" ? safeUrl(text) : text;
    if (value === null) return;
    const previous = this.document;
    this.items = this.items.map((i) => (i.id === editing.id ? { ...i, [editing.key]: value } : i));
    this.record(previous);
  }

  // MARK: Keys

  /** True when the canvas took the key. */
  keyDown({ key, shift, option, command }: EaselKey): boolean {
    const lower = key.toLowerCase();
    const tool = TOOL_KEYS[lower];
    if (tool && !command && !option) {
      if (tool !== this.tool) {
        this.setTool(tool);
        this.report();
      }
      return true;
    }
    if (command) {
      const commands: Record<string, () => void> = {
        z: () => (shift ? this.redo() : this.undo()),
        a: () => this.selectAll(),
        d: () => this.duplicateSelection(),
        "+": () => this.zoomBy(1.2),
        "=": () => this.zoomBy(1.2),
        "-": () => this.zoomBy(1 / 1.2),
        "0": () => this.fit(),
        "]": () => this.reorder(true),
        "[": () => this.reorder(false),
      };
      const run = commands[lower];
      run?.();
      return !!run;
    }
    if (key === " ") {
      this.spaceHeld = true;
      this.host.changed();
      return true;
    }
    if (key === "Backspace" || key === "Delete") {
      this.deleteSelection();
      return true;
    }
    if (key === "Escape") {
      this.cancelGesture();
      return true;
    }
    if (key === "Enter") {
      const item = this.items.find((i) => this.selection.has(i.id) && (i.kind === "text" || i.kind === "link"));
      if (!item) return false;
      this.beginEditing(item);
      return true;
    }
    const step = shift ? 10 : 1;
    const arrows: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const arrow = arrows[key];
    if (arrow && this.selection.size) {
      const previous = this.document;
      this.items = this.items.map((i) => (this.selection.has(i.id) ? { ...i, x: finite(i.x) + arrow.x, y: finite(i.y) + arrow.y } : i));
      this.record(previous);
      return true;
    }
    return false;
  }

  keyUp(key: string) {
    if (key !== " ") return;
    this.spaceHeld = false;
    this.host.changed();
  }

  blur() {
    this.spaceHeld = false;
  }

  private cancelGesture() {
    if (this.beforeDrag) {
      const changed = JSON.stringify(this.items) !== JSON.stringify(this.beforeDrag.items);
      this.document = this.beforeDrag;
      if (changed) this.markEdit();
    }
    this.beforeDrag = null;
    this.mode = "";
    this.draft = null;
    this.marquee = null;
    this.selection = new Set();
    this.report();
  }

  // MARK: Context menu

  /** Selects what's under a right click. */
  menuAt(p: Point) {
    this.commitText();
    const item = this.itemAt(this.world(p), 0);
    if (item && !this.selection.has(item.id)) {
      this.selection = new Set([item.id]);
      this.report();
    }
  }

  private selectedLinkUrl() {
    const item = this.items.find((i) => this.selection.has(i.id) && safeUrl(i.url ?? i.source?.url ?? ""));
    return item ? (item.url ?? item.source?.url ?? null) : null;
  }

  get menu() {
    const selected = this.selection.size > 0;
    return [
      { id: "undo", title: "Undo", enabled: this.canUndo },
      { id: "redo", title: "Redo", enabled: this.canRedo },
      { id: "cut", title: "Cut", enabled: selected },
      { id: "copy", title: "Copy", enabled: selected },
      { id: "paste", title: "Paste", enabled: true },
      { id: "duplicate", title: "Duplicate", enabled: selected },
      { id: "selectAll", title: "Select All", enabled: this.items.length > 0 },
      { id: "delete", title: "Delete", enabled: selected },
      { id: "editLink", title: "Edit Link URL", enabled: this.items.some((i) => this.selection.has(i.id) && i.kind === "link") },
      { id: "openLink", title: "Open Link", enabled: this.selectedLinkUrl() !== null },
    ];
  }

  /** A menu item that needs no clipboard. */
  runMenu(id: string) {
    if (id === "undo") this.undo();
    if (id === "redo") this.redo();
    if (id === "duplicate") this.duplicateSelection();
    if (id === "selectAll") this.selectAll();
    if (id === "delete") this.deleteSelection();
    if (id === "editLink") {
      const item = this.items.find((i) => this.selection.has(i.id) && i.kind === "link");
      if (item) this.beginEditing(item, "url");
    }
    if (id === "openLink") {
      const url = this.selectedLinkUrl();
      if (url) this.host.openLink(url);
    }
  }
}
