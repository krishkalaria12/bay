// The app's local files: where a Space's files live, and what this Mac may read of them.
//
// A file is opened by its pin: the native side resolves the path, and the tab that shows it is opened only when
// the pin and the window are still there. A path this Mac may not read keeps its own outcome: the app does not
// ask again, and the user does.
import { localFiles, type LocalFileAccess } from "@bay/desktop";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthorityStore } from "../effect/ports/store";

import { activeTabId } from "../store/model";

/** The native side could not answer about the file. */
export class LocalFileFailure extends TaggedError("LocalFileFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The native side of the local files, as the service reaches it. */
export class LocalFileEngine extends Context.Service<
  LocalFileEngine,
  {
    /** What this Mac may do with the path. */
    readonly inspect: (path: string, relativePath: string) => Effect.Effect<LocalFileAccess, LocalFileFailure>;
    /** Resolves the path for the browser to open. */
    readonly open: (path: string, relativePath: string) => Effect.Effect<LocalFileAccess, LocalFileFailure>;
    /** Saves a local alias under the synced path again. */
    readonly reconnect: (path: string, kind: "file" | "folder") => Effect.Effect<boolean, LocalFileFailure>;
  }
>()("bay/LocalFileEngine") {
  static readonly layer = Layer.succeed(LocalFileEngine)({
    inspect: (path, relativePath) =>
      Effect.tryPromise({
        try: () => localFiles.inspect(path, relativePath),
        catch: (cause) => new LocalFileFailure({ operation: "localFile.inspect", cause }),
      }),
    open: (path, relativePath) =>
      Effect.tryPromise({
        try: () => localFiles.open(path, relativePath),
        catch: (cause) => new LocalFileFailure({ operation: "localFile.open", cause }),
      }),
    reconnect: (path, kind) =>
      Effect.tryPromise({
        try: async () => !!(await localFiles.reconnect(path, kind)),
        catch: (cause) => new LocalFileFailure({ operation: "localFile.reconnect", cause }),
      }),
  });
}

export class LocalFileService extends Context.Service<
  LocalFileService,
  {
    /** Opens the file in a tab of the window, when this Mac may read it. */
    readonly open: (windowId: string, pinId: string, relativePath?: string) => Effect.Effect<LocalFileAccess>;
    /** Shows the file beside the window's page, when this Mac may read it. */
    readonly peek: (windowId: string, pinId: string, relativePath?: string) => Effect.Effect<LocalFileAccess>;
    /** Saves a local alias under the synced path again. */
    readonly reconnect: (pinId: string) => Effect.Effect<boolean>;
    /** Closes the pages that show a file's descendants. */
    readonly close: (windowId: string, pinId: string, relativePath: string) => Effect.Effect<void>;
  }
>()("bay/LocalFileService") {
  static readonly layer = Layer.effect(
    LocalFileService,
    Effect.gen(function* () {
      const browser = yield* AuthorityStore;
      const engine = yield* LocalFileEngine;

      // A file this Mac may not read keeps this outcome: the app does not ask again.
      const inaccessible: LocalFileAccess = { status: "inaccessible" };

      const open = (windowId: string, pinId: string, relativePath = ""): Effect.Effect<LocalFileAccess> =>
        Effect.gen(function* () {
          const s = browser.getState();
          const pin = s.localFiles[pinId];
          const w = s.windows[windowId];

          if (!pin || !w || w.incognito || !s.spaces[pin.spaceId]) return yield* Effect.succeed(inaccessible);

          const access = yield* engine.open(pin.path, relativePath).pipe(Effect.catch(() => Effect.succeed(inaccessible)));
          const next = browser.getState();

          if (access.status !== "available" || !access.browserReadable || !access.url?.startsWith("file://")) {
            return yield* Effect.succeed(access);
          }

          // A tab must not appear after its pin or window was removed while native resolution was pending.
          if (next.localFiles[pinId]?.path !== pin.path || !next.windows[windowId] || !next.spaces[pin.spaceId]) {
            return yield* Effect.succeed(inaccessible);
          }

          const existing = Object.values(next.tabs).find((tab) => tab.spaceId === pin.spaceId && tab.url === access.url && !tab.peekOf);

          if (existing) next.activate(existing.id, windowId);
          else {
            const id = next.newTab(windowId, { url: access.url, spaceId: pin.spaceId });

            browser.getState().updateTab(id, { customTitle: relativePath ? (access.name ?? pin.name) : pin.name });
          }

          return yield* Effect.succeed(access);
        });

      const peek = (windowId: string, pinId: string, relativePath = ""): Effect.Effect<LocalFileAccess> =>
        Effect.gen(function* () {
          const pin = browser.getState().localFiles[pinId];

          if (!pin) return yield* Effect.succeed(inaccessible);

          const access = yield* engine.inspect(pin.path, relativePath).pipe(Effect.catch(() => Effect.succeed(inaccessible)));
          const s = browser.getState();

          if (s.localFiles[pinId]?.path !== pin.path || !s.windows[windowId] || s.windows[windowId]!.incognito) {
            return yield* Effect.succeed(inaccessible);
          }

          if (access.status !== "available") return yield* Effect.succeed(access);

          const from = activeTabId(s, windowId);

          if (from && access.browserReadable && access.url?.startsWith("file://")) {
            // Shared-space tabs can still be hosted by another window. The peek belongs to this window's page.
            if (s.tabs[from]?.windowId !== windowId) s.activate(from, windowId);
            browser.getState().openPeek(from, access.url);

            return yield* Effect.succeed(access);
          }

          return yield* open(windowId, pinId, relativePath);
        });

      const reconnect = (pinId: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const pin = browser.getState().localFiles[pinId];

          if (!pin) return yield* Effect.succeed(false);

          // Native saves an alias under the original synced path. Reconnection is local to this Mac.
          return yield* engine.reconnect(pin.path, pin.kind).pipe(Effect.catch(() => Effect.succeed(false)));
        });

      const close = (windowId: string, pinId: string, relativePath: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const pin = browser.getState().localFiles[pinId];

          if (!pin) return;

          const access = yield* engine.inspect(pin.path, relativePath).pipe(Effect.catch(() => Effect.succeed(inaccessible)));
          const s = browser.getState();

          if (s.localFiles[pinId]?.path !== pin.path || !s.windows[windowId] || !access.url) return;

          for (const tab of Object.values(s.tabs)) if (tab.spaceId === pin.spaceId && tab.url === access.url) s.closeTab(tab.id);
        });

      return LocalFileService.of({ open, peek, reconnect, close });
    }),
  );
}
