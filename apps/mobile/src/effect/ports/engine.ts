// The page engine: the native contract the app's pages run on. It stays Promise-based and Effect-free, so this port
// is the only place that knows about it, and a later change to the native engine touches this file alone. The module
// is loaded inside the calls, because it asks for a native module the moment it is imported.
import type { DownloadUpdate, MediaControl, Tab, TrackingParameters } from "@bay/engine";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import { TaggedError } from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Operation } from "../errors.ts";
import { Diagnostics } from "./diagnostics.ts";

/** The engine's own module, loaded when it is first needed. */
type EngineModule = typeof import("@bay/engine");

/** How long a page script has to answer before the wait ends. */
export const PAGE_SCRIPT_TIMEOUT = 10_000;

/** A native call that could not be made, or that failed. */
export class EngineError extends TaggedError("EngineError")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The page did not answer in time. The script itself kept running: it cannot be stopped. */
export class PageScriptTimeout extends TaggedError("PageScriptTimeout")<{
  readonly operation: Operation;
}> {}

/** The page answered with something the app could not read. */
export class PageScriptFailed extends TaggedError("PageScriptFailed")<{
  readonly operation: Operation;
  readonly cause: unknown;
}> {}

/** The engine's module, loaded when it is first needed. */
const engineModule = Effect.tryPromise({
  try: () => import("@bay/engine"),
  catch: (cause) => new EngineError({ operation: { name: "engine.load" }, cause }),
});

