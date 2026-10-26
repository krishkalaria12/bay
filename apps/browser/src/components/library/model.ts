/** Local documents outlive their tabs. Image files live in Application Support, never the capture cache. */
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

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KINDS = new Set(["image", "text", "link", "pen", "rect", "ellipse", "arrow"]);
export const webLink = (url: string) => /^https?:\/\/[^\s]+$/i.test(url);

export function validItem(v: unknown): v is EaselItem {
  if (!record(v) || typeof v.id !== "string" || !KINDS.has(String(v.kind))) return false;
  if (![v.x, v.y, v.width, v.height].every(finite) || (v.width as number) < 0 || (v.height as number) < 0) return false;
  if ([v.x, v.y, v.width, v.height].some((n) => Math.abs(n as number) > 1_000_000)) return false;
  if (v.points !== undefined && (!Array.isArray(v.points) || !v.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite)))) return false;
  if (v.path !== undefined && (typeof v.path !== "string" || !v.path.startsWith("/"))) return false;
  if (v.text !== undefined && typeof v.text !== "string") return false;
  if (v.url !== undefined && (typeof v.url !== "string" || !webLink(v.url))) return false;
  if (v.source !== undefined) {
    const s = v.source;
    if (!record(s) || typeof s.url !== "string" || !webLink(s.url) || typeof s.title !== "string") return false;
    if (s.clip !== undefined && (!Array.isArray(s.clip) || s.clip.length !== 4 || !s.clip.every(finite) || s.clip[2]! <= 0 || s.clip[3]! <= 0)) return false;
    if (s.viewportWidth !== undefined && (!finite(s.viewportWidth) || s.viewportWidth <= 0)) return false;
    if (s.viewportHeight !== undefined && (!finite(s.viewportHeight) || s.viewportHeight <= 0)) return false;
    if (s.profileId !== undefined && typeof s.profileId !== "string") return false;
  }
  return true;
}

export function parseEasel(value: unknown): EaselDocument | null {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" || typeof value.spaceId !== "string") return null;
  if (!finite(value.createdAt) || !finite(value.updatedAt) || typeof value.background !== "string" || !/^#[\da-f]{6}$/i.test(value.background)) return null;
  if (!Array.isArray(value.items) || !value.items.every(validItem) || new Set(value.items.map((i) => i.id)).size !== value.items.length) return null;
  if (value.nativeEditId !== undefined && typeof value.nativeEditId !== "string") return null;
  return value as EaselDocument;
}

export function readLibrary(json: string | null): LibraryData {
  const empty: LibraryData = { version: 1, easels: {}, media: {}, removedMediaPaths: [] };
  if (!json) return empty;
  const value: unknown = JSON.parse(json);
  if (!record(value) || value.version !== 1 || !record(value.easels) || !record(value.media)) throw new Error("Unsupported Library data");
  empty.removedMediaPaths = Array.isArray(value.removedMediaPaths)
    ? value.removedMediaPaths.filter((p): p is string => typeof p === "string" && p.startsWith("/"))
    : [];
  for (const [id, v] of Object.entries(value.easels)) {
    const doc = parseEasel(v);
    if (doc && id === doc.id) empty.easels[id] = doc;
  }
  for (const [id, v] of Object.entries(value.media)) {
    if (!record(v) || v.id !== id || typeof v.name !== "string" || typeof v.path !== "string" || !v.path.startsWith("/")) continue;
    if (![v.width, v.height, v.createdAt].every(finite) || (v.width as number) <= 0 || (v.height as number) <= 0) continue;
    if (v.source !== undefined && !validItem({ id, kind: "image", x: 0, y: 0, width: v.width, height: v.height, source: v.source })) continue;
    empty.media[id] = v as LibraryMedia;
  }
  return empty;
}

export function mediaItem(media: LibraryMedia, items: EaselItem[], id: string): EaselItem {
  const width = Math.min(media.width, 560);
  const height = (width * media.height) / media.width;
  const x = items.length ? Math.max(...items.map((i) => i.x + i.width)) + 32 : 64;
  return { id, kind: "image", x, y: 64, width, height, path: media.path, ...(media.source ? { source: media.source } : {}) };
}
