// The Library: the Easels and the media this Mac keeps.
//
// The library is a document: it is read at the launch, and every change is written back. The write is the
// service's work, so an unreadable document is kept for the user to recover rather than overwritten.
import { readDocument, retainLibraryImage, writeDocument } from "@bay/desktop";
import { create } from "zustand";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { newId } from "../../store/model";
import { readLibrary as readLibraryDocument, type CaptureSource, type LibraryData, type LibraryMedia } from "./model";

/** The library could not be read or written. */
export class LibraryFailure extends TaggedError("LibraryFailure")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

export type LibraryState = LibraryData & { loaded: boolean; error: string | null };

export const useLibrary = create<LibraryState>()(() => ({ version: 1, easels: {}, media: {}, removedMediaPaths: [], loaded: false, error: null }));

/** The library's document, as the app keeps it. */
export class LibraryEngine extends Context.Service<
  LibraryEngine,
  {
    readonly read: () => LibraryData;
    readonly write: (data: LibraryData) => void;
    /** Keeps a copy of an image, so the library owns it. */
    readonly retain: (path: string) => Effect.Effect<{ path: string; width: number; height: number } | null, LibraryFailure>;
  }
>()("bay/LibraryEngine") {
  static readonly layer = Layer.succeed(LibraryEngine)({
    read: () => readLibraryDocument(readDocument("library.json")),
    write: (data) =>
      writeDocument("library.json", JSON.stringify({ version: 1, easels: data.easels, media: data.media, removedMediaPaths: data.removedMediaPaths })),
    retain: (path) =>
      Effect.tryPromise({
        try: () => retainLibraryImage(path),
        catch: (cause) => new LibraryFailure({ operation: "library.retain", message: String(cause), cause }),
      }),
  });
}

/** Reads the library's document. The launch shows it at once, before anything else. */
export const readLibrary = (): void => {
  if (useLibrary.getState().loaded) return;

  try {
    useLibrary.setState({ ...readLibraryDocument(readDocument("library.json")), loaded: true, error: null });
  } catch (error) {
    // Do not overwrite an unreadable document. The user can recover it instead of silently losing it.
    useLibrary.setState({ loaded: true, error: `Couldn't read Library: ${String(error)}` });
  }
};

export class LibraryService extends Context.Service<
  LibraryService,
  {
    /** Reads the library, and writes it back after every change. */
    readonly start: Effect.Effect<void>;
    /** Keeps a copy of an image, and adds it to the library. */
    readonly saveMedia: (
      image: { path: string; width: number; height: number },
      name: string,
      source?: CaptureSource,
    ) => Effect.Effect<LibraryMedia | null, LibraryFailure>;
  }
>()("bay/LibraryService") {
  static readonly layer = Layer.effect(
    LibraryService,
    Effect.gen(function* () {
      const engine = yield* LibraryEngine;

      let stop: (() => void) | undefined;

      const start = Effect.sync(() => {
        if (stop) return;

        stop = useLibrary.subscribe((s, prev) => {
          if (!s.loaded || !prev.loaded) return;

          if ((s.easels === prev.easels && s.media === prev.media && s.removedMediaPaths === prev.removedMediaPaths) || s.error) return;

          try {
            engine.write(s);
          } catch (error) {
            useLibrary.setState({ error: `Couldn't save Library: ${String(error)}` });
          }
        });
      });

      const saveMedia = (
        image: { path: string; width: number; height: number },
        name: string,
        source?: CaptureSource,
      ): Effect.Effect<LibraryMedia | null, LibraryFailure> =>
        Effect.gen(function* () {
          yield* Effect.sync(readLibrary);

          if (useLibrary.getState().error) return yield* Effect.succeed(null);

          const retained = yield* engine.retain(image.path);

          if (!retained || useLibrary.getState().error) return yield* Effect.succeed(null);

          const id = newId("media");
          const media: LibraryMedia = { id, name, ...retained, createdAt: Date.now(), ...(source ? { source } : undefined) };

          yield* Effect.sync(() => useLibrary.setState((s) => ({ media: { ...s.media, [id]: media } })));

          return yield* Effect.succeed(media);
        });

      return LibraryService.of({ start, saveMedia });
    }),
  );
}