export class Engine extends Context.Service<
  Engine,
  {
    /** Runs a script in a page and reads its answer. The script has ten seconds to answer. */
    readonly runPageScript: <A>(tab: Tab, script: string, timeoutMs?: number) => Effect.Effect<A, PageScriptTimeout | PageScriptFailed>;
    /** Takes a picture of the page, or null before it has a drawable viewport. */
    readonly snapshot: (tab: Tab) => Effect.Effect<string | null, EngineError>;
    /** Saves the page's history, scroll position and form text now. */
    readonly saveState: (tab: Tab) => Effect.Effect<void, EngineError>;
    /** Clears cookies, website storage, the network cache and the tab snapshots. */
    readonly clearData: () => Effect.Effect<void, EngineError>;
    /** Says whether a private tab is open, so the private session starts or ends. */
    readonly setPrivateSessionActive: (active: boolean) => Effect.Effect<void, EngineError>;
    /** Deletes the snapshots that aren't in `keep`. */
    readonly pruneSnapshots: (keep: readonly string[]) => Effect.Effect<void, EngineError>;
    /** Deletes the saved page states whose tabs aren't in `keep`. */
    readonly pruneTabStates: (keep: readonly string[]) => Effect.Effect<void, EngineError>;
    /** Blocks with filter list files, or stops blocking with null. */
    readonly setContentBlocking: (files: readonly string[] | null, version: string) => Effect.Effect<void, EngineError>;
    /** Says where blocking is paused. */
    readonly setBlockingPausedHosts: (hosts: readonly string[]) => Effect.Effect<void, EngineError>;
    /** Gives the engine the table of tracking parameters to strip. */
    readonly setTrackingParameters: (table: TrackingParameters) => Effect.Effect<void, EngineError>;
    /** Opens a finished download. The engine works out whether the platform opens it by its id or by its file. */
    readonly openDownload: (download: { readonly id: string; readonly path?: string }) => Effect.Effect<void, EngineError>;
    /** Stops a download that is still running. */
    readonly cancelDownload: (id: string) => Effect.Effect<void, EngineError>;
    /** Saves a web image into the photo library. */
    readonly saveImage: (url: string) => Effect.Effect<void, EngineError>;
    /** Listens once and reads what was said, or null when it wasn't heard. */
    readonly startListening: () => Effect.Effect<string | null, EngineError>;
    /** Calls `handler` for every download update. It stops when the scope that registered it closes. */
    readonly onDownload: (handler: (update: DownloadUpdate) => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Calls `handler` when the system's media controls ask for something. It stops when the scope closes. */
    readonly onMediaControl: (handler: (action: MediaControl) => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Calls `handler` when another app hands Bay a link to share. It stops when the scope closes. */
    readonly onShare: (handler: (url: string) => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Takes the share that started the app, if there was one. */
    readonly takeShare: () => Effect.Effect<string | null, EngineError>;
  }
>()("bay/Engine") {
  static readonly layer = Layer.effect(
    Engine,
    Effect.gen(function* () {
      const diagnostics = yield* Diagnostics;

      /**
       * The engine, or nothing when it could not be loaded. A missing native module is reported once and the app
       * carries on without the page engine, rather than taking the whole scope down with it.
       */
      const engineOrNothing = Effect.catchCause(engineModule, (cause) => {
        const failure = Cause.squash(cause);
        const error = failure instanceof Error ? failure : new Error(String(failure));

        return Effect.map(diagnostics.report({ operation: { name: "engine.load" }, message: error.message, cause: error }), () => undefined);
      });

      /** Runs one native call, naming it when it fails. */
      const call = <A>(operation: Operation, use: (engine: EngineModule) => Promise<A>) =>
        Effect.gen(function* () {
          const engine = yield* engineModule;

          return yield* Effect.tryPromise({
            try: () => use(engine),
            catch: (cause) => new EngineError({ operation, cause }),
          });
        });

      /** Registers a native listener, and takes it away again when the scope closes. */
      const listen = (name: string, attach: (engine: EngineModule) => { remove(): void }) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const engine = yield* engineOrNothing;

          if (!engine) return;

          const subscription = attach(engine);

          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => subscription.remove()),
          );
        });

      return Engine.of({
        runPageScript: <A>(tab: Tab, script: string, timeoutMs = PAGE_SCRIPT_TIMEOUT) =>
          Effect.gen(function* () {
            const answer = yield* Effect.tryPromise({
              try: () => tab.evaluate(script),
              catch: (cause) => new PageScriptFailed({ operation: { name: "engine.pageScript" }, cause }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.fail(new PageScriptTimeout({ operation: { name: "engine.pageScript" } })),
              }),
            );

            // SAFETY: the page answered with JSON text, so parsing it yields the caller's own type.
            return yield* Effect.try({
              try: () => JSON.parse(answer) as A,
              catch: (cause) => new PageScriptFailed({ operation: { name: "engine.pageScript" }, cause }),
            });
          }),
        snapshot: (tab) =>
          Effect.tryPromise({
            try: () => tab.snapshot(),
            catch: (cause) => new EngineError({ operation: { name: "engine.snapshot" }, cause }),
          }),
        saveState: (tab) =>
          Effect.tryPromise({
            try: () => tab.saveState(),
            catch: (cause) => new EngineError({ operation: { name: "engine.saveState" }, cause }),
          }),
        clearData: () => call({ name: "engine.clearData" }, (engine) => engine.clearData()),
        setPrivateSessionActive: (active) => call({ name: "engine.setPrivateSessionActive" }, (engine) => engine.setPrivateSessionActive(active)),
        pruneSnapshots: (keep) => call({ name: "engine.pruneSnapshots" }, (engine) => engine.pruneSnapshots(keep)),
        pruneTabStates: (keep) => call({ name: "engine.pruneTabStates" }, (engine) => engine.pruneTabStates(keep)),
        setContentBlocking: (files, version) => call({ name: "engine.setContentBlocking" }, (engine) => engine.setContentBlocking(files, version)),
        setBlockingPausedHosts: (hosts) =>
          Effect.gen(function* () {
            const engine = yield* engineModule;

            yield* Effect.try({
              try: () => engine.setBlockingPausedHosts(hosts),
              catch: (cause) => new EngineError({ operation: { name: "engine.setBlockingPausedHosts" }, cause }),
            });
          }),
        setTrackingParameters: (table) =>
          Effect.gen(function* () {
            const engine = yield* engineModule;

            yield* Effect.try({
              try: () => engine.setTrackingParameters(table),
              catch: (cause) => new EngineError({ operation: { name: "engine.setTrackingParameters" }, cause }),
            });
          }),
        openDownload: (download) => call({ name: "engine.openDownload", resource: download.id }, (engine) => engine.openDownload(download)),
        cancelDownload: (id) => call({ name: "engine.cancelDownload", resource: id }, (engine) => engine.cancelDownload(id)),
        saveImage: (url) => call({ name: "engine.saveImage", resource: url }, (engine) => engine.saveImage(url)),
        startListening: () => call({ name: "engine.startListening" }, (engine) => engine.startListening()),
        onDownload: (handler) => listen("engine.onDownload", (engine) => engine.addDownloadListener(handler)),
        onMediaControl: (handler) => listen("engine.onMediaControl", (engine) => engine.addMediaControlListener(handler)),
        onShare: (handler) => listen("engine.onShare", (engine) => engine.addShareListener(handler)),
        takeShare: () => call({ name: "engine.takeShare" }, (engine) => engine.takeShare()),
      });
    }),
  );
}
