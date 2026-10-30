import { readDocument, retainLibraryImage, writeDocument } from "@bay/shell";
import { create } from "zustand";
import { newId } from "../../store/model";
import { fileNameOf, mediaItem, parseEasel, readLibrary, type CaptureSource, type EaselDocument, type LibraryData, type LibraryMedia } from "./model";

export type LibraryState = LibraryData & { loaded: boolean; error: string | null };
export const useLibrary = create<LibraryState>()(() => ({ version: 1, easels: {}, media: {}, removedMediaPaths: [], loaded: false, error: null }));
let stop: (() => void) | undefined;

const libraryData = ({ easels, media, removedMediaPaths }: LibraryData): LibraryData => ({ version: 1, easels, media, removedMediaPaths });

/** On the desktop hosts each window holds its own copy of the Library: one's changes reach the others here. */
function syncWindows() {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel("bay-library");
  // Node's channel would otherwise hold a test process open; a page's has no unref.
  (channel as { unref?(): void }).unref?.();
  let applying = false;
  channel.onmessage = ({ data }: MessageEvent<LibraryData>) => {
    applying = true;
    useLibrary.setState(data);
    applying = false;
  };
  return {
    publish: (data: LibraryData) => channel.postMessage(data),
    applying: () => applying,
    close: () => channel.close(),
  };
}

export function startLibrary() {
  if (useLibrary.getState().loaded) return;
  stop?.();
  try {
    useLibrary.setState({ ...readLibrary(readDocument("library.json")), loaded: true, error: null });
  } catch (error) {
    // Do not overwrite an unreadable document. The user can recover it instead of silently losing it.
    useLibrary.setState({ loaded: true, error: `Couldn't read Library: ${String(error)}` });
  }
  const windows = syncWindows();
  const unsubscribe = useLibrary.subscribe((s, prev) => {
    if (!s.loaded || !prev.loaded || windows?.applying()) return;
    if ((s.easels === prev.easels && s.media === prev.media && s.removedMediaPaths === prev.removedMediaPaths) || s.error) return;
    const data = libraryData(s);
    try {
      writeDocument("library.json", JSON.stringify(data));
      windows?.publish(data);
    } catch (error) {
      useLibrary.setState({ error: `Couldn't save Library: ${String(error)}` });
    }
  });
  stop = () => {
    unsubscribe();
    windows?.close();
  };
}

export function createEasel(spaceId: string, title = "Untitled Easel"): string | null {
  startLibrary();
  if (useLibrary.getState().error) return null;
  const id = newId("easel");
  const at = Date.now();
  const doc: EaselDocument = { id, title, spaceId, background: "#FFFFFF", items: [], createdAt: at, updatedAt: at };
  useLibrary.setState((s) => ({ easels: { ...s.easels, [id]: doc } }));
  return id;
}

export function updateEasel(id: string, patch: Partial<Pick<EaselDocument, "title" | "background" | "items">>, nativeEditId?: string) {
  const s = useLibrary.getState();
  const before = s.easels[id];
  if (!before || s.error) return false;
  if (
    patch.items &&
    JSON.stringify(patch.items) === JSON.stringify(before.items) &&
    (patch.background === undefined || patch.background === before.background) &&
    (patch.title === undefined || patch.title === before.title)
  )
    return true;
  const doc = parseEasel({ ...before, ...patch, updatedAt: Date.now(), nativeEditId });
  if (!doc) return false;
  useLibrary.setState({ easels: { ...s.easels, [id]: doc } });
  return true;
}

export function applyEaselDocument(id: string, json: string) {
  try {
    const doc = parseEasel(JSON.parse(json));
    if (!doc || doc.id !== id || !updateEasel(id, { items: doc.items, background: doc.background }, doc.nativeEditId)) return false;
    // Native paste/drop imports durable assets too. Make those images discoverable in Media.
    useLibrary.setState((s) => {
      const media = { ...s.media };
      const known = new Set([...Object.values(media).map((m) => m.path), ...s.removedMediaPaths]);
      let added = false;
      for (const item of doc.items) {
        if (item.kind !== "image" || !item.path || known.has(item.path) || item.width <= 0 || item.height <= 0) continue;
        const mediaId = newId("media");
        media[mediaId] = {
          id: mediaId,
          name: item.source?.title || fileNameOf(item.path) || "Image",
          path: item.path,
          width: item.width,
          height: item.height,
          createdAt: Date.now(),
          ...(item.source ? { source: item.source } : {}),
        };
        known.add(item.path);
        added = true;
      }
      return added ? { media } : s;
    });
    return true;
  } catch {
    return false;
  }
}

export function duplicateEasel(id: string): string | null {
  const source = useLibrary.getState().easels[id];
  if (!source) return null;
  const copy = createEasel(source.spaceId, `${source.title} Copy`);
  if (copy) updateEasel(copy, { background: source.background, items: source.items.map((i) => ({ ...i, id: newId("item") })) });
  return copy;
}

export function deleteEasel(id: string) {
  useLibrary.setState((s) => {
    if (s.error) return s;
    const easels = { ...s.easels };
    delete easels[id];
    return { easels };
  });
  // Assets can still be referenced by another Easel, Library media, or native undo. Keep them for recovery.
}

export async function saveLibraryMedia(image: { path: string; width: number; height: number }, name: string, source?: CaptureSource) {
  startLibrary();
  if (useLibrary.getState().error) return null;
  const retained = await retainLibraryImage(image.path);
  if (!retained || useLibrary.getState().error) return null;
  const id = newId("media");
  const media: LibraryMedia = { id, name, ...retained, createdAt: Date.now(), ...(source ? { source } : {}) };
  useLibrary.setState((s) => ({ media: { ...s.media, [id]: media } }));
  return media;
}

export function removeLibraryMedia(id: string) {
  useLibrary.setState((s) => {
    if (s.error) return s;
    const media = { ...s.media };
    const path = media[id]?.path;
    delete media[id];
    return { media, removedMediaPaths: path ? [...new Set([...s.removedMediaPaths, path])] : s.removedMediaPaths };
  });
}

export function addMediaToEasel(easelId: string, media: LibraryMedia) {
  const doc = useLibrary.getState().easels[easelId];
  if (!doc) return false;
  return updateEasel(easelId, { items: [...doc.items, mediaItem(media, doc.items, newId("item"))] });
}
