// The Library: the Easels and the media this Mac keeps.
//
// The work is in components/library/libraryService.ts. This is where the app reaches it.
import type { CaptureSource } from "./model";
import * as Effect from "effect/Effect";
import { runDesktop } from "../../effect/runtime";
import { LibraryService, readLibrary, useLibrary } from "./libraryService";
import { fileNameOf, mediaItem, parseEasel, type EaselDocument, type LibraryMedia } from "./model";
import { newId } from "../../store/model";

export { useLibrary };

/** Reads the library, and writes it back after every change. */
export function startLibrary() {
  // The library shows at once: the document is read before the app draws anything.
  readLibrary();

  void runDesktop(
    Effect.gen(function* () {
      const library = yield* LibraryService;

      yield* library.start;
    }),
  );
}

/** Keeps a copy of an image, and adds it to the library. */
export function saveLibraryMedia(image: { path: string; width: number; height: number }, name: string, source?: CaptureSource): Promise<LibraryMedia | null> {
  return runDesktop(
    Effect.gen(function* () {
      const library = yield* LibraryService;

      return yield* library.saveMedia(image, name, source);
    }),
  );
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
          ...(item.source ? { source: item.source } : undefined),
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
