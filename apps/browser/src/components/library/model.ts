/** Local documents outlive their tabs. Image files live in Application Support, never the capture cache. */
import * as v from "valibot";

export type CaptureSource = {
  url: string;
  title: string;
  clip?: number[];
  viewportWidth?: number;
  viewportHeight?: number;
  profileId?: string;
};

export type EaselItem = {
  id: string;
  kind: "image" | "text" | "link" | "pen" | "rect" | "ellipse" | "arrow";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  lineWidth?: number;
  fontSize?: number;
  text?: string;
  url?: string;
  path?: string;
  points?: number[][];
  source?: CaptureSource;
  live?: boolean;
};

export type EaselDocument = {
  id: string;
  title: string;
  background: string;
  items: EaselItem[];
  createdAt: number;
  updatedAt: number;
  spaceId: string;
  nativeEditId?: string;
};

export type LibraryMedia = {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  createdAt: number;
  source?: CaptureSource;
};

export type LibraryData = { version: 1; easels: Record<string, EaselDocument>; media: Record<string, LibraryMedia>; removedMediaPaths: string[] };

const CaptureSourceSchema = v.object({
  url: v.string(),
  title: v.string(),
  clip: v.optional(v.array(v.number())),
  viewportWidth: v.optional(v.number()),
  viewportHeight: v.optional(v.number()),
  profileId: v.optional(v.string()),
});

const validCaptureSource = (source: CaptureSource | undefined): source is CaptureSource => {
  if (!source || !webLink(source.url)) return false;

  if (source.clip !== undefined && !(source.clip.length === 4 && source.clip.every(Number.isFinite) && source.clip[2]! > 0 && source.clip[3]! > 0))
    return false;

  if (source.viewportWidth !== undefined && !(Number.isFinite(source.viewportWidth) && source.viewportWidth > 0)) return false;

  if (source.viewportHeight !== undefined && !(Number.isFinite(source.viewportHeight) && source.viewportHeight > 0)) return false;

  return true;
};

const EaselItemSchema = v.object({
  id: v.string(),
  kind: v.picklist(["image", "text", "link", "pen", "rect", "ellipse", "arrow"]),
  x: v.number(),
  y: v.number(),
  width: v.number(),
  height: v.number(),
  color: v.optional(v.string()),
  lineWidth: v.optional(v.number()),
  fontSize: v.optional(v.number()),
  text: v.optional(v.string()),
  url: v.optional(v.string()),
  path: v.optional(v.string()),
  points: v.optional(v.array(v.tuple([v.number(), v.number()]))),
  source: v.optional(CaptureSourceSchema),
  live: v.optional(v.boolean()),
});

const withinCanvasBounds = (item: { x: number; y: number; width: number; height: number }) =>
  [item.x, item.y, item.width, item.height].every(Number.isFinite) &&
  [item.x, item.y, item.width, item.height].every((n) => Math.abs(n) <= 1_000_000) &&
  item.width >= 0 &&
  item.height >= 0;

/** An item as written by this app: structural checks, canvas bounds, and source-link validity. */
export function validItem<T>(value: T): value is T & EaselItem {
  const parsed = v.safeParse(EaselItemSchema, value);

  if (!parsed.success) return false;
  const item = parsed.output;

  if (!withinCanvasBounds(item)) return false;

  if (item.points !== undefined && !item.points.every((p) => p.every(Number.isFinite))) return false;

  if (item.url !== undefined && !webLink(item.url)) return false;

  if (item.path !== undefined && !item.path.startsWith("/")) return false;

  if (item.source !== undefined && !validCaptureSource(item.source)) return false;

  return true;
}

export const webLink = (url: string) => /^https?:\/\/[^\s]+$/i.test(url);

const EaselDocumentSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  title: v.string(),
  background: v.pipe(v.string(), v.regex(/^#[\da-f]{6}$/i)),
  items: v.array(EaselItemSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
  spaceId: v.string(),
  nativeEditId: v.optional(v.string()),
});

export function parseEasel<T>(value: T): EaselDocument | null {
  const parsed = v.safeParse(EaselDocumentSchema, value);

  if (!parsed.success) return null;
  const doc = parsed.output;

  if (!Number.isFinite(doc.createdAt) || !Number.isFinite(doc.updatedAt)) return null;

  if (!doc.items.every((item) => validItem(item))) return null;

  if (new Set(doc.items.map((item) => item.id)).size !== doc.items.length) return null;

  return doc;
}

const LibraryDocumentSchema = v.object({
  version: v.literal(1),
  easels: v.record(v.string(), v.unknown()),
  media: v.record(v.string(), v.unknown()),
  removedMediaPaths: v.optional(v.array(v.string())),
});

const LibraryMediaSchema = v.object({
  id: v.string(),
  name: v.string(),
  path: v.string(),
  width: v.number(),
  height: v.number(),
  createdAt: v.number(),
  source: v.optional(CaptureSourceSchema),
});

export function readLibrary(json: string | null): LibraryData {
  const empty: LibraryData = { version: 1, easels: {}, media: {}, removedMediaPaths: [] };

  if (!json) return empty;
  const value: unknown = JSON.parse(json);
  const parsed = v.safeParse(LibraryDocumentSchema, value);

  if (!parsed.success) throw new Error("Unsupported Library data");
  const doc = parsed.output;

  empty.removedMediaPaths = (doc.removedMediaPaths ?? []).filter((p) => p.startsWith("/"));

  for (const [id, easel] of Object.entries(doc.easels)) {
    const parsedEasel = parseEasel(easel);

    if (parsedEasel && id === parsedEasel.id) empty.easels[id] = parsedEasel;
  }

  for (const [id, media] of Object.entries(doc.media)) {
    const parsedMedia = v.safeParse(LibraryMediaSchema, media);

    if (!parsedMedia.success) continue;
    const m = parsedMedia.output;

    if (m.id !== id || !m.path.startsWith("/")) continue;

    if (![m.width, m.height, m.createdAt].every(Number.isFinite) || m.width <= 0 || m.height <= 0) continue;

    if (m.source !== undefined && !validCaptureSource(m.source)) continue;
    empty.media[id] = m;
  }

  return empty;
}

export function mediaItem(media: LibraryMedia, items: EaselItem[], id: string): EaselItem {
  const width = Math.min(media.width, 560);
  const height = (width * media.height) / media.width;
  const x = items.length ? Math.max(...items.map((i) => i.x + i.width)) + 32 : 64;

  return { id, kind: "image", x, y: 64, width, height, path: media.path, ...(media.source ? { source: media.source } : undefined) };
}
